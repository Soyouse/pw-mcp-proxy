// Auto-restart (COUCHE 2b) : le manager recycle TOUT SEUL un backend declare 'unresponsive' par le
// watchdog (backend.js), avec garde anti-boucle (auto-restart.js, PUR) + alerte dead-man (notify.js).
// Transport FACTICE en memoire (comme backend-watchdog.test.js) : AUCUN process reel spawne, pas de
// harness requis.
//
// SCOPE COUVERT :
//  1) unresponsive => restartProfile declenche automatiquement (nouveau backend remplace l'ancien).
//  2) unresponsive en boucle (> maxRestarts dans la fenetre) => alert() appelee, PAS de restart de plus.
//  3) stop() volontaire (emet 'close', jamais 'unresponsive') => AUCUN auto-restart declenche.

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.js';
import * as notify from '../src/notify.js';

// Meme fixture qu'en watchdog unit : pilotable, jamais de vrai process.
class FakeTransport extends EventEmitter {
  constructor({ answerPing = true } = {}) {
    super();
    this.answerPing = answerPing;
    this.spec = { command: 'x', args: [] };
    this.sent = [];
    this.closed = false;
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
    // tools/call (ou ping non honore) : silence => simule l'action en vol qui pend.
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}

const WD = { pingIntervalMs: 15, pingTimeoutMs: 10, maxMissedPings: 2 }; // detection ~<100ms

function tmpCfgPath() {
  const p = path.join(os.tmpdir(), `pw-mcp-autorestart-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ defaultProfile: 'p', profiles: { p: { label: 'P' } } }));
  return p;
}

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

let cfgPath;
let manager;
let transports; // transports crees, dans l'ordre (permet d'inspecter/piloter chaque backend successif)

beforeEach(() => {
  cfgPath = tmpCfgPath();
  transports = [];
  manager = new Manager(cfgPath, { watchdog: WD, autoRestart: { maxRestarts: 2, windowMs: 500 } });
  // Bypass total du vrai spawn (stdio/http) : transport factice pilotable, AUCUN process reel.
  manager._makeTransport = async () => {
    const t = new FakeTransport({ answerPing: false }); // par defaut : fige (ne repond pas au ping)
    transports.push(t);
    return t;
  };
});

afterEach(() => {
  manager.stopAll();
  try { fs.unlinkSync(cfgPath); } catch {}
  vi.restoreAllMocks();
});

test('1) unresponsive => auto-restart declenche automatiquement (nouveau backend remplace l ancien)', async () => {
  const b1 = await manager.get('p');
  expect(manager.backends.get('p')).toBe(b1);

  // b1 ne repond ni aux tools/call ni aux pings => le watchdog va le declarer 'unresponsive'.
  b1.forwardRequest({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: {} });

  // Le prochain _makeTransport() (appele par le respawn) doit repondre normalement pour re-devenir ready.
  const ok = await waitFor(() => manager.backends.get('p') && manager.backends.get('p') !== b1 && manager.backends.get('p').ready);
  expect(ok, 'un nouveau backend ready DOIT avoir remplace le backend fige, sans intervention manuelle').toBe(true);
  expect(transports.length, 'exactement 1 respawn (2 transports crees : original + remplacant)').toBe(2);
});

test('2) unresponsive EN BOUCLE (> maxRestarts dans la fenetre) => alert() appelee, restart supplementaire SUSPENDU', async () => {
  const alertSpy = vi.spyOn(notify, 'alert').mockImplementation(() => {});
  // maxRestarts=2 : les 2 premiers unresponsive doivent restart, le 3e doit etre REFUSE + alert.
  let b = await manager.get('p');
  const seen = new Set([b]);

  for (let i = 0; i < 3; i++) {
    const cur = manager.backends.get('p');
    cur.forwardRequest({ jsonrpc: '2.0', id: `call-${i}`, method: 'tools/call', params: {} });
    await waitFor(() => manager.backends.get('p') !== cur || alertSpy.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20)); // laisse le respawn/alert se stabiliser
  }

  expect(alertSpy, 'la boucle DOIT etre signalee bruyamment (dead-man), pas silencieuse').toHaveBeenCalled();
  const msg = alertSpy.mock.calls.map((c) => String(c[0])).join(' | ');
  expect(/boucle|suspendu/i.test(msg), 'message actionnable mentionnant la boucle/suspension').toBe(true);
  // au plus maxRestarts(=2) respawns effectifs => au plus 3 transports (original + 2 respawns).
  expect(transports.length <= 3, `pas plus de maxRestarts respawns (transports=${transports.length})`).toBe(true);
});

test('3) stop() volontaire (emet close, jamais unresponsive) => AUCUN auto-restart declenche', async () => {
  const b1 = await manager.get('p');
  b1.stop(); // arret volontaire => transport.close() => 'close', PAS 'unresponsive'

  await new Promise((r) => setTimeout(r, 100)); // laisse largement le temps a un faux-positif d'apparaitre
  // stop() ne retire PAS l'entree du pool (c'est restartProfile()/_reconcile() qui gerent le pool) ;
  // ce qui compte : AUCUN respawn automatique déclenché (le backend reste l'INSTANCE stoppee, pas ready).
  expect(manager.backends.get('p'), 'meme instance : pas de remplacement automatique').toBe(b1);
  expect(manager.backends.get('p').ready, 'backend reste stoppe, pas ready').toBe(false);
  expect(transports.length, 'aucun respawn : un seul transport cree').toBe(1);
});
