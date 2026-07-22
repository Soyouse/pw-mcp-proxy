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
import { treeKill } from '../src/prockill.js';

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
