// Test ROUGE (TDD) du backlog MULTI-AGENT : plusieurs proxys (= plusieurs agents Claude)
// demarres avec la MEME config doivent COEXISTER et servir chacun leurs requetes.
//
// Avec l'archi historique (lock single-instance COOPERATIF, cf lock.js), un proxy neuf faisait
// ABDIQUER les anciens (self-exit) => l'agent #1 perdait le MCP des que l'agent #2 demarrait.
// C'etait VOULU (fix P0 orphelins en stdio mono-client) mais ca INTERDIT le multi-agent.
//
// La cible (backend @playwright/mcp en serveur HTTP partage) supprime l'abdication : N proxys
// coexistent, chacun client legitime du serveur partage. Ce test scelle le bug pour toujours.
//
// Le fake-backend stdio ISOLE la regression : il n'a AUCUN lock de ressource (pas de Chrome,
// pas de --user-data-dir). Le SEUL obstacle a la coexistence est donc l'abdication du lock =>
// si les deux proxys survivent et repondent, c'est que le multi-agent est acquis.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnTracked } from './harness.js'; // ⚠️ spawn tracké + ratchet anti-fuite (JAMAIS child_process.spawn nu)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-backend.js');

let cfgPath;
const agents = [];

// Un "agent" = un proxy stdio pilote comme le ferait Claude Code (une session MCP a lui).
function startAgent(tag) {
  const proc = spawnTracked([INDEX], {
    env: {
      ...process.env,
      PW_MCP_PROFILES: cfgPath,
      PW_MCP_LOG: path.join(os.tmpdir(), `pw-mcp-multi-${process.pid}-${tag}.log`),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const a = { proc, tag, buf: '', pending: new Map(), idc: 0, exited: false };
  proc.on('exit', () => { a.exited = true; });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    a.buf += chunk;
    let i;
    while ((i = a.buf.indexOf('\n')) !== -1) {
      const line = a.buf.slice(0, i).trim();
      a.buf = a.buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && m.method === undefined) {
        const p = a.pending.get(m.id);
        if (p) { a.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      } else if (m.id !== undefined && m.method) {
        // requete server->client : on repond a minima pour ne pas bloquer
        a.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [] } }) + '\n');
      }
    }
  });
  agents.push(a);
  return a;
}

function req(a, method, params) {
  const id = ++a.idc;
  return new Promise((resolve, reject) => {
    // Timeout DUR : si le proxy est mort (abdication), l'ecriture part dans le vide et la reponse
    // n'arrive jamais => sans ce garde, le test PENDRAIT au lieu d'echouer proprement (bloque la CI).
    const to = setTimeout(() => { a.pending.delete(id); reject(new Error(`timeout ${method} (proxy ${a.tag} muet)`)); }, 5000);
    a.pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
    try { a.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { clearTimeout(to); a.pending.delete(id); reject(e); }
  });
}

async function handshake(a) {
  const res = await req(a, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `agent-${a.tag}`, version: '1' },
  });
  a.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return res;
}

async function waitFor(pred, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}

before(() => {
  cfgPath = path.join(os.tmpdir(), `pw-mcp-multi-${process.pid}.json`);
  // Profil SANS userDataDir => aucun boot-sweep, aucun lock ressource : on teste UNIQUEMENT
  // la coexistence des proxys entre eux (pas la contention navigateur, testee ailleurs).
  fs.writeFileSync(cfgPath, JSON.stringify({
    defaultProfile: 'vegeta',
    backend: { command: process.execPath, args: [FAKE] },
    profiles: { vegeta: { args: ['--tag', 'A'], label: 'Agence' } },
  }));
});

after(() => {
  // Proxys tués + vérifiés par le harnais (spawnTracked -> ratchet). Ici : seulement le fichier temp.
  try { fs.unlinkSync(cfgPath); } catch {}
});

test('multi-agent : 2 proxys (meme config) coexistent, aucun ne fait abdiquer l autre', async () => {
  const a1 = startAgent('1');
  await handshake(a1);
  assert.equal(a1.exited, false, 'agent #1 en service apres son boot');

  // L'agent #2 demarre (comme une 2e session Claude). Il ne DOIT PAS tuer l'agent #1.
  const a2 = startAgent('2');
  await handshake(a2);

  // Laisse le temps a un eventuel mecanisme d'abdication (lock watchFile interval=1000ms) d'agir.
  const abdicated = await waitFor(() => a1.exited, 3500);
  assert.equal(abdicated, false, 'agent #1 NE DOIT PAS s arreter quand agent #2 demarre (multi-agent)');
  assert.equal(a2.exited, false, 'agent #2 en service');
});

test('multi-agent : les DEUX proxys servent leurs requetes en parallele', async () => {
  const [a1, a2] = agents;
  // Les deux repondent a tools/call sur le meme profil, chacun via SA session.
  const [r1, r2] = await Promise.all([
    req(a1, 'tools/call', { name: 'echo_A', arguments: { v: 'un' } }),
    req(a2, 'tools/call', { name: 'echo_A', arguments: { v: 'deux' } }),
  ]);
  assert.equal(r1.content[0].text, 'A:un', 'agent #1 sert sa requete');
  assert.equal(r2.content[0].text, 'A:deux', 'agent #2 sert sa requete');

  // tools/list marche pour les deux (switch_profile injecte de part et d autre).
  const [l1, l2] = await Promise.all([req(a1, 'tools/list', {}), req(a2, 'tools/list', {})]);
  assert.ok(l1.tools.map((t) => t.name).includes('switch_profile'));
  assert.ok(l2.tools.map((t) => t.name).includes('switch_profile'));
});
