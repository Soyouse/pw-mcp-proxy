// Test d'integration REEL : spawn le proxy + 2 faux backends MCP, exerce tout le pipeline.
// Couvre : handshake, tools/list (passthrough + switch_profile), tools/call,
// notifications backend->client, requetes server->client, switch de profil,
// passthrough de methode inconnue, hot-reload de la config.

import { test, beforeAll, afterAll, expect } from 'vitest';
import { spawnTracked } from './harness.js'; // ⚠️ spawn tracké + ratchet anti-fuite (JAMAIS child_process.spawn nu)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-backend.js');

let proc;
let cfgPath;
let buf = '';
const pending = new Map();
const notifications = [];

function writeCfg(obj) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}

function baseCfg() {
  return {
    defaultProfile: 'vegeta',
    backend: { command: process.execPath, args: [FAKE] },
    profiles: {
      vegeta: { args: ['--tag', 'A'], label: 'Agence' },
      perso: { args: ['--tag', 'B'], label: 'Perso' },
    },
  };
}

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

let idc = 0;
function request(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function onMessage(m) {
  // reponse a une de nos requetes
  if (m.id !== undefined && m.method === undefined) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message), { rpc: m.error })) : p.resolve(m.result);
    }
    return;
  }
  // requete server->client (ex: roots/list) : on repond automatiquement
  if (m.id !== undefined && m.method) {
    send({ jsonrpc: '2.0', id: m.id, result: { roots: [] } });
    return;
  }
  // notification
  if (m.method) notifications.push(m);
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  cfgPath = path.join(os.tmpdir(), `pw-mcp-test-${process.pid}.json`);
  writeCfg(baseCfg());
  proc = spawnTracked([INDEX], {
    env: { ...process.env, PW_MCP_PROFILES: cfgPath, PW_MCP_LOG: path.join(os.tmpdir(), `pw-mcp-test-${process.pid}.log`) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
});

afterAll(() => {
  // Process tué + vérifié par le harnais (spawnTracked -> ratchet). Ici : seulement le fichier temp.
  try { fs.unlinkSync(cfgPath); } catch {}
});

test('initialize : le proxy repond avec son identite + tools.listChanged', async () => {
  const res = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  notify('notifications/initialized', {});
  expect(res.serverInfo.name).toBe('pw-mcp-proxy');
  expect(res.capabilities.tools.listChanged).toBe(true);
  expect(res.protocolVersion).toBe('2025-06-18');
});

test('tools/list : liste du backend actif TELLE QUELLE + switch_profile', async () => {
  const res = await request('tools/list', {});
  const names = res.tools.map((t) => t.name);
  expect(names.includes('echo_A'), 'echo_A present').toBeTruthy();
  expect(names.includes('switch_profile'), 'switch_profile injecte').toBeTruthy();
  expect(!names.includes('echo_B'), 'pas les tools du profil inactif').toBeTruthy();
  const sw = res.tools.find((t) => t.name === 'switch_profile');
  expect(sw.inputSchema.properties.profile.enum).toEqual(['vegeta', 'perso']);
});

test('tools/call : passthrough vers le backend actif', async () => {
  const res = await request('tools/call', { name: 'echo_A', arguments: { v: 'hi' } });
  expect(res.content[0].text).toBe('A:hi');
});

test('notification backend->client remonte a Claude', async () => {
  notifications.length = 0;
  const res = await request('tools/call', { name: 'notify_A', arguments: {} });
  expect(res.content[0].text).toBe('notified');
  const got = await waitFor(() => notifications.some((n) => n.method === 'notifications/message'));
  expect(got, 'la notif du backend est bien remontee').toBeTruthy();
});

test('requete server->client (backend demande, Claude repond)', async () => {
  const res = await request('tools/call', { name: 'ask_A', arguments: {} });
  expect(res.content[0].text).toMatch(/client a repondu/);
});

test('switch_profile : bascule le backend actif', async () => {
  const res = await request('tools/call', { name: 'switch_profile', arguments: { profile: 'perso' } });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toMatch(/perso/);
});

test('apres switch : tools/list et tools/call ciblent le nouveau profil', async () => {
  const list = await request('tools/list', {});
  const names = list.tools.map((t) => t.name);
  expect(names.includes('echo_B'), 'echo_B (profil perso)').toBeTruthy();
  expect(!names.includes('echo_A'), 'plus echo_A').toBeTruthy();
  const call = await request('tools/call', { name: 'echo_B', arguments: { v: 'yo' } });
  expect(call.content[0].text).toBe('B:yo');
});

test('passthrough d une methode MCP inconnue du proxy', async () => {
  const res = await request('resources/list', {});
  expect(res.ok).toBe(true);
  expect(res.method).toBe('resources/list');
  expect(res.tag).toBe('B'); // route vers le backend actif (perso)
});

test('switch vers profil inconnu : erreur propre, pas de crash', async () => {
  const res = await request('tools/call', { name: 'switch_profile', arguments: { profile: 'nope' } });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/inconnu/);
});

