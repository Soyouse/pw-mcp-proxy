// SOUVENIR de handshake — le routeur sert initialize/tools/list SANS allumer le backend (17/10/2026).
// ZERO spawn : manager/backend factices, MEME forme que l'appelant reel (Router + SouvenirHandshake +
// ouvrirCache sur un vrai fichier temporaire). Ce qui est prouve :
//   ① souvenir present + rien d'allume  => AUCUN appel a manager.active() (= aucun Playwright) ;
//   ② souvenir absent                    => chemin vivant d'avant, PUIS la reponse est memorisee ;
//   ③ premier vrai appel                 => la liste vivante est confrontee, perimee => list_changed ;
//   ④ backend deja allume                => le vivant prime, le souvenir est ignore ;
//   ⑤ notification, rien d'allume        => non relayee (relayer allumerait Playwright).
import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from '../src/router.js';
import { ouvrirCache } from '../src/handshake-cache.js';

const OUTILS = () => [{ name: 'browser_navigate', inputSchema: { type: 'object' } }, { name: 'browser_click', inputSchema: { type: 'object' } }];
const INIT_BACKEND = () => ({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: 'INSTR' });
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const CALL = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'about:blank' } } };

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-souvenir-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function monter({ outilsVivants = OUTILS(), allume = false } = {}) {
  const msgs = [];
  const out = { write: (s) => msgs.push(JSON.parse(s)) };
  const appels = { active: 0, transmis: [] };
  const backend = {
    initResult: INIT_BACKEND(),
    request: async (m) => (m === 'tools/list' ? { tools: structuredClone(outilsVivants) } : {}),
    forwardRequest: (m) => appels.transmis.push(m),
    forwardNotification: (m) => appels.transmis.push(m),
  };
  const backends = new Map();
  if (allume) backends.set('job', backend);
  const manager = {
    clientInfo: {},
    activeProfile: 'job',
    config: { profiles: { job: { label: 'Job' } } },
    profileList: () => [{ name: 'job', label: 'Job' }],
    backends,
    instanceInfo: () => ({}),
    onNewBackend: null,
    onConfigChange: null,
    demarre: () => backends.has('job'),
    specActive: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--caps=storage'], configuration: null, label: 'Job' }),
    active: async () => { appels.active++; backends.set('job', backend); return backend; },
  };
  const cache = ouvrirCache(path.join(dir, 'handshake-cache.json'));
  const r = new Router(manager, out, '1.0.0', { handshakeBudgetMs: 2000, cache });
  return { r, msgs, appels, cache, manager };
}
const flush = () => new Promise((res) => setImmediate(res));
const noms = (msgs, id) => msgs.find((m) => m.id === id).result.tools.map((t) => t.name);

test('② souvenir ABSENT : chemin vivant (backend allume), puis reponse MEMORISEE', async () => {
  const { r, msgs, appels } = monter();
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  expect(appels.active, 'sans souvenir, le backend s allume comme avant').toBeGreaterThan(0);
  expect(noms(msgs, 2)).toEqual(['browser_navigate', 'browser_click', 'switch_profile', 'current_profile', 'restart_profile']);
  const memo = JSON.parse(fs.readFileSync(path.join(dir, 'handshake-cache.json'), 'utf8'));
  expect(memo.entrees.length).toBe(1);
  expect(memo.entrees[0].init).toEqual(INIT_BACKEND());
  expect(memo.entrees[0].tools, 'la liste du BACKEND seule, sans nos 3 outils maison').toEqual(OUTILS());
});

test('① souvenir PRESENT : initialize + tools/list servis SANS allumer le backend, reponse identique', async () => {
  const premier = monter();
  await premier.r.handleClientMessage(INIT);
  await premier.r.handleClientMessage(LIST);
  const { r, msgs, appels } = monter(); // nouvelle session, meme fichier de souvenir
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  expect(appels.active, 'AUCUN Playwright allume a l ouverture').toBe(0);
  expect(msgs.find((m) => m.id === 1).result).toEqual(premier.msgs.find((m) => m.id === 1).result);
  expect(msgs.find((m) => m.id === 2).result).toEqual(premier.msgs.find((m) => m.id === 2).result);
});

