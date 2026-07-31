// Borne de temps du HANDSHAKE (router.js) — scelle l'incident 2026-07-31 ET la NON-REGRESSION.
// ZERO I/O : manager/backend factices en memoire (meme pattern que manager-autorestart.test.js),
// budget INJECTE et court => deterministe, rapide, aucun spawn, aucun port, aucun reseau.
//
// ⚠️ LE TEST QUI COMPTE est le premier : « un backend PRET ne declenche AUCUN degrade ».
// C'est lui qui prouve que la borne n'a PAS change le comportement nominal. S'il rougit, une
// regression s'est glissee : le degrade serait devenu un mode de fonctionnement au lieu d'un filet.

import { test, expect } from 'vitest';
import { Router } from '../src/router.js';

const BUDGET = 30; // ms — borne injectee (prod = derivee de MCP_TIMEOUT, cf budget.js)

// Collecte les messages ecrits par le router (writeMessage => stream.write(JSON + '\n')).
function fakeOut() {
  const msgs = [];
  return { msgs, write: (s) => msgs.push(JSON.parse(s)) };
}

function fakeBackend(tools = [{ name: 'browser_navigate' }]) {
  return {
    initResult: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {} },
      instructions: 'INSTRUCTIONS-BACKEND',
    },
    request: async () => ({ tools }),
  };
}

function fakeManager(active) {
  return {
    clientInfo: {},
    activeProfile: 'p1',
    config: { profiles: { p1: { label: 'P1' } } },
    profileList: () => [{ name: 'p1', label: 'P1' }],
    backends: new Map(),
    onNewBackend: null,
    onConfigChange: null,
    active,
  };
}

const mkRouter = (active) => {
  const out = fakeOut();
  const r = new Router(fakeManager(active), out, '1.0.0', { handshakeBudgetMs: BUDGET });
  return { r, out };
};
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const nameOf = (t) => t.name;

// ---------- CAS NOMINAL : rien ne change (LE test de non-regression) ----------
test('NOMINAL : backend pret => initialize rend les VRAIES capabilities, AUCUN degrade', async () => {
  const b = fakeBackend();
  const { r, out } = mkRouter(async () => b);
  await r.handleClientMessage(INIT);
  const res = out.msgs.find((m) => m.id === 1).result;
  expect(res.capabilities.resources, 'capabilities du backend transmises').toBeDefined();
  expect(res.instructions, 'instructions du backend transmises').toBe('INSTRUCTIONS-BACKEND');
  expect(res.capabilities.tools.listChanged, 'listChanged toujours garanti').toBe(true);
});

test('NOMINAL : backend pret => tools/list rend la liste COMPLETE (backend + 3 maison)', async () => {
  const { r, out } = mkRouter(async () => fakeBackend());
  await r.handleClientMessage(LIST);
  const names = out.msgs.find((m) => m.id === 2).result.tools.map(nameOf);
  expect(names, 'le tool backend est bien present').toContain('browser_navigate');
  expect(names).toContain('switch_profile');
  expect(names).toContain('current_profile');
  expect(names).toContain('restart_profile');
  expect(names.length, 'aucun tool en trop ni en moins').toBe(4);
});

test('NOMINAL : aucune notification tools/list_changed parasite', async () => {
  // Le rattrapage ne doit PAS se declencher quand tout va bien (sinon Claude re-tire la liste pour rien).
  const { r, out } = mkRouter(async () => fakeBackend());
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  await new Promise((res) => setTimeout(res, BUDGET * 3));
  expect(out.msgs.filter((m) => m.method === 'notifications/tools/list_changed').length).toBe(0);
});

// ---------- CAS D'ECHEC : la ou AVANT la session mourait ----------
test('LENT : backend hors budget => initialize repond QUAND MEME (la session SURVIT)', async () => {
  // ⚠️ AVANT ce correctif : attente sans borne => le client raccrochait a 30 s => session MORTE,
  // et un serveur stdio n'est JAMAIS reconnecte automatiquement (doc Claude Code) => action humaine.
  const { r, out } = mkRouter(() => new Promise(() => {})); // ne resout jamais
  await r.handleClientMessage(INIT);
  const res = out.msgs.find((m) => m.id === 1).result;
  expect(res, 'une reponse EST envoyee').toBeTruthy();
  expect(res.serverInfo.name).toBe('pw-mcp-proxy');
  expect(res.capabilities.tools.listChanged, 'listChanged conserve => rattrapage possible').toBe(true);
});

test('LENT : tools/list hors budget => nos 3 tools maison, jamais une erreur', async () => {
  const { r, out } = mkRouter(() => new Promise(() => {}));
  await r.handleClientMessage(LIST);
  const out2 = out.msgs.find((m) => m.id === 2);
  expect(out2.error, 'jamais une erreur : une liste degradee reste exploitable').toBeUndefined();
  expect(out2.result.tools.map(nameOf).sort()).toEqual(['current_profile', 'restart_profile', 'switch_profile']);
});

test('RATTRAPAGE : le backend arrive APRES le degrade => tools/list_changed est emis', async () => {
  // C'est ce qui rend le degrade INVISIBLE a l'usage : les outils apparaissent tout seuls.
  let resoudre;
  const tardif = new Promise((res) => { resoudre = res; });
  const { r, out } = mkRouter(() => tardif);
  await r.handleClientMessage(INIT);
  expect(out.msgs.some((m) => m.method === 'notifications/tools/list_changed'), 'pas encore').toBe(false);
  resoudre(fakeBackend());
  await new Promise((res) => setTimeout(res, 20));
  expect(out.msgs.some((m) => m.method === 'notifications/tools/list_changed'), 'rattrapage emis').toBe(true);
});

test('BACKEND KO : un rejet donne le MEME repli degrade (un seul chemin)', async () => {
  const { r, out } = mkRouter(async () => { throw new Error('backend KO'); });
  await r.handleClientMessage(INIT);
  await r.handleClientMessage(LIST);
  expect(out.msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('pw-mcp-proxy');
  expect(out.msgs.find((m) => m.id === 2).result.tools.length).toBe(3);
});

test('REJET TARDIF apres degrade : aucun unhandledRejection (le proxy survit)', async () => {
  const vus = [];
  const onUnhandled = (e) => vus.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejeter;
    const tardive = new Promise((_, rej) => { rejeter = rej; });
    const { r } = mkRouter(() => tardive);
    await r.handleClientMessage(INIT);
    rejeter(new Error('backend mort bien apres'));
    await new Promise((res) => setTimeout(res, 30));
    expect(vus.length, 'le rejet tardif est absorbe').toBe(0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
