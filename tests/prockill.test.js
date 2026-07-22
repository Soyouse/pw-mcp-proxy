// Test unite prockill : le coeur du fix leak P0 (tree-kill + sweep par user-data-dir).
// ⚠️ On NE teste JAMAIS avec un needle generique ('node', 'chrome') : ce serait tuer des
// process legitimes de la machine. Chaque test spawn ses propres sleepers avec un marqueur
// UNIQUE (pid-based) et ne balaie QUE ce marqueur.

import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { sweepByCmd, isPidAlive, treeKill } from '../src/prockill.js';

const onWin = process.platform === 'win32';

// process node inerte qui porte `marker` dans sa ligne de commande (pour etre matchable).
function sleeper(marker) {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker], {
    stdio: 'ignore',
    windowsHide: true,
    detached: !onWin,
  });
}

async function until(pred, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('sweepByCmd tue le process matchant et epargne les autres (self jamais tue)', async () => {
  const markA = `PWKILLMARK_${process.pid}_AAA`;
  const markB = `PWKILLMARK_${process.pid}_BBB`;
  const a = sleeper(markA);
  const b = sleeper(markB);
  try {
    expect(await until(() => a.pid && b.pid), 'les deux sleepers ont un pid').toBeTruthy();
    // laisser la table des process se peupler
    await new Promise((r) => setTimeout(r, 400));

    const killed = sweepByCmd([markA]);
    expect(killed.includes(a.pid), 'A (matchant markA) est balaye').toBeTruthy();
    expect(!killed.includes(b.pid), 'B (marqueur different) est epargne').toBeTruthy();
    expect(!killed.includes(process.pid), 'le process courant (self) n est jamais balaye').toBeTruthy();

    expect(await until(() => !isPidAlive(a.pid)), 'A est mort').toBeTruthy();
    expect(isPidAlive(b.pid), 'B toujours vivant').toBeTruthy();
  } finally {
    treeKill(a.pid);
    treeKill(b.pid);
  }
});

test('sweepByCmd needles vide = no-op (aucune enumeration, rien tue)', () => {
  expect(sweepByCmd([])).toEqual([]);
  expect(sweepByCmd([null, '', undefined])).toEqual([]);
});

test('treeKill(pid) tue reellement le process', async () => {
  const mark = `PWKILLMARK_${process.pid}_TK`;
  const c = sleeper(mark);
  try {
    expect(await until(() => !!c.pid)).toBeTruthy();
    treeKill(c.pid);
    expect(await until(() => !isPidAlive(c.pid)), 'le process est bien mort apres treeKill').toBeTruthy();
  } finally {
    treeKill(c.pid);
  }
});

test('isPidAlive : faux pour un pid inexistant, vrai pour self', () => {
  expect(isPidAlive(0)).toBe(false);
  expect(isPidAlive(2 ** 30)).toBe(false); // pid quasi certainement libre
  expect(isPidAlive(process.pid)).toBe(true);
});
