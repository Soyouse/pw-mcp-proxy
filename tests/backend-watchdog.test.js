// Watchdog de liveness du Backend (garde-fou fails-closed contre le GEL du backend).
// CONTEXTE (bug 2026-07-22) : un backend @playwright/mcp peut se FIGER (action Playwright qui
// pend : popup OAuth natif, page qui hang) et ne JAMAIS renvoyer la reponse d'un tools/call.
// Le proxy attendait alors sans borne => l'appel MCP pendait >120s en SILENCE (agent qui brule
// des tokens contre un navigateur mort). Cf memory reference-browser-mcp-freeze-bug.
//
// PRINCIPE (surface OFFICIELLE MCP, spec 2025-11-25 utilities/ping) : tant qu'une requete est en
// vol, le proxy pingue le backend. Le receveur d'un `ping` DOIT repondre {} promptement. Repond =>
// VIVANT (une action longue LEGITIME, ex upload 12 min, continue d'attendre). K pings consecutifs
// sans reponse => FIGE => on coupe avec l'erreur recuperable -32000 (Claude reprend la main).
// Le ping DISTINGUE "occupe" de "mort" — ce qu'aucun timeout d'inactivite/octets ne sait faire
// (le contrat Streamable HTTP n'envoie AUCUN octet pendant une action longue : la reponse arrive
// a la fin => inactivite != mort).
//
// Ce test ne spawn AUCUN process (transport factice en memoire) => pas de harness requis.

import { test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Backend } from '../src/backend.js';

// Faux transport en memoire, pilotable :
//  - repond TOUJOURS a initialize (le backend doit devenir ready) ;
//  - repond a `ping` SEULEMENT si answerPing=true (simule vivant vs fige) ;
//  - ne repond JAMAIS a tools/call (simule une action longue en vol / un backend qui hang).
class FakeTransport extends EventEmitter {
  constructor({ answerPing }) {
    super();
    this.answerPing = answerPing;
    this.spec = { command: 'x', args: [] };
    this.sent = [];
  }
  async start() {}
  send(msg) {
    this.sent.push(msg);
    if (msg.method === 'initialize') {
      queueMicrotask(() =>
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } },
        })
      );
      return;
    }
    if (msg.method === 'ping' && this.answerPing) {
      queueMicrotask(() => this.emit('message', { jsonrpc: '2.0', id: msg.id, result: {} }));
      return;
    }
    // tools/call (ou ping non honore) : SILENCE total => le backend attend.
  }
  async close() {
    this.emit('close');
  }
}

// Delais COURTS (injectes) : ~ maxMissed*interval + marges => detection < ~200ms en test.
const WD = { pingIntervalMs: 25, pingTimeoutMs: 20, maxMissedPings: 3 };

function waitFor(pred, ms = 1000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 10);
    };
    tick();
  });
}

const CLIENT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } };

test('watchdog: backend FIGE (aucune reponse au call NI aux pings) => la requete en vol recoit -32000, ne pend plus', async () => {
  const t = new FakeTransport({ answerPing: false });
  const b = new Backend('p', t, WD);
  const toClient = [];
  b.on('toClient', (m) => toClient.push(m));
  await b.start(CLIENT);

  b.forwardRequest({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'browser_navigate' } });

  const got = await waitFor(() => toClient.some((m) => m.id === 'call-1' && m.error));
  expect(got, 'la requete en vol DOIT recevoir une erreur (backend fige detecte par ping), pas pendre indefiniment').toBeTruthy();
  expect(toClient.find((m) => m.id === 'call-1' && m.error).error.code).toBe(-32000);
  b.stop();
});

test('watchdog: backend OCCUPE mais VIVANT (repond aux pings, tarde sur le call) => la requete NE doit PAS etre tuee', async () => {
  const t = new FakeTransport({ answerPing: true });
  const b = new Backend('p', t, WD);
  const toClient = [];
  b.on('toClient', (m) => toClient.push(m));
  await b.start(CLIENT);

  b.forwardRequest({ jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'browser_file_upload' } });

  // Laisse tourner PLUSIEURS cycles de ping (>> maxMissed*interval) : un backend qui repond
  // aux pings pendant une action longue ne doit JAMAIS etre coupe (protege l'upload 12 min).
  await new Promise((r) => setTimeout(r, WD.pingIntervalMs * 8));
  const killed = toClient.some((m) => m.id === 'call-2' && m.error);
  expect(killed, 'un backend qui repond aux pings ne doit jamais etre coupe (occupe != mort)').toBe(false);
  b.stop();
});

test('watchdog: AUCUNE requete en vol => aucun ping emis (pas de trafic inutile, spec: eviter le ping excessif)', async () => {
  const t = new FakeTransport({ answerPing: true });
  const b = new Backend('p', t, WD);
  await b.start(CLIENT);

  await new Promise((r) => setTimeout(r, WD.pingIntervalMs * 6));
  const pings = t.sent.filter((m) => m.method === 'ping').length;
  expect(pings, 'sans requete en vol, le watchdog ne doit pas pinger').toBe(0);
  b.stop();
});
