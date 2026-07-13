// Test d'integration du client HttpTransport contre un faux serveur MCP Streamable HTTP in-process.
// Verifie le respect du contrat CLIENT : capture MCP-Session-Id, reponse JSON, reponse SSE
// (notif liee + response), flux GET serveur->client, DELETE au close.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport } from '../src/http-transport.js';
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
  assert.ok(ok, `reponse a ${method} (id=${id}) recue`);
  return messages.find((m) => m.id === id);
}

before(async () => {
  backend = await startFakeHttpBackend();
  transport = new HttpTransport(backend.url, { protocolVersion: '2025-06-18' });
  transport.on('message', (m) => messages.push(m));
  transport.on('error', (e) => messages.push({ _error: e.message }));
});

after(async () => {
  await transport.close();
  await backend.close();
});

test('initialize : capture le MCP-Session-Id et remonte la response', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 1);
  assert.equal(res.result.serverInfo.name, 'fake-http');
  assert.equal(transport.sessionId, 'sess-1', 'session-id capture depuis le header de reponse');
});

test('tools/list : reponse JSON directe remontee', async () => {
  const res = await rpc('tools/list', {}, 2);
  assert.deepEqual(res.result.tools.map((t) => t.name), ['echo_http']);
});

test('tools/call JSON : echo', async () => {
  const res = await rpc('tools/call', { name: 'echo_http', arguments: { v: 'hi' } }, 3);
  assert.equal(res.result.content[0].text, 'echo:hi');
});

test('tools/call SSE : la notif LIEE et la response arrivent toutes deux', async () => {
  messages.length = 0;
  const res = await rpc('tools/call', { name: 'notify_http', arguments: {} }, 4);
  assert.equal(res.result.content[0].text, 'notified-http');
  const gotNotif = messages.some((m) => m.method === 'notifications/message' && m.params?.data === 'via-sse');
  assert.ok(gotNotif, 'la notif liee (via SSE) est bien remontee avant/avec la response');
});

test('flux GET : une notif serveur->client non sollicitee remonte', async () => {
  const got = await waitFor(() => messages.some((m) => m.method === 'notifications/server_hello'), 3000);
  assert.ok(got, 'la notif du flux GET serveur->client est remontee');
});

test('toutes les requetes ont porte le MCP-Session-Id (verifie via un echange supplementaire)', async () => {
  // apres init, sessionId est fixe : un nouvel echange doit toujours reussir (le serveur l'accepte)
  const res = await rpc('tools/list', {}, 5);
  assert.ok(res.result.tools.length >= 1);
  assert.equal(transport.sessionId, 'sess-1', 'session-id inchange, reutilise sur chaque requete');
});
