// PUR/quasi-pur (Stryker) — horloge monotone + detection de reboot.
//
// Ce que ces tests protegent : le registre est PARTAGE entre process et compare dans le temps.
// Avec l'heure murale, un saut NTP faisait soit massacrer tous les serveurs, soit n'en nettoyer
// aucun — les deux en SILENCE, et seulement apres des semaines.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import os from 'node:os';
import { monotonicNow, isStaleBoot, isWallClock, WALL_CLOCK_FLOOR } from '../src/clock.js';

test('monotonicNow : entier, coherent avec os.uptime()', () => {
  const n = monotonicNow();
  expect(Number.isInteger(n)).toBe(true);
  expect(n).toBeGreaterThan(0);
  expect(Math.abs(n - os.uptime() * 1000)).toBeLessThan(2000);
});

test('monotonicNow : NE RECULE JAMAIS (c est toute la raison d etre du module)', () => {
  const a = monotonicNow();
  for (let i = 0; i < 1000; i++) Math.sqrt(i); // un peu de temps machine
  expect(monotonicNow()).toBeGreaterThanOrEqual(a);
});

test('monotonicNow : PARTAGE entre process (contrairement a performance.now)', () => {
  // performance.now() part de 0 a chaque process ⇒ inutilisable pour comparer des horodatages
  // ecrits par un AUTRE proxy. os.uptime() est commun a toute la machine.
  expect(monotonicNow()).toBeGreaterThan(performance.now());
});

test('REBOOT : horodatage superieur a l uptime ⇒ registre perime', () => {
  // FAIT, pas inference : un tel horodatage vient forcement d'un boot precedent, et aucun
  // process ne survit a un redemarrage.
  expect(isStaleBoot([500, 999999], 1000)).toBe(true);
});

test('LEGACY vs PRE-REBOOT : deux cas DISTINCTS, traitements OPPOSES', () => {
  // Les confondre ferait fuir des serveurs le jour de la mise a jour : un registre legacy peut
  // referencer des process VIVANTS (a convertir), un registre pre-reboot n'en reference aucun.
  expect(isWallClock(Date.now())).toBe(true); // ~1.7e12 = heure murale
  expect(isWallClock(monotonicNow())).toBe(false); // uptime : des ordres de grandeur en dessous
  expect(isWallClock(WALL_CLOCK_FLOOR - 1)).toBe(false);
  expect(isWallClock(WALL_CLOCK_FLOOR)).toBe(true);
});

test('le seuil mural laisse 31 ANS de marge a un uptime (les domaines ne se recouvrent pas)', () => {
  const ansDeUptime = WALL_CLOCK_FLOOR / (1000 * 60 * 60 * 24 * 365);
  expect(ansDeUptime).toBeGreaterThan(30);
});

test('robustesse : isWallClock refuse tout ce qui n est pas un nombre fini', () => {
  for (const bad of [null, undefined, NaN, Infinity, '1700000000000', {}]) {
    expect(isWallClock(bad), String(bad)).toBe(false);
  }
});

test('nominal : tous les horodatages <= uptime ⇒ registre valide', () => {
  expect(isStaleBoot([1, 500, 1000], 1000)).toBe(false);
  expect(isStaleBoot([], 1000)).toBe(false);
});

test('robustesse : valeurs non numeriques IGNOREES, jamais un faux perime', () => {
  // Un `undefined` (champ absent d'une entree partielle) ne doit pas vider tout le registre.
  expect(isStaleBoot([undefined, null, 'abc', NaN, Infinity, 5], 1000)).toBe(false);
  expect(isStaleBoot(null, 1000)).toBe(false);
  expect(isStaleBoot('pas un tableau', 1000)).toBe(false);
});

test('PROPRIETE : jamais perime si tous les horodatages sont <= now', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 1000 })), (ts) => {
      expect(isStaleBoot(ts, 1000)).toBe(false);
    })
  );
});

test('PROPRIETE : perime des qu UN SEUL horodatage depasse now', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 1000 })), fc.integer({ min: 1001, max: 1e9 }), (ts, futur) => {
      expect(isStaleBoot([...ts, futur], 1000)).toBe(true);
    })
  );
});
