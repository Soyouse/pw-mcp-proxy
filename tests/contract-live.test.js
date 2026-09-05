// Contract / drift-test LIVE contre le VRAI `@playwright/mcp` — UNE INSTANCE PAR CLIENT (05/09/2026).
// Preuve de bout en bout : le daemon (code de CE dépôt, sur un canal de test) spawne le vrai serveur
// `--port`, HttpTransport parle le contrat Streamable HTTP réel, deux « agents » obtiennent DEUX
// instances et ne se volent JAMAIS la page. Sert aussi de DRIFT-TEST : si une update `@playwright/mcp`
// change la forme du handshake/transport, le heartbeat, la détectabilité d'un contexte isolé ou les
// outils d'identité, ce test devient ROUGE en nightly AVANT tout déploiement.
//
// ⚠️ NE TOURNE QUE si PW_MCP_LIVE=1 (télécharge/lance un vrai Chrome => hors CI par défaut, cf
// doctrine « GitHub = bonus »). Lancer : PW_MCP_LIVE=1 npx vitest run tests/contract-live.test.js
// Version PINNÉE volontairement (PW_MCP_VERSION) : on ne teste pas un `@latest` mouvant à l'aveugle.
// ⚠️ CANAL DE TEST (env injecté) : ce fichier lance SON daemon, jamais celui de l'opérateur — un
// daemon vivant porte l'ancien code jusqu'à sa sortie, et on ne mesure pas un binaire à travers lui.
// ⚠️ La SENTINELLE de détectabilité tourne en FENÊTRE VISIBLE (posture de prod) : sous Linux sans
// écran, le workflow l'enveloppe dans `xvfb-run` (comme le nœud VPS).

import { test, beforeAll, afterAll, expect } from 'vitest';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Backend } from '../src/backend.js';
import { HttpTransport } from '../src/http-transport.js';
import { Manager } from '../src/manager.js';
import { buildSpec } from '../src/spec.js';
import { acquerirProfil } from '../src/daemon-client.js';
import { treeKill, isPidAlive, listProcesses } from '../src/prockill.js';

const LIVE = process.env.PW_MCP_LIVE === '1';
const VERSION = process.env.PW_MCP_VERSION || '0.0.80'; // PIN : aligner sur profiles.example.json
const CLIENT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract', version: '1' } };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DETECTEUR = path.join(__dirname, 'fixtures', 'detect-incognito-1.9.0.js'); // detectincognitojs@1.9.0, MIT, ÉPINGLÉ

// Canal UNIQUE pour ce fichier : son daemon, ses serveurs, jamais ceux de l'opérateur.
const ENV = { platform: process.platform, tmpdir: os.tmpdir(), userInfo: { username: `live${process.pid}` } };
const BACKEND = { command: 'npx', args: ['-y', `@playwright/mcp@${VERSION}`] };

const connexions = []; // ⚠️ CHAQUE socket ouverte = une instance vivante : la garder, la fermer = ranger l'instance
const dirs = [];
let site; // mini-site local : un cookie, une page-sonde, deux pages témoins (jamais data:, jamais file:)
let origin;

// `PW_MCP_BIND_HOST` (optionnel) : rejouer ce fichier sur une adresse HORS loopback (carte dédiée) pour
// mesurer la sortie de la classe libuv `uv__is_loopback` (Windows). Défaut = localhost, comme le produit.
const BIND_HOST = process.env.PW_MCP_BIND_HOST || undefined;

/** Obtient UNE INSTANCE (serveur + Chrome) pour un profil — ce que fait `manager._makeTransport`. */
async function instancePour(profil, spec, instance = null) {
  const r = await acquerirProfil(profil, spec, ENV, { instance, bindHost: BIND_HOST });
  connexions.push(r.connexion);
  return r;
}

/** Le pid du serveur derrière une URL — observé sur le PROCESS, jamais lu dans un fichier d'état. */
function pidDeLUrl(url) {
  const port = new URL(url).port;
  return listProcesses().find((p) => p.cmd.includes(`--port ${port}`))?.pid;
}

/** Le port répond-il ? Sur l'hôte LIÉ (`localhost` par défaut — jamais `127.0.0.1` : Host header ⇒ 403). */
function repond(port) {
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), BIND_HOST || 'localhost');
    const fin = (v) => { sock.destroy(); resolve(v); };
    sock.on('connect', () => fin(true));
    sock.on('error', () => fin(false));
  });
}

