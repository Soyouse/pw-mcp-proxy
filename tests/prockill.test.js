// Test unite prockill : le coeur du fix leak P0 (tree-kill + sweep par user-data-dir).
// ⚠️ On NE teste JAMAIS avec un needle generique ('node', 'chrome') : ce serait tuer des
// process legitimes de la machine. Chaque test spawn ses propres sleepers avec un marqueur
// UNIQUE (pid-based) et ne balaie QUE ce marqueur.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(await until(() => a.pid && b.pid), 'les deux sleepers ont un pid');
    // laisser la table des process se peupler
    await new Promise((r) => setTimeout(r, 400));

    const killed = sweepByCmd([markA]);
    assert.ok(killed.includes(a.pid), 'A (matchant markA) est balaye');
    assert.ok(!killed.includes(b.pid), 'B (marqueur different) est epargne');
    assert.ok(!killed.includes(process.pid), 'le process courant (self) n est jamais balaye');

    assert.ok(await until(() => !isPidAlive(a.pid)), 'A est mort');
    assert.ok(isPidAlive(b.pid), 'B toujours vivant');
  } finally {
    treeKill(a.pid);
    treeKill(b.pid);
  }
});

test('sweepByCmd needles vide = no-op (aucune enumeration, rien tue)', () => {
  assert.deepEqual(sweepByCmd([]), []);
  assert.deepEqual(sweepByCmd([null, '', undefined]), []);
});

test('treeKill(pid) tue reellement le process', async () => {
  const mark = `PWKILLMARK_${process.pid}_TK`;
  const c = sleeper(mark);
  try {
    assert.ok(await until(() => !!c.pid));
    treeKill(c.pid);
    assert.ok(await until(() => !isPidAlive(c.pid)), 'le process est bien mort apres treeKill');
  } finally {
    treeKill(c.pid);
  }
});

test('isPidAlive : faux pour un pid inexistant, vrai pour self', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(2 ** 30), false); // pid quasi certainement libre
  assert.equal(isPidAlive(process.pid), true);
});
