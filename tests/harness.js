// tests/harness.js — HARNAIS CENTRAL DE TEST (source UNIQUE du spawn tracké + teardown garanti + ratchet).
//
// RAISON D'ETRE : un test qui spawn un process (proxy, faux serveur, sleeper) et ne le tue pas
// laisse un ZOMBIE qui squatte un port/lock et fait planter la session suivante EN SILENCE
// (constaté live 13/07 : fixtures fake-http-server survivantes sur 9639/9698 -> reconnexion MCP timeout).
// Cause de fond = process spawnés (parfois DÉTACHÉS par design multi-agent) non tracés centralement,
// + teardown ad-hoc par fichier qui rate les process hors de sa vue (registre effacé, grandchild, throw).
//
// NORME PRO 2026 (nodebestpractices / child_process docs) : tracker central de TOUT process spawné,
// teardown explicite, filets signaux, ZÉRO confiance au cleanup implicite d'une lib.
// COUCHE MAISON par-dessus = le RATCHET : après reap, on SCANNE la table des process et on ÉCHOUE le
// fichier ROUGE s'il reste un seul survivant marqué. Une fuite devient bruyante au CI, jamais un zombie
// découvert à la main. NE JAMAIS affaiblir le ratchet (le rendre non-bloquant = revenir au bug d'origine).
//
// ⚠️ RÈGLE ABSOLUE DU PROJET : tout test qui lance un process passe par spawnTracked() (process spawné
//    DIRECTEMENT) OU par taggedArgs() (process spawné par le CODE sous test, ex superviseur).
//    JAMAIS `child_process.spawn` nu dans un test : il échappe au tracker ET au ratchet.

import { spawn } from 'node:child_process';
import { afterAll } from 'vitest';
import assert from 'node:assert/strict';
import process from 'node:process';
import { treeKill, isPidAlive, listProcesses } from '../src/prockill.js';

const onWin = process.platform === 'win32';

// Marqueur UNIQUE de CE process runner. `node --test` lance chaque FICHIER dans son propre process
// (pids distincts) => les fichiers tournant en parallèle n'interfèrent pas : chaque ratchet ne voit
// QUE ses propres process marqués. Injecté comme token argv (visible dans la cmdline => scannable).
export const PROC_MARK = `PWMCP_TEST_${process.pid}`;

const tracked = new Set(); // ChildProcess spawnés directement par ce fichier

// spawnTracked : SEUL point d'entrée autorisé pour spawner un process node dans un test.
// - injecte PROC_MARK en fin d'argv (les fixtures/index.js parsent par indexOf/env => token en trop OK)
// - detached POSIX => group leader tuable en arbre ; sur Windows treeKill fait `taskkill /T`
// - auto-retrait du Set à l'exit (pas de faux survivant)
export function spawnTracked(args, opts = {}) {
  const child = spawn(process.execPath, [...args, PROC_MARK], {
    detached: !onWin,
    ...opts,
  });
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
  return child;
}

// taggedArgs : pour un process que le CODE sous test spawnera lui-même (ex SPEC du superviseur).
// Le marqueur voyage dans la cmdline => le ratchet le retrouve même si le test n'a jamais tenu son PID.
export function taggedArgs(args) {
  return [...args, PROC_MARK];
}

// Retourne les process survivants (hors self) portant NOTRE marqueur. Exporté = testable :
// c'est la DÉTECTION au cœur du ratchet (prouver qu'il VOIT une fuite, pas seulement qu'il tue).
export function survivors() {
  return listProcesses().filter(({ pid, cmd }) => pid !== process.pid && cmd.includes(PROC_MARK));
}
const markedSurvivors = survivors;

// reapAll : tue tout (tracké + tout survivant marqué), best-effort, synchrone. Idempotent.
export function reapAll() {
  for (const c of tracked) { try { treeKill(c.pid); } catch {} }
  tracked.clear();
  for (const { pid } of markedSurvivors()) { try { treeKill(pid); } catch {} }
}

// reapAndRatchet : reap + attente de la mort + ASSERTION fails-closed (aucun survivant marqué).
// C'est le gate : un teardown cassé (ou un spawn hors harnais) rend le fichier ROUGE avec la liste.
async function reapAndRatchet() {
  reapAll();
  let survivors = markedSurvivors();
  for (let i = 0; i < 40 && survivors.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    reapAll();
    survivors = markedSurvivors();
  }
  assert.equal(
    survivors.length, 0,
    `FUITE DE PROCESS : ${survivors.length} survivant(s) marqué(s) ${PROC_MARK} après teardown ` +
    `(pid: ${survivors.map((s) => s.pid).join(', ')}). Un test a spawné hors spawnTracked/taggedArgs ` +
    `ou un teardown a échoué.`
  );
}

// UN afterAll root unique par fichier importateur : reap + ratchet garantis, même si un test a throw.
// ⚠️ vitest : chaque fichier de test est isolé (pool 'forks', isolate:true) => module state frais
// par fichier, EXACTEMENT comme node:test (1 process/fichier). afterAll s'attache au fichier COURANT.
afterAll(reapAndRatchet);

// Filets signaux : crash/kill hors du cycle node:test => on tue au moins les process trackés
// (best-effort synchrone, pas d'assertion possible ici). Défense en profondeur.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { try { reapAll(); } catch {} process.exit(1); });
}

export { isPidAlive };