/** Observe un FAIT du disque/noyau jusqu'à ce qu'il soit vrai, borné (jamais un délai « pour laisser le temps »). */
async function jusqua(pred, budgetMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Un Backend qui RÉPOND aux `ping` du serveur (comme le fait le routeur en prod via Claude) : la 0.0.80 a
// un heartbeat HTTP de 5 s — un client muet voit sa session fermée dès qu'une action dépasse 5 s.
function backendQuiRepond(nom, url, spec, options = {}) {
  const b = new Backend(nom, new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }), options);
  b.on('backendRequest', (m) => { if (m.method === 'ping') b.respondToBackend(m.id, { jsonrpc: '2.0', id: m.id, result: {} }); });
  return b;
}
const call = (b, name, args = {}) => b.request('tools/call', { name, arguments: args });
const texte = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
const tmp = (nom) => { const d = path.join(os.tmpdir(), `pw-mcp-live-${process.pid}-${nom}`); dirs.push(d); return d; };

beforeAll(async () => {
  if (!LIVE) return;
  const detecteur = fs.readFileSync(DETECTEUR);
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/detect.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(detecteur); }
    if (u.pathname === '/sonde') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>SONDE</title><h1>SONDE</h1><script src="/detect.js"></script>'); }
    const t = u.pathname === '/a' ? 'PAGE-ALPHA' : u.pathname === '/b' ? 'PAGE-BRAVO' : 'PAGE-AUTRE';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  site.on('connection', (s) => s.on('error', () => {}));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  origin = `http://localhost:${site.address().port}`;
});

afterAll(async () => {
  if (!LIVE) return;
  // Rendre toutes les instances : le daemon range et sort SEUL (plus aucun client).
  for (const c of connexions.splice(0)) { try { c.destroy(); } catch {} }
  await new Promise((r) => site.close(r));
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ═══ S2 RÉÉCRIT — deux agents, deux instances, jamais le même onglet ══════════════════════════
test.skipIf(!LIVE)('LIVE S2 : 2 agents sur le MÊME profil => 2 serveurs, 2 pids, pages INDÉPENDANTES ; browser_navigate + outils d identité exposés', async () => {
  const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: BACKEND }, {});
  const A = await instancePour('anon', spec);
  const B = await instancePour('anon', spec);
  expect(A.url).toMatch(new RegExp(`^http://${(BIND_HOST || 'localhost').replace(/\./g, '\\.')}:\\d+/mcp$`));
  expect(B.url, 'deux URLs').not.toBe(A.url);
  expect(B.instanceId).not.toBe(A.instanceId);
  expect(pidDeLUrl(B.url), 'deux serveurs').not.toBe(pidDeLUrl(A.url));

  const a = backendQuiRepond('anon', A.url, spec);
  const b = backendQuiRepond('anon', B.url, spec);
  expect((await a.start(CLIENT))?.serverInfo, 'handshake initialize réel OK').toBeTruthy();
  await b.start(CLIENT);
  const names = ((await a.request('tools/list', {})).tools || []).map((t) => t.name);
  expect(names.includes('browser_navigate'), 'le vrai backend expose browser_navigate (passthrough)').toBeTruthy();
  expect(names.includes('browser_storage_state') && names.includes('browser_set_storage_state'), 'outils d identité présents (caps=storage TOUJOURS)').toBeTruthy();

  // La mesure du 04/09/2026, rendue PERMANENTE : B navigue, A n'a pas bougé.
  await call(a, 'browser_navigate', { url: `${origin}/a` });
  await call(b, 'browser_navigate', { url: `${origin}/b` });
  expect(texte(await call(a, 'browser_snapshot')), 'A voit SA page après la navigation de B').toContain('PAGE-ALPHA');
  expect(texte(await call(b, 'browser_snapshot'))).toContain('PAGE-BRAVO');
  a.stop(); b.stop();
}, 180000);

