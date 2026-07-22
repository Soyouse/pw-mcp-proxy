// Integration supervisor.js (I/O reel : spawn du faux serveur HTTP, verrou fichier, reap tree-kill).
// Prouve le cycle de vie MULTI-AGENT : un serveur partage par profil, adopte par les proxys suivants,
// garde tant qu'un client bat le coeur, reape (tue) quand plus personne.

import { test, beforeAll, afterAll, beforeEach, expect } from 'vitest';
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
// ⚠️ ISOLATION DE PORT : le port d'un profil est DÉTERMINISTE (derivePort, hash du nom). Réutiliser le
// MÊME nom de profil entre tests => MÊME port => un fixture agonisant (run précédent / test précédent)
// squatte le port au boot du suivant => _pollReady voit l'ancien répondre => pid mort enregistré (flake
// intermittent du 1er ensureServer). Un NOM UNIQUE par test => port unique => zéro collision (intra ET
// inter-run). NE JAMAIS revenir à un littéral de profil partagé dans un test qui spawn un serveur.
let profSeq = 0;
const prof = () => `sup${process.pid}-${++profSeq}`;

beforeAll(() => { cfgPath = path.join(os.tmpdir(), `pw-mcp-sup-${process.pid}.json`); });
beforeEach(() => {
  // registre/verrou propres a chaque test (isolation)
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});
afterAll(async () => {
  // Kill des serveurs DÉTACHÉS + assertion zéro survivant = garantis par le ratchet du harnais
  // (les serveurs portent le marqueur via taggedArgs). Ici : ref-count + fichiers temp seulement.
  for (const s of spawned) { try { await s.shutdown(); } catch {} }
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});

test('ensureServer : spawn un serveur, il repond, il est enregistre', async () => {
  const P = prof();
  const sup = newSup();
  const url = await sup.ensureServer(P, SPEC);
  expect(url).toMatch(/^http:\/\/localhost:\d+\/mcp$/); // URL client documentee (localhost)
  const entry = serverEntry(readReg(sup), P);
  expect(entry && isPidAlive(entry.pid), 'pid enregistre et vivant').toBeTruthy();
  expect(await sup._probeReady(entry.port), 'le serveur repond').toBe(true);
});

test('ensureServer : 2e appel (autre proxy) ADOPTE le meme serveur (zero 2e spawn)', async () => {
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const urlA = await a.ensureServer(P, SPEC);
  const pidA = serverEntry(readReg(a), P).pid;
  const urlB = await b.ensureServer(P, SPEC);
  const pidB = serverEntry(readReg(b), P).pid;
  expect(urlA, 'meme URL').toBe(urlB);
  expect(pidA, 'MEME serveur (pid inchange) : adoption, pas de 2e spawn').toBe(pidB);
});

test('ensureServer concurrent (2 proxys en parallele) => UN SEUL serveur', async () => {
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const [u1, u2] = await Promise.all([a.ensureServer(P, SPEC), b.ensureServer(P, SPEC)]);
  expect(u1, 'course serialisee par le verrou : une seule URL').toBe(u2);
  const entry = serverEntry(readReg(a), P);
  expect(entry && isPidAlive(entry.pid)).toBeTruthy();
});

test('verrou PERIME + 2 proxys concurrents => vol serialise, UN SEUL serveur', async () => {
  // Ancrage empirique (trace) du protocole prouve par spec/SupervisorLock.tla (config Fixed) :
  // on seme un verrou PERIME (proxy mort en le tenant), puis 2 proxys foncent en meme temps.
  // Le vol serialise (meta-verrou + re-verif) DOIT garantir UN SEUL serveur (pas de double spawn).
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  fs.writeFileSync(a.lockPath, '999999'); // pid bidon d'un "proxy mort" tenant le verrou
  const old = Date.now() / 1000 - 120; // mtime vieux de 120s > LOCK_STALE_MS (60s) => perime
  fs.utimesSync(a.lockPath, old, old);
  const [u1, u2] = await Promise.all([a.ensureServer(P, SPEC), b.ensureServer(P, SPEC)]);
  expect(u1, 'verrou perime vole SANS course : une seule URL').toBe(u2);
  const entry = serverEntry(readReg(a), P);
  expect(entry && isPidAlive(entry.pid), 'un seul serveur vivant enregistre').toBeTruthy();
  expect(fs.existsSync(a.lockPath), 'verrou relache a la fin (perime vole puis libere)').toBe(false);
});

test('reap : serveur SANS client vivant (ttl court) est tue et retire', async () => {
  const P = prof();
  const sup = newSup({ ttl: 1, clientId: 'solo' }); // ttl=1ms => idle immediat
  await sup.ensureServer(P, SPEC);
  const entry = serverEntry(readReg(sup), P);
  await new Promise((r) => setTimeout(r, 20)); // depasse le ttl
  await sup.reap();
  expect(serverEntry(readReg(sup), P), 'retire du registre').toBe(null);
  expect(await waitFor(async () => !isPidAlive(entry.pid)), 'process tue (tree-kill)').toBeTruthy();
});

test('reap : serveur AVEC heartbeat frais est GARDE', async () => {
  const P = prof();
  const sup = newSup({ ttl: 60000, clientId: 'live' });
  await sup.ensureServer(P, SPEC);
  const entry = serverEntry(readReg(sup), P);
  sup.registerClient(P); // heartbeat frais
  await sup.reap();
  // ⚠️ Si ROUGE ici avec pid mort : le fixture s'est auto-terminé (socket reset du probe non géré = crash).
  // Cf fake-http-server (handlers d'erreur socket). Le reap ne fait que constater un pid déjà mort.
  expect(serverEntry(readReg(sup), P), `garde dans le registre (pid=${entry.pid} alive=${isPidAlive(entry.pid)})`).toBeTruthy();
  expect(isPidAlive(entry.pid), 'toujours vivant').toBe(true);
  await sup.unregisterClient(P);
});

test('boot-reap : entree au pid MORT est purgee', async () => {
  const sup = newSup({ ttl: 60000 });
  // injecte une entree fantome (pid mort quasi-sur) directement dans le registre
  const dead = { servers: { ghost: { port: 9999, pid: 999999, spawnedAt: 0, clients: { x: Date.now() } } } };
  fs.writeFileSync(sup.registryPath, JSON.stringify(dead));
  await sup.reap();
  expect(serverEntry(readReg(sup), 'ghost'), 'entree morte retiree au boot-reap').toBe(null);
});

test('unregisterClient : retire mon heartbeat du registre', async () => {
  const P = prof();
  const sup = newSup({ ttl: 60000, clientId: 'me' });
  await sup.ensureServer(P, SPEC);
  sup.registerClient(P);
  expect(serverEntry(readReg(sup), P).clients.me, 'enregistre').toBeTruthy();
  await sup.unregisterClient(P);
  expect(serverEntry(readReg(sup), P).clients.me, 'retire').toBeUndefined();
});
