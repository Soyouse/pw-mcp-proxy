// Prouve le lock single-instance COOPERATIF (lock.js) : quand un proxy #2 demarre avec la MEME
// config, le proxy #1 (ancien) ABDIQUE tout seul (self-exit) — sans que personne ne le tue.
// C'est le fix racine de l'accumulation de proxys "abandonnes-vivants" (cause reproduite 2026-07-10).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-backend.js');

let cfgPath;
const procs = [];

function startProxy(tag) {
  const p = spawn(process.execPath, [INDEX], {
    env: { ...process.env, PW_MCP_PROFILES: cfgPath, PW_MCP_LOG: path.join(os.tmpdir(), `pw-mcp-single-${process.pid}-${tag}.log`) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  p._exited = false;
  p.on('exit', () => { p._exited = true; });
  procs.push(p);
  return p;
}
async function initProxy(p) {
  // envoie initialize + initialized pour que le proxy soit pleinement "en service" (lock acquis au boot)
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
}
async function waitFor(pred, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

before(() => {
  cfgPath = path.join(os.tmpdir(), `pw-mcp-single-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    defaultProfile: 'vegeta',
    backend: { command: process.execPath, args: [FAKE] },
    profiles: { vegeta: { args: ['--tag', 'A'], label: 'Agence' } },
  }));
});
after(() => {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { fs.unlinkSync(cfgPath); } catch {}
});

test('lock single-instance : proxy #1 abdique (self-exit) quand proxy #2 demarre avec la meme config', async () => {
  const p1 = startProxy('1');
  await initProxy(p1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p1._exited, false, 'proxy #1 tourne apres son propre boot');

  // proxy #2 demarre : il reecrit le lock avec SON pid -> #1 doit le voir et abdiquer seul.
  const p2 = startProxy('2');
  await initProxy(p2);

  const p1Gone = await waitFor(() => p1._exited, 6000);
  assert.equal(p1Gone, true, 'proxy #1 s est arrete TOUT SEUL apres le demarrage du #2 (abdication)');
  assert.equal(p2._exited, false, 'proxy #2 (le plus recent) reste en vie');
});

test('lock single-instance : le proxy survivant nettoie son lockfile a l arret', async () => {
  const p = startProxy('solo');
  await initProxy(p);
  await new Promise((r) => setTimeout(r, 300));
  // fermer stdin => arret gracieux (reader 'close') => release() supprime le lockfile s il est a lui
  p.stdin.end();
  const gone = await waitFor(() => p._exited, 4000);
  assert.equal(gone, true, 'le proxy s arrete a la fermeture du stdin');
});