test('hot-reload : ajout d un profil sans restart', async () => {
  notifications.length = 0;
  const cfg = baseCfg();
  cfg.profiles.client3 = { args: ['--tag', 'C'], label: 'Client 3' };
  writeCfg(cfg);
  // watchFile interval = 1000ms
  const reloaded = await waitFor(() => notifications.some((n) => n.method === 'notifications/tools/list_changed'), 4000);
  expect(reloaded, 'tools/list_changed emis apres hot-reload').toBeTruthy();
  const res = await request('tools/call', { name: 'switch_profile', arguments: { profile: 'client3' } });
  expect(res.isError).toBe(false);
  const list = await request('tools/list', {});
  expect(list.tools.map((t) => t.name).includes('echo_C')).toBeTruthy();
});

test('hot-reload caps : respawn du backend actif + nouvel outil a chaud', async () => {
  await request('tools/call', { name: 'switch_profile', arguments: { profile: 'vegeta' } });
  let before = await request('tools/list', {});
  expect(!before.tools.map((t) => t.name).includes('storage_A'), 'pas encore de cap storage').toBeTruthy();

  notifications.length = 0;
  const cfg = baseCfg();
  cfg.profiles.vegeta.caps = ['storage']; // active la cap sur le profil actif
  writeCfg(cfg);

  const changed = await waitFor(() => notifications.some((n) => n.method === 'notifications/tools/list_changed'), 4000);
  expect(changed, 'tools/list_changed emis apres changement de caps').toBeTruthy();
  const after = await request('tools/list', {});
  expect(after.tools.map((t) => t.name).includes('storage_A'), 'le backend actif a respawn avec --caps=storage').toBeTruthy();
});

// ---- Anti-peremption du "profil actif" (incident 2026-06-02 : action sur le mauvais compte) ----

test('tools/list expose current_profile a cote de switch_profile', async () => {
  const res = await request('tools/list', {});
  const names = res.tools.map((t) => t.name);
  expect(names.includes('current_profile'), 'current_profile injecte').toBeTruthy();
  expect(names.includes('switch_profile'), 'switch_profile toujours la').toBeTruthy();
});

test('current_profile : renvoie le profil actif (verite fraiche)', async () => {
  // dernier switch (test caps) -> active = vegeta
  const res = await request('tools/call', { name: 'current_profile', arguments: {} });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toMatch(/"vegeta"/);
});

test('current_profile suit le switch sans dependre d un cache', async () => {
  await request('tools/call', { name: 'switch_profile', arguments: { profile: 'perso' } });
  const res = await request('tools/call', { name: 'current_profile', arguments: {} });
  expect(res.content[0].text).toMatch(/"perso"/);
});

test('un switch emet tools/list_changed (rafraichit l etiquette cote client)', async () => {
  notifications.length = 0;
  await request('tools/call', { name: 'switch_profile', arguments: { profile: 'vegeta' } });
  const got = await waitFor(() => notifications.some((n) => n.method === 'notifications/tools/list_changed'));
  expect(got, 'switch_profile emet tools/list_changed -> la description "profil actif" ne peut plus perimer').toBeTruthy();
  // et current_profile confirme le nouvel etat, frais
  const cur = await request('tools/call', { name: 'current_profile', arguments: {} });
  expect(cur.content[0].text).toMatch(/"vegeta"/);
});

// ---- restart_profile (P1) : liberer le verrou d'un profil bloque + respawn propre ----

test('tools/list expose restart_profile a cote de switch/current', async () => {
  const res = await request('tools/list', {});
  const names = res.tools.map((t) => t.name);
  expect(names.includes('restart_profile'), 'restart_profile injecte').toBeTruthy();
});

test('restart_profile : respawn le backend cible, profil actif inchange, tool OK apres', async () => {
  // actif = vegeta (dernier switch). On redemarre vegeta -> nouveau backend.
  const res = await request('tools/call', { name: 'restart_profile', arguments: { profile: 'vegeta' } });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toMatch(/redemarre/);
  // backend neuf mais operationnel : echo repond encore
  const call = await request('tools/call', { name: 'echo_A', arguments: { v: 'ok' } });
  expect(call.content[0].text).toBe('A:ok');
  // le profil actif reste vegeta (restart ne switch pas)
  const cur = await request('tools/call', { name: 'current_profile', arguments: {} });
  expect(cur.content[0].text).toMatch(/"vegeta"/);
});

test('restart_profile inconnu : erreur propre, pas de crash', async () => {
  const res = await request('tools/call', { name: 'restart_profile', arguments: { profile: 'nope' } });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/inconnu/i);
});
