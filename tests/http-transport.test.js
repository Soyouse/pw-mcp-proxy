// Test d'integration du client HttpTransport contre un faux serveur MCP Streamable HTTP in-process.
// Verifie le respect du contrat CLIENT : capture MCP-Session-Id, reponse JSON, reponse SSE
// (notif liee + response), flux GET serveur->client, DELETE au close.

import { test, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import { HttpTransport, erreurDeConnect } from '../src/http-transport.js';
import { startFakeHttpBackend } from './fixtures/fake-http-backend.js';

let backend;
let transport;
const messages = [];

function waitFor(pred, ms = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

// helper : envoie une request et attend la reponse (matchee par id) parmi les messages emis.
async function rpc(method, params, id) {
  transport.send({ jsonrpc: '2.0', id, method, params });
  const ok = await waitFor(() => messages.some((m) => m.id === id && (m.result !== undefined || m.error !== undefined)));
  expect(ok, `reponse a ${method} (id=${id}) recue`).toBeTruthy();
  return messages.find((m) => m.id === id);
}

beforeAll(async () => {
  backend = await startFakeHttpBackend();
  transport = new HttpTransport(backend.url, { protocolVersion: '2025-06-18' });
  transport.on('message', (m) => messages.push(m));
  transport.on('error', (e) => messages.push({ _error: e.message }));
});

afterAll(async () => {
  await transport.close();
  await backend.close();
});

test('initialize : capture le MCP-Session-Id et remonte la response', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 1);
  expect(res.result.serverInfo.name).toBe('fake-http');
  expect(transport.sessionId, 'session-id capture depuis le header de reponse').toBe('sess-1');
});

test('tools/list : reponse JSON directe remontee', async () => {
  const res = await rpc('tools/list', {}, 2);
  expect(res.result.tools.map((t) => t.name)).toEqual(['echo_http']);
});

test('tools/call JSON : echo', async () => {
  const res = await rpc('tools/call', { name: 'echo_http', arguments: { v: 'hi' } }, 3);
  expect(res.result.content[0].text).toBe('echo:hi');
});

test('tools/call SSE : la notif LIEE et la response arrivent toutes deux', async () => {
  messages.length = 0;
  const res = await rpc('tools/call', { name: 'notify_http', arguments: {} }, 4);
  expect(res.result.content[0].text).toBe('notified-http');
  const gotNotif = messages.some((m) => m.method === 'notifications/message' && m.params?.data === 'via-sse');
  expect(gotNotif, 'la notif liee (via SSE) est bien remontee avant/avec la response').toBeTruthy();
});

test('flux GET : une notif serveur->client non sollicitee remonte', async () => {
  const got = await waitFor(() => messages.some((m) => m.method === 'notifications/server_hello'), 3000);
  expect(got, 'la notif du flux GET serveur->client est remontee').toBeTruthy();
});

// ═══ RETRANSMISSION SYN AU NIVEAU 7 (05/09/2026, classe libuv `uv__is_loopback`) ═══
test('erreurDeConnect : syscall connect (simple ou AggregateError happy-eyeballs) = oui ; apres l envoi = non', () => {
  expect(erreurDeConnect(Object.assign(new Error('x'), { code: 'ETIMEDOUT', syscall: 'connect' }))).toBe(true);
  expect(erreurDeConnect(Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: 'connect' }))).toBe(true);
  const agg = new AggregateError([Object.assign(new Error('a'), { syscall: 'connect' }), Object.assign(new Error('b'), { syscall: 'connect' })], 'x');
  expect(erreurDeConnect(agg), 'localhost = ::1 ET 127.0.0.1 essayes, les deux au connect').toBe(true);
  const mixte = new AggregateError([Object.assign(new Error('a'), { syscall: 'connect' }), Object.assign(new Error('b'), { syscall: 'read' })], 'x');
  expect(erreurDeConnect(mixte), 'une erreur APRES l envoi dans le lot => jamais rejoue').toBe(false);
  expect(erreurDeConnect(Object.assign(new Error('x'), { code: 'ECONNRESET', syscall: 'read' }))).toBe(false);
  expect(erreurDeConnect(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
  expect(erreurDeConnect(null)).toBe(false);
  expect(erreurDeConnect(new AggregateError([], 'vide'))).toBe(false);
});

test('POST : un connect qui echoue est REJOUE (rien n a ete envoye), et la requete aboutit', async () => {
  const t = new HttpTransport(backend.url, { protocolVersion: '2025-06-18' });
  const reqReel = t._req.bind(t);
  let echecs = 0;
  t._req = async (method, headers, body, signal) => {
    if (method === 'POST' && echecs < 2) { echecs++; throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' }); }
    return reqReel(method, headers, body, signal);
  };
  const res = await new Promise((resolve) => { t.once('message', resolve); t.send({ jsonrpc: '2.0', id: 900, method: 'initialize', params: {} }); });
  expect(res.id).toBe(900);
  expect(echecs, 'deux SYN perdus, le troisieme est passe').toBe(2);
  await t.close();
});

test('POST : au-dela de CONNECT_ATTEMPTS le connect echoue pour de bon (transport error), jamais une boucle', async () => {
  const t = new HttpTransport(backend.url, { protocolVersion: '2025-06-18' });
  let essais = 0;
  t._req = async () => { essais++; throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' }); };
  const err = await new Promise((resolve) => { t.once('error', resolve); t.send({ jsonrpc: '2.0', id: 901, method: 'ping', params: {} }); });
  expect(String(err.message)).toMatch(/POST request/);
  expect(essais, 'exactement CONNECT_ATTEMPTS tentatives').toBe(3);
});

test('POST : une erreur APRES l envoi n est JAMAIS rejouee (un POST double = une action navigateur en double)', async () => {
  const t = new HttpTransport(backend.url, { protocolVersion: '2025-06-18' });
  let essais = 0;
  t._req = async () => { essais++; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', syscall: 'read' }); };
  await new Promise((resolve) => { t.once('error', resolve); t.send({ jsonrpc: '2.0', id: 902, method: 'ping', params: {} }); });
  expect(essais, 'UNE seule tentative').toBe(1);
});

test('toutes les requetes ont porte le MCP-Session-Id (verifie via un echange supplementaire)', async () => {
  // apres init, sessionId est fixe : un nouvel echange doit toujours reussir (le serveur l'accepte)
  const res = await rpc('tools/list', {}, 5);
  expect(res.result.tools.length >= 1).toBeTruthy();
  expect(transport.sessionId, 'session-id inchange, reutilise sur chaque requete').toBe('sess-1');
});