test.skipIf(!LIVE)('LIVE : le VRAI @playwright/mcp répond au `ping` MCP (fondation du watchdog de liveness)', async () => {
  const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: BACKEND }, {});
  const { url } = await instancePour('anon', spec);
  const a = backendQuiRepond('anon', url, spec);
  await a.start(CLIENT);
  expect(await a.request('ping', {}), 'le vrai backend DOIT répondre {} au ping (contrat MCP) — sans ça, le watchdog est aveugle').toEqual({});
  a.stop();
}, 120000);

// ═══ IDENTITÉ v2 — matérialiser, servir, RANGER (le cycle complet sur le vrai binaire) ═══════
test.skipIf(!LIVE)('LIVE identité : 2 instances d une identité => 2 dossiers, pages indépendantes ; au départ => snapshot dans le coffre, instances supprimées', async () => {
  const storeDir = tmp('coffre');
  const instancesDir = tmp('instances');
  const instance = { identite: 'live', strategie: 'snapshot', persist: true, storeDir, instancesDir, plafonds: {} };
  const spec = buildSpec('live', { identity: 'live', args: ['--headless'], backend: BACKEND }, {});
  const A = await instancePour('live', spec, instance);
  const B = await instancePour('live', spec, instance);
  expect(fs.existsSync(path.join(instancesDir, A.instanceId)), 'dossier d instance A matérialisé').toBe(true);
  expect(fs.existsSync(path.join(instancesDir, B.instanceId)), 'dossier d instance B matérialisé').toBe(true);

  const a = backendQuiRepond('live', A.url, spec);
  const b = backendQuiRepond('live', B.url, spec);
  await a.start(CLIENT); await b.start(CLIENT);
  await call(a, 'browser_navigate', { url: `${origin}/a` });
  await call(b, 'browser_navigate', { url: `${origin}/b` });
  expect(texte(await call(a, 'browser_snapshot'))).toContain('PAGE-ALPHA');
  a.stop(); b.stop();

  // Départ des deux clients : le daemon tue, attend l'exit, range (snapshot), supprime.
  for (const c of connexions.splice(0)) c.destroy();
  expect(await jusqua(() => !fs.existsSync(path.join(instancesDir, A.instanceId)) && !fs.existsSync(path.join(instancesDir, B.instanceId))), 'les deux dossiers d instance ont disparu').toBe(true);
  expect(fs.existsSync(path.join(storeDir, 'live', 'Default')), 'l identité est dans le coffre (profil Chrome rangé)').toBe(true);
  expect(fs.existsSync(path.join(storeDir, 'live', 'Default', 'Cache')), 'sans ses caches').toBe(false);
}, 240000);

// ═══ HEARTBEAT 0.0.80 — une action longue survit SI le client répond aux ping ═════════════════
test.skipIf(!LIVE)('LIVE heartbeat : une action > 5 s survit quand le client répond aux ping ; elle MEURT quand il se tait (negative-check)', async () => {
  const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: BACKEND }, {});
  const A = await instancePour('anon', spec);
  const a = backendQuiRepond('anon', A.url, spec);
  await a.start(CLIENT);
  await call(a, 'browser_navigate', { url: `${origin}/a` });
  const r = await call(a, 'browser_wait_for', { time: 8 });
  expect(r?.isError, 'une attente de 8 s revient sans erreur : le heartbeat est honoré').not.toBe(true);
  a.stop();

  // NEGATIVE-CHECK : un client MUET (aucune réponse aux ping) voit sa session FERMÉE par le serveur
  // pendant l'action ; la requête en vol n'est JAMAIS répondue (mesuré 05/09/2026 : elle PEND, le
  // serveur ne renvoie ni erreur ni résultat — le 404 n'arrive qu'à la requête SUIVANTE). C'est ce
  // qui prouve que le heartbeat EXISTE et que répondre aux ping n'est pas optionnel : la même
  // attente de 8 s revient en ~8 s chez le client qui répond, et n'est toujours pas revenue à 15 s
  // chez celui qui se tait.
  const B = await instancePour('anon', spec);
  const muet = new Backend('anon', new HttpTransport(B.url, { protocolVersion: CLIENT.protocolVersion, spec }));
  await muet.start(CLIENT);
  await call(muet, 'browser_navigate', { url: `${origin}/a` });
  let issue = 'pend';
  await Promise.race([
    call(muet, 'browser_wait_for', { time: 8 }).then(() => { issue = 'revenue'; }).catch(() => { issue = 'revenue'; }),
    new Promise((r2) => setTimeout(r2, 15000)),
  ]);
  expect(issue, 'client muet : la session est coupée par le heartbeat, la requête en vol ne revient pas (un client qui répond a eu son résultat en ~8 s)').toBe('pend');
  muet.stop();
}, 180000);

