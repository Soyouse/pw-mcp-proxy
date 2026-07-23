// FORENSIQUE de gel (anti-régression, exigence Théo « ne jamais rester dans l'ignorance ») : quand le
// watchdog déclare un backend « unresponsive », le manager DOIT écrire un rapport [FREEZE] riche
// (via freeze-report, PUR) — profil + requête en vol au minimum. Ce test scelle que le rapport est
// TOUJOURS émis sur un gel, et jamais vide. Transport FACTICE en mémoire : aucun vrai process.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock du logger AVANT import du manager : on capture chaque ligne loguée (log() est le seul canal).
vi.mock('../src/logger.js', () => ({ log: vi.fn() }));
import { log } from '../src/logger.js';
import { Manager } from '../src/manager.js';

class FakeTransport extends EventEmitter {
  constructor() { super(); this.spec = { command: 'x', args: [] }; }
  async start() {}
  send(msg) {
    if (msg.method === 'initialize') {
      queueMicrotask(() => this.emit('message', { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }));
    }
    // ping + tools/call : SILENCE => le watchdog va déclarer le backend figé (unresponsive) => 'freeze'.
  }
  async close() { this.emit('close'); }
}

const WD = { pingIntervalMs: 15, pingTimeoutMs: 10, maxMissedPings: 2 };
let cfgPath, manager;

beforeEach(() => {
  cfgPath = path.join(os.tmpdir(), `pw-mcp-freeze-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ defaultProfile: 'p', profiles: { p: { label: 'P' } } }));
  manager = new Manager(cfgPath, { watchdog: WD, autoRestart: { maxRestarts: 0, windowMs: 500 } }); // maxRestarts:0 => pas de respawn, on isole le rapport
  manager._makeTransport = async () => new FakeTransport();
  log.mockClear();
});
afterEach(() => { manager.stopAll(); try { fs.unlinkSync(cfgPath); } catch {} vi.restoreAllMocks(); });

function freezeLines() {
  return log.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('[FREEZE]'));
}
function waitFor(pred, ms = 1000) {
  return new Promise((res) => { const t0 = Date.now(); const tick = () => (pred() ? res(true) : Date.now() - t0 > ms ? res(false) : setTimeout(tick, 10)); tick(); });
}

test('gel détecté => un rapport [FREEZE] est TOUJOURS émis, avec le profil et le tool en vol', async () => {
  const b = await manager.get('p');
  // une requête tools/call en vol (browser_navigate) : le watchdog démarre et va la déclarer figée.
  b.forwardRequest({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'browser_navigate' } });

  const got = await waitFor(() => freezeLines().length > 0);
  expect(got, 'un rapport [FREEZE] DOIT être émis sur un gel').toBe(true);
  const report = freezeLines().join('\n');
  expect(report).toContain('profil="p"');
  expect(report).toContain('browser_navigate'); // la requête en vol est identifiée (pas un rapport vide)
});

test('rapport jamais vide : mentionne l etat browser (inconnu ici, profil stdio sans userDataDir)', async () => {
  const b = await manager.get('p');
  b.forwardRequest({ jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'browser_snapshot' } });
  await waitFor(() => freezeLines().length > 0);
  const report = freezeLines().join('\n');
  expect(report).toContain('browser:'); // ligne d'etat browser toujours presente
  expect(report).toContain('watchdog: pings_rates'); // le compteur de pings est reporte
});
