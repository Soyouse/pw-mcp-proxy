// Contract / drift-test LIVE contre le VRAI `@playwright/mcp` en mode HTTP partagé (multi-agent).
// Preuve de bout en bout : superviseur spawn le vrai serveur `--port`, HttpTransport parle le contrat
// Streamable HTTP reel, deux "agents" (2 Backends) ADOPTENT le meme serveur => multi-agent prouve sur
// le vrai binaire, pas seulement sur un fake. Sert aussi de DRIFT-TEST : si une update `@playwright/mcp`
// change la forme du handshake/transport, ce test devient ROUGE avant tout deploiement.
//
// ⚠️ NE TOURNE QUE si PW_MCP_LIVE=1 (telecharge/lance un vrai Chromium => hors CI par defaut, cf
// doctrine "GitHub = bonus"). Lancer manuellement : PW_MCP_LIVE=1 npx vitest run tests/contract-live.test.js
// Version PINNEE volontairement (PW_MCP_VERSION) : on ne teste pas un `@latest` mouvant a l'aveugle.

import { test, beforeAll, afterAll, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Supervisor } from '../src/supervisor.js';
import { Backend } from '../src/backend.js';
import { HttpTransport } from '../src/http-transport.js';
import { buildSpec } from '../src/spec.js';
import { serverEntry } from '../src/server-registry.js';
import { treeKill, isPidAlive, listProcesses } from '../src/prockill.js';

const LIVE = process.env.PW_MCP_LIVE === '1';
const VERSION = process.env.PW_MCP_VERSION || '0.0.78'; // PIN : aligner sur profiles.json
const CLIENT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract', version: '1' } };

let cfg, sup;

beforeAll(() => {
  cfg = path.join(os.tmpdir(), `pw-mcp-live-${process.pid}.json`);
  sup = new Supervisor(cfg, { ttl: 60000 });
});
afterAll(async () => {
  if (!LIVE) return;
  try { await sup.shutdown(); } catch {}
  try {
    const reg = JSON.parse(fs.readFileSync(sup.registryPath, 'utf8'));
    for (const s of Object.values(reg.servers || {})) { try { treeKill(s.pid); } catch {} }
  } catch {}
  try { fs.unlinkSync(sup.registryPath); } catch {}
  try { fs.unlinkSync(sup.lockPath); } catch {}
});

test.skipIf(!LIVE)('LIVE : superviseur spawn le vrai @playwright/mcp --port, 2 agents ADOPTENT le meme serveur + browser_navigate expose', async () => {
  // Profil isolate headless => aucune contention de profil perso, sessions ephemeres.
  const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: { command: 'npx', args: ['-y', `@playwright/mcp@${VERSION}`] } }, {});

  // Agent A : garantit le serveur, se connecte en client HTTP, handshake reel.
  const url = await sup.ensureServer('anon', spec);
  expect(url).toMatch(/^http:\/\/localhost:\d+\/mcp$/); // URL client documentee (localhost, cf --allowed-hosts)
  const pidA = serverEntry(sup._read(), 'anon').pid;

  const a = new Backend('anon', new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }));
  const initA = await a.start(CLIENT);
  expect(initA?.serverInfo, 'handshake initialize reel OK (serverInfo present)').toBeTruthy();

  const toolsA = await a.request('tools/list', {});
  const names = (toolsA.tools || []).map((t) => t.name);
  expect(names.includes('browser_navigate'), 'le vrai backend expose browser_navigate (passthrough)').toBeTruthy();

  // Agent B : 2e proxy, MEME profil => doit ADOPTER le serveur d'A (multi-agent, pas de 2e spawn).
  const url2 = await sup.ensureServer('anon', spec);
  const pidB = serverEntry(sup._read(), 'anon').pid;
  expect(url2, 'meme URL').toBe(url);
  expect(pidB, 'MEME serveur adopte : multi-agent sur le vrai binaire').toBe(pidA);

  const b = new Backend('anon', new HttpTransport(url2, { protocolVersion: CLIENT.protocolVersion, spec }));
  const initB = await b.start(CLIENT);
  expect(initB?.serverInfo, 'agent B handshake OK sur le serveur partage').toBeTruthy();

  const toolsB = await b.request('tools/list', {});
  expect((toolsB.tools || []).some((t) => t.name === 'browser_navigate'), 'agent B voit aussi les tools').toBeTruthy();

  a.stop();
  b.stop();
});