// ═══ SENTINELLE DÉTECTABILITÉ — la raison pour laquelle le swarm n utilise PAS --isolated ═════
// Mesuré le 04/09/2026 : detectincognitojs (timing d'écritures IndexedDB `durability:'strict'`) voit
// un contexte isolé comme PRIVÉ et un profil persistant comme normal. Le jour où Chrome/Playwright
// change ça, ce test rougit AVANT le déploiement — dans les DEUX sens (un isolé devenu « normal »
// serait une opportunité à réexaminer, un persistant devenu « privé » une régression de posture).
test.skipIf(!LIVE)('LIVE sentinelle : --isolated = PRIVÉ pour detectincognitojs 1.9.0, --user-data-dir = normal (fenêtre visible, posture de prod)', async () => {
  const sonde = async (nom, profil) => {
    const spec = buildSpec(nom, { ...profil, backend: BACKEND }, {});
    const { url } = await instancePour(nom, spec);
    const b = backendQuiRepond(nom, url, spec);
    await b.start(CLIENT);
    await call(b, 'browser_navigate', { url: `${origin}/sonde` });
    const r = await call(b, 'browser_evaluate', { function: 'async () => { const r = await window.detectIncognito(); return (r.isPrivate ? "PRIVE" : "NORMAL") + " (" + r.browserName + ")"; }' });
    b.stop();
    return texte(r);
  };
  const isole = await sonde('iso', { isolated: true });
  const persistant = await sonde('per', { userDataDir: tmp('udd-sonde') });
  expect(isole, 'contexte isolé DÉTECTÉ comme navigation privée').toContain('PRIVE');
  expect(persistant, 'profil persistant NON détecté').toContain('NORMAL');
}, 240000);

// ═══ Résilience (inchangée dans son intention, adaptée à une instance par client) ════════════
test.skipIf(!LIVE)('LIVE : MORT de Chrome sous serveur VIVANT => l action REVIENT (jamais un pend) + node survit + ping/probe AVEUGLES', async () => {
  const dir = tmp('bkill');
  const spec = buildSpec('cd', { userDataDir: dir, args: ['--headless'], backend: BACKEND }, {});
  const needle = path.basename(dir);
  const { url } = await instancePour('cd', spec);
  const serverPid = pidDeLUrl(url);
  const port = new URL(url).port;
  const a = backendQuiRepond('cd', url, spec, { pingIntervalMs: 3600000 });
  await a.start(CLIENT);
  expect((await call(a, 'browser_navigate', { url: `${origin}/a` }))?.isError, 'navigate sain OK (browser lancé)').not.toBe(true);

  const browserPids = listProcesses()
    .filter((p) => p.cmd.includes(needle) && /(chrome|chromium|headless_shell|msedge)/i.test(p.cmd) && !/node|npx|cmd\.exe/i.test(p.cmd))
    .map((p) => p.pid);
  expect(browserPids.length, 'au moins un process browser à tuer').toBeGreaterThan(0);
  for (const pid of browserPids) { try { treeKill(pid); } catch {} }
  await new Promise((r) => setTimeout(r, 1500));

  expect(isPidAlive(serverPid), 'le serveur node survit à la mort de son Chrome').toBe(true);
  expect(await repond(port), 'le port répond toujours (aveugle à la mort du browser)').toBe(true);
  expect(await a.request('ping', {}), 'ping reste vert (aveugle)').toEqual({});
  let pended = true;
  await Promise.race([
    call(a, 'browser_navigate', { url: `${origin}/b` }).then(() => { pended = false; }).catch(() => { pended = false; }),
    new Promise((r) => setTimeout(r, 20000)),
  ]);
  expect(pended, 'action après mort du browser REVIENT en <20 s (erreur ou recovery), JAMAIS un pend').toBe(false);
  a.stop();
}, 180000);

