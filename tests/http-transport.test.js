// Test d'integration du client HttpTransport contre un faux serveur MCP Streamable HTTP in-process.
// Verifie le respect du contrat CLIENT : capture MCP-Session-Id, reponse JSON, reponse SSE
// (notif liee + response), flux GET serveur->client, DELETE au close.

import { test, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
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

test('toutes les requetes ont porte le MCP-Session-Id (verifie via un echange supplementaire)', async () => {
  // apres init, sessionId est fixe : un nouvel echange doit toujours reussir (le serveur l'accepte)
  const res = await rpc('tools/list', {}, 5);
  expect(res.result.tools.length >= 1).toBeTruthy();
  expect(transport.sessionId, 'session-id inchange, reutilise sur chaque requete').toBe('sess-1');
});

// ⚠️ ANTI-REGRESSION (bug trouve 02/08/2026 par simulation mentale, jamais observe en prod).
// _openGet() re-ouvrait le flux GET indefiniment sur echec, avec un `continue` NU : ni compteur,
// ni log, ni abandon. Scenario reel : le serveur partage meurt SANS requete en vol => le watchdog
// ne pinge pas (il ne tourne que sur requete en vol) et aucun POST ne part => le proxy bouclait
// A VIE a 2 Hz, EN SILENCE, et la mort du backend n'etait decouverte qu'au prochain appel de l'agent.
// Desormais : N echecs CONSECUTIFS => event 'error' => le Manager reconstruit un backend FRAIS.
test('GET SSE durablement refuse : le transport ABANDONNE et signale, il ne boucle pas a l\'infini', async () => {
  // Serveur qui repond aux POST mais refuse TOUJOURS le GET (500).
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(500); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; } // close() : sans ca, body vide
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // ⚠️ parse GARDE : un body vide/non-JSON ne doit JAMAIS lever ici — une exception dans un
      // handler de fixture devient un uncaughtException qui fait echouer TOUT le fichier de test.
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-refus' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  srv.on('clientError', () => {});
  srv.on('connection', (s) => s.on('error', () => {}));
  srv.on('request', (_q, s) => s.on('error', () => {}));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const t = new HttpTransport(`http://localhost:${srv.address().port}/mcp`);
  const failed = new Promise((resolve) => t.once('error', (e) => resolve(e)));
  await t.start();
  await t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); // declenche _ensureGetStream

  const err = await failed; // DOIT arriver : sans la borne, cette promesse ne se resout JAMAIS
  expect(String(err.message)).toMatch(/GET SSE/);
  expect(String(err.message)).toMatch(/500/);

  await t.close();
  await new Promise((r) => srv.close(r));
}, 30000);
