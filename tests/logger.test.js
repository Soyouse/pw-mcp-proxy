// Test d'INTÉGRATION de la rotation RÉELLE (I/O disque) de logger.js.
// Prouve la BORNE DURE : sous écriture continue, le nombre de fichiers et la taille du fichier
// courant restent bornés (jamais de croissance infinie = fuite disque). Aucun process spawné.

import { test, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLogger, log } from '../src/logger.js';

const base = path.join(os.tmpdir(), `pw-mcp-logtest-${process.pid}-${Math.floor(performance.now())}.log`);

function cleanup() {
  for (const suffix of ['', '.1', '.2', '.3', '.4']) {
    try { fs.unlinkSync(base + suffix); } catch {}
  }
}
afterEach(cleanup);

test('rotation : sous écriture continue, la borne (maxFiles générations) est respectée + fichier courant borné', () => {
  const maxBytes = 200;
  const maxFiles = 3; // => base + base.1 + base.2 au MAXIMUM, jamais base.3
  initLogger(base, { maxBytes, maxFiles });

  for (let i = 0; i < 200; i++) log(`ligne de log numero ${i} avec un peu de contenu pour peser`);

  expect(fs.existsSync(base), 'le fichier courant existe').toBeTruthy();
  expect(fs.existsSync(base + '.1'), 'une archive .1 a été produite (rotation a bien eu lieu)').toBeTruthy();
  expect(fs.existsSync(base + '.2'), 'une archive .2 a été produite').toBeTruthy();
  expect(!fs.existsSync(base + '.3'), 'BORNE : aucune génération au-delà de maxFiles (pas de fuite disque)').toBeTruthy();

  // Le fichier courant ne dépasse jamais maxBytes de plus d'UNE ligne (on rote AVANT d'écrire).
  const sizeCur = fs.statSync(base).size;
  const oneLine = Buffer.byteLength(`[${new Date().toISOString()}] ligne de log numero 999 avec un peu de contenu pour peser\n`);
  expect(sizeCur <= maxBytes + oneLine, `fichier courant borné (${sizeCur} <= ${maxBytes}+1 ligne)`).toBeTruthy();
});

test('rotation désactivée (maxBytes=0) : aucune archive, un seul fichier qui grossit', () => {
  initLogger(base, { maxBytes: 0, maxFiles: 3 });
  for (let i = 0; i < 100; i++) log(`x${i}`);
  expect(fs.existsSync(base), 'le fichier existe').toBeTruthy();
  expect(!fs.existsSync(base + '.1'), 'maxBytes=0 => rotation désactivée => aucune archive').toBeTruthy();
});
