// tests/harness.test.js — NEGATIVE-CHECK du harnais anti-fuite : prouve que le ratchet TUE réellement.
// Sans ce test, le harnais pourrait être creux (un reap qui ne tue rien passerait inaperçu).
// On vérifie les DEUX chemins : (1) process tracké via spawnTracked, (2) process ORPHELIN non tracké
// mais marqué (simule le serveur détaché spawné par le CODE = la vraie cause de la fuite 9639/9698).

import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import process from 'node:process';
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
