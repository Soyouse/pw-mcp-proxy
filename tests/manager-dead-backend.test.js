// Backend ZOMBIE dans le pool (bug live 2026-07-23, profil persistant partage) : le serveur partage est remplace
// => la session HTTP de ce proxy devient invalide => le transport emet 'error' (404) => le backend
// exit sig='error'. AVANT le fix, manager.get() re-`start()`ait le MEME Backend mort avec le MEME
// transport (sessionId perime) : le re-initialize echouait en 'error', avale par l'idempotence de
// _onExit (_exited deja true) => la promesse initialize ne se denouait JAMAIS => chaque appel MCP
// pendait 120 s en silence (log : double « session expiree (404) » sans « exited »).
// CONTRAT scelle ici : un backend exite ne se ranime JAMAIS — get() reconstruit backend + transport
// FRAIS (nouvelle session), et start() sur un backend exite REJETTE (fails-closed, jamais un pend).
// Transport factice en memoire : AUCUN process reel, pas de harness requis.

import { test, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.js';
import { Backend } from '../src/backend.js';

// Transport pilotable : vivant => repond a initialize ; mort (die()) => tout send declenche 'error'
// (simule le POST qui prend un 404 « session expiree » sur une session perimee).
class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.spec = { command: 'x', args: [] };
    this.dead = false;
    this.closed = false;
  }
  async start() {}
  die(reason = 'session expiree (404 GET)') {
    this.dead = true;
    this.emit('error', new Error(reason));
  }
  send(msg) {
    if (this.dead) {
      // comme http-transport._fail : l'echec remonte par l'event, jamais par un throw/une reponse
      queueMicrotask(() => this.emit('error', new Error('session expiree (404)')));
      return;
    }
    if (msg.method === 'initialize') {
      queueMicrotask(() =>
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } },
        })
      );
    }
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}

function tmpCfgPath() {
  const p = path.join(os.tmpdir(), `pw-mcp-deadbackend-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ defaultProfile: 'p', profiles: { p: { label: 'P' } } }));
  return p;
}

// get() DOIT se denouer vite : le bug etait justement une promesse eternelle => on borne.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      const h = setTimeout(() => rej(new Error(`${label}: pend >${ms}ms (le bug exact)`)), ms);
      h.unref?.();
    }),
  ]);
}

let cfgPath;
let manager;
let transports;

beforeEach(() => {
  cfgPath = tmpCfgPath();
  transports = [];
  manager = new Manager(cfgPath, { watchdog: { pingIntervalMs: 0 } }); // watchdog OFF : on teste l'exit, pas le gel
  manager._makeTransport = async () => {
    const t = new FakeTransport();
    transports.push(t);
    return t;
  };
});

afterEach(() => {
  manager.stopAll();
  try { fs.unlinkSync(cfgPath); } catch {}
});

test('backend exite (transport error) => get() reconstruit backend + transport FRAIS, jamais un pend', async () => {
  const b1 = await manager.get('p');
  expect(b1.ready).toBe(true);

  // Le serveur partage est remplace : la session meurt => exit sig='error'.
  transports[0].die();
  await new Promise((r) => setTimeout(r, 10));
  expect(b1.ready, 'b1 doit etre tombe').toBe(false);

  // AVANT le fix : get() re-start le MEME backend mort => initialize avale => pend eternel.
  const b2 = await withTimeout(manager.get('p'), 1000, 'get() apres exit');
  expect(b2, 'un NOUVEAU backend doit remplacer le mort, jamais le meme objet ranime').not.toBe(b1);
  expect(b2.ready).toBe(true);
  expect(transports.length, 'un transport FRAIS doit avoir ete cree (nouvelle session)').toBe(2);
  expect(transports[0].closed, 'le transport mort doit etre clos (DELETE session best-effort)').toBe(true);
});

test('stop() volontaire puis get() => backend frais aussi (un exite ne se ranime jamais, quel que soit le sig)', async () => {
  const b1 = await manager.get('p');
  b1.stop(); // 'close' => _exited
  const b2 = await withTimeout(manager.get('p'), 1000, 'get() apres stop');
  expect(b2).not.toBe(b1);
  expect(b2.ready).toBe(true);
  expect(transports.length).toBe(2);
});

test('start() sur un backend deja exite REJETTE immediatement (fails-closed, jamais un pend)', async () => {
  const t = new FakeTransport();
  const b = new Backend('p', t, { pingIntervalMs: 0 });
  await b.start({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  t.die();
  await new Promise((r) => setTimeout(r, 10));
  await expect(
    withTimeout(b.start({ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }), 1000, 're-start')
  ).rejects.toThrow(/exit/i);
});