test.skipIf(!LIVE)('LIVE : le VRAI @playwright/mcp repond au `ping` MCP (fondation du watchdog de liveness)', async () => {
  // ⚠️ MESURE couche 2 (bug gel 2026-07-22) : le watchdog de backend.js suppose que le vrai binaire
  // honore `ping` (spec MCP 2025-11-25 utilities/ping : le receveur DOIT repondre {}). On le PROUVE
  // ici contre le binaire reel (pas un fake) => si une update `@playwright/mcp` cassait le ping, ce
  // test devient ROUGE en nightly AVANT que le watchdog ne se mette a tuer des backends sains.
  const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: { command: 'npx', args: ['-y', `@playwright/mcp@${VERSION}`] } }, {});
  const url = await sup.ensureServer('anon', spec);
  const a = new Backend('anon', new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }));
  await a.start(CLIENT);

  const res = await a.request('ping', {});
  expect(res, 'le vrai backend DOIT repondre {} au ping (contrat MCP) — sans ca, le watchdog est aveugle').toEqual({});

  a.stop();
});

test.skipIf(!LIVE)('LIVE : profil PERSISTANT partage (--user-data-dir jetable + --shared-browser-context) — 2 agents COEXISTENT sur 1 navigateur partage', async () => {
  // ⚠️ userDataDir JETABLE (tmp) : ne JAMAIS viser les vrais profils vegeta/perso (Chrome en cours).
  // opts.http:true => buildSpec ajoute --shared-browser-context. SEMANTIQUE DOCUMENTEE : « share A SINGLE
  // browser context between multiple connected clients » => les agents PARTAGENT navigateur+onglet+session
  // (ils ne sont PAS independants). Ce qu'on prouve ici = la COEXISTENCE : les 2 agents opèrent le meme
  // navigateur SANS erreur "browser is already in use" (le blocage du stdio d'avant). PAS de navigation
  // concurrente independante (impossible par design : 1 seul onglet partage) => on navigue en SEQUENCE.
  const dir = path.join(os.tmpdir(), `pw-mcp-live-udd-${process.pid}`);
  const spec = buildSpec('persist', { userDataDir: dir, args: ['--headless'], backend: { command: 'npx', args: ['-y', `@playwright/mcp@${VERSION}`] } }, {}, { http: true });

  // Un SEUL serveur (SingletonLock sur le --user-data-dir) ; les 2 agents doivent l'adopter.
  const url = await sup.ensureServer('persist', spec, { userDataDir: dir });
  const a = new Backend('persist', new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }));
  const b = new Backend('persist', new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }));
  await a.start(CLIENT);
  await b.start(CLIENT);

  // Navigation SEQUENTIELLE : chaque agent opère le navigateur partagé a son tour, sans conflit de lock.
  const ra = await a.request('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,<title>A</title>' } });
  expect(ra?.isError, 'agent A opere le navigateur partage sans "already in use"').not.toBe(true);
  const rb = await b.request('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,<title>B</title>' } });
  expect(rb?.isError, 'agent B opere le MEME navigateur partage a son tour, sans conflit').not.toBe(true);

  a.stop();
  b.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test.skipIf(!LIVE)('LIVE : MORT de Chrome sous serveur VIVANT => l action REVIENT (jamais un pend) + node survit + ping/probe AVEUGLES', async () => {
  // ⚠️ CONTRAT MESURE 2026-07-23 (couche 2a, cf memory reference-browser-mcp-freeze-bug). Quand le
  // Chrome d'un serveur @playwright/mcp VIVANT meurt, le serveur node NE PEND JAMAIS : l'action
  // suivante REVIENT vite — soit en erreur (« browser has been closed »), soit en SUCCES car le
  // serveur RELANCE le navigateur tout seul (auto-recovery observe). Les DEUX prouvent la resilience ;
  // l'issue exacte (erreur vs recovery) est NON-DETERMINISTE (course) => on NE l'assert PAS (sinon
  // flaky). Le ping MCP ET le GET /mcp restent VERTS (AVEUGLES a la mort du browser) => le watchdog
  // couche 1 ne couvre PAS ce cas, et n'a PAS a le couvrir (le vrai pend passe par un ping muet, teste
  // plus haut). Ce test SCELLE le SEUL invariant qui compte : PAS DE PEND. Si un bump PW le casse (ex:
  // l'action se met a PENDRE), il ROUGIT en nightly AVANT tout deploiement.
  // ⚠️ le needle NE DOIT PAS contenir un mot-cle browser (chrome/chromium…) : il apparait dans le
  // --user-data-dir de TOUS les process (serveur node + wrapper npx inclus) => sinon le filtre browser
  // ci-dessous matcherait le wrapper cmd.exe/npx et le treeKill /T tuerait aussi le serveur node.
  const dir = path.join(os.tmpdir(), `pw-mcp-live-bkill-${process.pid}`);
  const spec = buildSpec('cd', { userDataDir: dir, args: ['--headless'], backend: { command: 'npx', args: ['-y', `@playwright/mcp@${VERSION}`] } }, {}, { http: true });
  const needle = path.basename(dir); // fragment UNIQUE present dans la cmdline de chaque enfant browser

  const url = await sup.ensureServer('cd', spec, { userDataDir: dir });
  const serverPid = serverEntry(sup._read(), 'cd').pid;
  const port = serverEntry(sup._read(), 'cd').port;
  // Watchdog quasi desactive (pingIntervalMs enorme) : on mesure le contrat BRUT du serveur, pas la couche 1.
  const a = new Backend('cd', new HttpTransport(url, { protocolVersion: CLIENT.protocolVersion, spec }), { pingIntervalMs: 3600000 });
  await a.start(CLIENT);

  // Lance reellement le browser (navigate) : etat SAIN de reference.
  const ok = await a.request('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,<title>ok</title>' } });
  expect(ok?.isError, 'navigate sain OK (browser lance)').not.toBe(true);

  // Tue UNIQUEMENT le(s) process BROWSER de ce profil (binaire chrome/headless, JAMAIS node : sinon on
  // tuerait le serveur qu'on veut garder vivant). Cross-OS via listProcesses (ps/CIM) + treeKill.
  const browserPids = listProcesses()
    .filter((p) => p.cmd.includes(needle) && /(chrome|chromium|headless_shell|msedge)/i.test(p.cmd) && !/node|npx|cmd\.exe/i.test(p.cmd))
    .map((p) => p.pid);
  expect(browserPids.length, 'au moins un process browser a tuer').toBeGreaterThan(0);
  for (const pid of browserPids) { try { treeKill(pid); } catch {} }
  await new Promise((r) => setTimeout(r, 1500)); // laisse le node « digerer » la mort du browser

  // CONTRAT 1 : le node serveur SURVIT (ne s'arrete PAS sur disconnected sur cette version).
  expect(isPidAlive(serverPid), 'le serveur node survit a la mort de son Chrome').toBe(true);
  // CONTRAT 2 : le GET /mcp reste VERT (aveugle a la mort du browser).
  expect(await sup._probeReady(port), '_probeReady reste vert (aveugle a la mort du browser)').toBe(true);
  // CONTRAT 3 : le ping MCP repond {} (aveugle : le node vit, seul le browser est mort).
  expect(await a.request('ping', {}), 'ping reste vert (aveugle)').toEqual({});
  // CONTRAT 4 (LE coeur, la seule chose qui compte) : l'action REVIENT en <20s — erreur OU succes
  // (auto-recovery), peu importe — mais JAMAIS un pend. `pended` reste false SSI l'action a resolu/rejete
  // avant 20s ; un pend => `pended=true` => ROUGE (le contrat PW a bascule vers le pend => reagir).
  let pended = true;
  await Promise.race([
    a.request('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,<title>after</title>' } })
      .then(() => { pended = false; }).catch(() => { pended = false; }),
    new Promise((r) => setTimeout(r, 20000)),
  ]);
  expect(pended, 'action apres mort du browser REVIENT en <20s (erreur ou recovery), JAMAIS un pend').toBe(false);

  a.stop();
  try { treeKill(serverPid); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});