test('③ premier vrai appel : liste vivante IDENTIQUE => aucune notification parasite', async () => {
  await (async () => { const s = monter(); await s.r.handleClientMessage(INIT); await s.r.handleClientMessage(LIST); })();
  const { r, msgs, appels } = monter();
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  await r.handleClientMessage(CALL);
  await flush();
  expect(appels.active, 'le vrai appel allume le backend').toBe(1);
  expect(appels.transmis.map((m) => m.id), 'l appel est relaye tel quel').toEqual([3]);
  expect(msgs.some((m) => m.method === 'notifications/tools/list_changed')).toBe(false);
});

test('③ premier vrai appel : liste vivante DIFFERENTE => souvenir reecrit + tools/list_changed', async () => {
  await (async () => { const s = monter(); await s.r.handleClientMessage(INIT); await s.r.handleClientMessage(LIST); })();
  const nouvelle = [...OUTILS(), { name: 'browser_nouveau', inputSchema: { type: 'object' } }];
  const { r, msgs } = monter({ outilsVivants: nouvelle });
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  expect(noms(msgs, 2), 'avant usage : le souvenir (perime) est servi').not.toContain('browser_nouveau');
  await r.handleClientMessage(CALL);
  await flush();
  expect(msgs.some((m) => m.method === 'notifications/tools/list_changed'), 'le client est prevenu').toBe(true);
  await r.handleClientMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  expect(noms(msgs, 9), 'apres : la liste VIVANTE').toContain('browser_nouveau');
  const memo = JSON.parse(fs.readFileSync(path.join(dir, 'handshake-cache.json'), 'utf8'));
  expect(memo.entrees[0].tools, 'souvenir corrige pour la session suivante').toEqual(nouvelle);
});

test('④ backend DEJA allume : le vivant prime, le souvenir est ignore', async () => {
  await (async () => { const s = monter(); await s.r.handleClientMessage(INIT); await s.r.handleClientMessage(LIST); })();
  const { r, msgs, appels } = monter({ allume: true, outilsVivants: [{ name: 'browser_vivant' }] });
  await r.handleClientMessage(LIST);
  expect(appels.active).toBe(1);
  expect(noms(msgs, 2)).toContain('browser_vivant');
});

test('⑤ notification sans backend allume : NON relayee (aucun allumage)', async () => {
  const { r, appels } = monter();
  await r.handleClientMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  expect(appels.active).toBe(0);
  expect(appels.transmis).toEqual([]);
});

test('⑤ notification backend allume : relayee comme avant', async () => {
  const { r, appels } = monter({ allume: true });
  await r.handleClientMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  expect(appels.transmis.map((m) => m.method)).toEqual(['notifications/cancelled']);
});

test('ouvrirCache : fichier corrompu => aucun souvenir (chemin vivant), et aucun temporaire laisse', async () => {
  const fichier = path.join(dir, 'handshake-cache.json');
  fs.writeFileSync(fichier, '{pas du json');
  const cache = ouvrirCache(fichier);
  expect(cache.lire('k')).toBeNull();
  cache.completer('k', { init: { a: 1 } });
  expect(cache.lire('k')).toEqual({ cle: 'k', init: { a: 1 } });
  expect(fs.readdirSync(dir), 'ecriture atomique : le temporaire est renomme').toEqual(['handshake-cache.json']);
});

test('ouvrirCache : rien de neuf => AUCUNE ecriture (mtime inchange)', async () => {
  const fichier = path.join(dir, 'handshake-cache.json');
  const cache = ouvrirCache(fichier);
  cache.completer('k', { tools: [] });
  const avant = fs.statSync(fichier).mtimeMs;
  fs.utimesSync(fichier, new Date(0), new Date(0));
  cache.completer('k', { tools: [] });
  expect(fs.statSync(fichier).mtimeMs, 'pas reecrit').toBe(0);
  expect(avant).toBeGreaterThan(0);
});
