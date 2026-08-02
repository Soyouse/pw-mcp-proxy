// tests/harness.test.js — NEGATIVE-CHECK du harnais anti-fuite : prouve que le ratchet TUE réellement.
// Sans ce test, le harnais pourrait être creux (un reap qui ne tue rien passerait inaperçu).
// On vérifie les DEUX chemins : (1) process tracké via spawnTracked, (2) process ORPHELIN non tracké
// mais marqué (simule le serveur détaché spawné par le CODE = la vraie cause de la fuite 9639/9698).

import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Le port repond-il ? Question au NOYAU — jamais « le process a l air lance ». */
const portOuvert = (port) => new Promise((r) => {
  const s = net.connect(port, 'localhost');
  const fin = (v) => { s.destroy(); r(v); };
  s.on('connect', () => fin(true));
  s.on('error', () => fin(false));
});
import { spawnTracked, reapAll, isPidAlive, survivors, PROC_MARK } from './harness.js';

const SLEEP = ['-e', 'setTimeout(() => {}, 60000)']; // process node qui vit 60s sauf si tué

async function untilDead(pid, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('ratchet : un process TRACKÉ (spawnTracked) est bien tué par reapAll', async () => {
  const child = spawnTracked(SLEEP, { stdio: 'ignore' });
  expect(isPidAlive(child.pid), 'le sleeper tracké est vivant').toBeTruthy();
  reapAll();
  expect(await untilDead(child.pid), 'reapAll a tué le process tracké').toBeTruthy();
});

test('ratchet : un ORPHELIN marqué mais NON tracké est retrouvé et tué (scan cmdline)', async () => {
  // Spawn RAW (hors harnais) portant le marqueur = imite un serveur détaché laissé par le CODE.
  // Le Set `tracked` ne le connaît PAS : seul le scan par marqueur du ratchet peut l'attraper.
  const orphan = spawn(process.execPath, [...SLEEP, PROC_MARK], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  orphan.unref();
  expect(await untilAlive(orphan.pid), 'orphelin marqué démarré').toBeTruthy();
  // ROUGE : la DÉTECTION du ratchet VOIT la fuite (sans ça, le gate serait aveugle => zombie silencieux).
  expect(
    (await untilDetected(orphan.pid)),
    'survivors() détecte l orphelin marqué = le ratchet aurait échoué ROUGE (fuite vue)'
  ).toBeTruthy();
  reapAll(); // VERT : doit le retrouver via listProcesses().includes(PROC_MARK) et le tuer
  expect(await untilDead(orphan.pid), 'le ratchet a tué l orphelin marqué non tracké').toBeTruthy();
  expect(survivors().length, 'plus aucun survivant marqué après reap').toBe(0);
});

async function untilDetected(pid, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (survivors().some((s) => s.pid === pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function untilAlive(pid, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// 🛑 LE TROU QUE LE RATCHET NE VOIT PAS : une fixture lancée A LA MAIN (hors harnais) n'est pas
// marquée, donc invisible du ratchet, donc elle SURVIT indéfiniment. Vécu le 02/08 — un faux
// backend oublié 1 h après une sonde manuelle, découvert par hasard.
// La parade n'est pas une consigne mais un REFUS AU DÉMARRAGE, prouvé ici dans les deux sens.
test('FIXTURE LANCÉE HORS TEST : refus immédiat, aucun process qui traîne', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'fake-backend.js');
  // ⚠️ Environnement SANS `PWMCP_TEST` : on simule exactement une commande tapée à la main.
  const env = { ...process.env };
  delete env.PWMCP_TEST;
  delete env.PWMCP_FIXTURE_MANUELLE;
  const p = spawn(process.execPath, [fixture, '--tag', 'X', '--host', 'localhost', '--port', '39901'], {
    stdio: ['ignore', 'ignore', 'pipe'], env,
  });
  let err = '';
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((r) => p.on('exit', r));

  expect(code, 'code de sortie DISTINCT (3) : reconnaissable, jamais confondu avec un succès').toBe(3);
  expect(err, "le message doit dire QUOI FAIRE, pas seulement refuser").toMatch(/PWMCP_FIXTURE_MANUELLE/);
  expect(await portOuvert(39901), "RIEN ne doit avoir été ouvert : on refuse AVANT tout descripteur").toBe(false);
}, 20000);

// NEGATIVE-CHECK du garde-fou lui-même : sous test, la fixture DOIT démarrer normalement.
// Sans ce test, un verrou trop strict casserait toute la suite sans qu'on sache pourquoi.
test('FIXTURE SOUS TEST : démarre normalement (le garde-fou ne bloque pas le cas légitime)', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'fake-backend.js');
  const p = spawnTracked([fixture, '--tag', 'X', '--host', 'localhost', '--port', '39902'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const t0 = Date.now();
  let ouvert = false;
  while (Date.now() - t0 < 15000 && !(ouvert = await portOuvert(39902))) {
    await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
  }
  expect(ouvert, 'sous harnais, la fixture doit servir normalement').toBe(true);
  p.kill();
}, 20000);