test.skipIf(!LIVE)('LIVE : serveur TUÉ sous un Manager RÉEL => échec RAPIDE (jamais un pend) puis reprise TRANSPARENTE via get()', async () => {
  const mgrCfg = path.join(os.tmpdir(), `pw-mcp-live-mgr-${process.pid}.json`);
  fs.writeFileSync(mgrCfg, JSON.stringify({
    http: true,
    defaultProfile: 'anon2',
    ...(BIND_HOST ? { bindHost: BIND_HOST, bindHostInterface: process.env.PW_MCP_BIND_HOST_INTERFACE } : {}),
    profiles: { anon2: { label: 'anon2', isolated: true, args: ['--headless'], backend: BACKEND } },
  }));
  // ⚠️ Manager sur le canal de TEST (env injecté) : jamais le daemon de l'opérateur.
  const mgr = new Manager(mgrCfg, { watchdog: { pingIntervalMs: 3600000 }, env: {}, daemonEnv: ENV });
  try {
    const b1 = await mgr.get('anon2');
    b1.on('backendRequest', (m) => { if (m.method === 'ping') b1.respondToBackend(m.id, { jsonrpc: '2.0', id: m.id, result: {} }); });
    expect((await call(b1, 'browser_navigate', { url: `${origin}/a` }))?.isError, 'état sain de référence').not.toBe(true);
    const port1 = new URL(b1.transport.url).port;
    const cible = listProcesses().find((p) => p.cmd.includes(`--port ${port1}`));
    expect(cible, `aucun process ne sert le port ${port1}`).toBeTruthy();
    treeKill(cible.pid);
    await new Promise((r) => setTimeout(r, 1500));

    let pended = true;
    await Promise.race([
      call(b1, 'browser_navigate', { url: `${origin}/b` }).then(() => { pended = false; }).catch(() => { pended = false; }),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
    expect(pended, 'appel sur session morte : échec rapide, jamais un pend').toBe(false);
    expect(b1.exited, 'l ancien backend est tombé (exited)').toBe(true);

    const b2 = await mgr.get('anon2');
    b2.on('backendRequest', (m) => { if (m.method === 'ping') b2.respondToBackend(m.id, { jsonrpc: '2.0', id: m.id, result: {} }); });
    expect(b2, 'backend FRAIS (jamais le cadavre ranimé)').not.toBe(b1);
    const port2 = new URL(b2.transport.url).port;
    expect(port2, 'serveur NEUF : jamais le port du cadavre').not.toBe(port1);
    expect((await call(b2, 'browser_navigate', { url: `${origin}/a` }))?.isError, 'action après reprise : SUCCÈS transparent').not.toBe(true);
  } finally {
    mgr.stopAll();
    try { fs.unwatchFile(mgrCfg); } catch {}
    try { fs.unlinkSync(mgrCfg); } catch {}
  }
}, 180000);

// ═══ S8 — ÉTANCHÉITÉ DES IDENTITÉS ═══════════════════════════════════════════════════════════
test.skipIf(!LIVE)('LIVE S8 : un cookie posé dans le profil A est INVISIBLE depuis le profil B', async () => {
  const backends = [];
  const mkProfil = async (nom) => {
    const spec = buildSpec(nom, { userDataDir: tmp(`s8-${nom}`), args: ['--headless'], backend: BACKEND }, {});
    const { url } = await instancePour(nom, spec);
    const b = backendQuiRepond(nom, url, spec);
    await b.start(CLIENT);
    backends.push(b);
    return b;
  };
  try {
    const A = await mkProfil('s8a');
    await call(A, 'browser_navigate', { url: `${origin}/a` });
    await call(A, 'browser_evaluate', { function: '() => { document.cookie = "identite=profilA; path=/"; return document.cookie; }' });
    expect(texte(await call(A, 'browser_evaluate', { function: '() => document.cookie' })), 'préalable : le cookie EST posé dans A').toMatch(/profilA/);
    const B = await mkProfil('s8b');
    await call(B, 'browser_navigate', { url: `${origin}/a` });
    expect(texte(await call(B, 'browser_evaluate', { function: '() => document.cookie' })), 'ÉTANCHÉITÉ VIOLÉE : le cookie de A est visible depuis B').not.toMatch(/profilA/);
  } finally {
    for (const b of backends) { try { b.stop(); } catch {} }
  }
}, 240000);
