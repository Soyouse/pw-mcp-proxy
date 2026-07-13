// Integration supervisor.js (I/O reel : spawn du faux serveur HTTP, verrou fichier, reap tree-kill).
// Prouve le cycle de vie MULTI-AGENT : un serveur partage par profil, adopte par les proxys suivants,
// garde tant qu'un client bat le coeur, reape (tue) quand plus personne.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.js';
import { isPidAlive } from '../src/prockill.js';
import { serverEntry } from '../src/server-registry.js';
import { taggedArgs } from './harness.js'; // ⚠️ marque les serveurs spawnés par le CODE => ratchet anti-fuite

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-http-server.js');
// Le SUPERVISEUR spawne ces serveurs (détachés, par design) ; taggedArgs y injecte le marqueur de suite
// pour que le ratchet du harnais les retrouve et échoue ROUGE si l'un survit (cause de la fuite 9639/9698).
const SPEC = { command: process.execPath, args: taggedArgs([FAKE]) };

let cfgPath;
const spawned = [];

function newSup(opts) {
  const s = new Supervisor(cfgPath, opts);
  spawned.push(s);
  return s;
}
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
function readReg(s) {
  try { return JSON.parse(fs.readFileSync(s.registryPath, 'utf8')); } catch { return { servers: {} }; }
}

before(() => { cfgPath = path.join(os.tmpdir(), `pw-mcp-sup-${process.pid}.json`); });
beforeEach(() => {
  // registre/verrou propres a chaque test (isolation)
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});
after(async () => {
  // Kill des serveurs DÉTACHÉS + assertion zéro survivant = garantis par le ratchet du harnais
  // (les serveurs portent le marqueur via taggedArgs). Ici : ref-count + fichiers temp seulement.
  for (const s of spawned) { try { await s.shutdown(); } catch {} }
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});

test('ensureServer : spawn un serveur, il repond, il est enregistre', async () => {
  const sup = newSup();
  const url = await sup.ensureServer('vegeta', SPEC);
  assert.match(url, /^http:\/\/localhost:\d+\/mcp$/); // URL client documentee (localhost)
  const entry = serverEntry(readReg(sup), 'vegeta');
  assert.ok(entry && isPidAlive(entry.pid), 'pid enregistre et vivant');
  assert.equal(await sup._probeReady(entry.port), true, 'le serveur repond');
});

test('ensureServer : 2e appel (autre proxy) ADOPTE le meme serveur (zero 2e spawn)', async () => {
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const urlA = await a.ensureServer('vegeta', SPEC);
  const pidA = serverEntry(readReg(a), 'vegeta').pid;
  const urlB = await b.ensureServer('vegeta', SPEC);
  const pidB = serverEntry(readReg(b), 'vegeta').pid;
  assert.equal(urlA, urlB, 'meme URL');
  assert.equal(pidA, pidB, 'MEME serveur (pid inchange) : adoption, pas de 2e spawn');
});

test('ensureServer concurrent (2 proxys en parallele) => UN SEUL serveur', async () => {
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const [u1, u2] = await Promise.all([a.ensureServer('perso', SPEC), b.ensureServer('perso', SPEC)]);
  assert.equal(u1, u2, 'course serialisee par le verrou : une seule URL');
  const entry = serverEntry(readReg(a), 'perso');
  assert.ok(entry && isPidAlive(entry.pid));
});

test('reap : serveur SANS client vivant (ttl court) est tue et retire', async () => {
  const sup = newSup({ ttl: 1, clientId: 'solo' }); // ttl=1ms => idle immediat
  await sup.ensureServer('vegeta', SPEC);
  const entry = serverEntry(readReg(sup), 'vegeta');
  await new Promise((r) => setTimeout(r, 20)); // depasse le ttl
  await sup.reap();
  assert.equal(serverEntry(readReg(sup), 'vegeta'), null, 'retire du registre');
  assert.ok(await waitFor(async () => !isPidAlive(entry.pid)), 'process tue (tree-kill)');
});

test('reap : serveur AVEC heartbeat frais est GARDE', async () => {
  const sup = newSup({ ttl: 60000, clientId: 'live' });
  await sup.ensureServer('vegeta', SPEC);
  const entry = serverEntry(readReg(sup), 'vegeta');
  const aliveAfterEnsure = isPidAlive(entry.pid); // DIAG : false => false-ready (port squatté par un serveur d'un test précédent)
  sup.registerClient('vegeta'); // heartbeat frais
  await sup.reap();
  assert.ok(
    serverEntry(readReg(sup), 'vegeta'),
    `garde dans le registre [DIAG pid=${entry.pid} port=${entry.port} aliveAfterEnsure=${aliveAfterEnsure} aliveNow=${isPidAlive(entry.pid)}]`
  );
  assert.equal(isPidAlive(entry.pid), true, 'toujours vivant');
  await sup.unregisterClient('vegeta');
});

test('boot-reap : entree au pid MORT est purgee', async () => {
  const sup = newSup({ ttl: 60000 });
  // injecte une entree fantome (pid mort quasi-sur) directement dans le registre
  const dead = { servers: { ghost: { port: 9999, pid: 999999, spawnedAt: 0, clients: { x: Date.now() } } } };
  fs.writeFileSync(sup.registryPath, JSON.stringify(dead));
  await sup.reap();
  assert.equal(serverEntry(readReg(sup), 'ghost'), null, 'entree morte retiree au boot-reap');
});

test('unregisterClient : retire mon heartbeat du registre', async () => {
  const sup = newSup({ ttl: 60000, clientId: 'me' });
  await sup.ensureServer('vegeta', SPEC);
  sup.registerClient('vegeta');
  assert.ok(serverEntry(readReg(sup), 'vegeta').clients.me, 'enregistre');
  await sup.unregisterClient('vegeta');
  assert.equal(serverEntry(readReg(sup), 'vegeta').clients.me, undefined, 'retire');
});
