// Tests PURS de la décision de rotation de log (log-rotate.js). Unité + property-based (fast-check).
// Invariant central (property) : le plan de rotation ne fait JAMAIS écraser une génération avant
// de l'avoir elle-même déplacée => aucune perte de log en cascade.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { shouldRotate, rotationPlan } from '../src/log-rotate.js';

test('shouldRotate : rote quand la ligne ferait dépasser le plafond', () => {
  expect(shouldRotate(90, 20, 100)).toBe(true); // 90+20 > 100
  expect(shouldRotate(80, 20, 100)).toBe(false); // 80+20 == 100, pas de dépassement
  expect(shouldRotate(0, 200, 100)).toBe(true); // une seule ligne déjà plus grosse que le cap
});

test('shouldRotate : maxBytes<=0 DÉSACTIVE la rotation (borne infinie assumée)', () => {
  expect(shouldRotate(1e9, 1e9, 0)).toBe(false);
  expect(shouldRotate(1e9, 1e9, -1)).toBe(false);
});

test('rotationPlan : maxFiles=3 => [[file.1,file.2],[file,file.1]] (ordre décroissant)', () => {
  expect(rotationPlan('a.log', 3)).toEqual([['a.log.1', 'a.log.2'], ['a.log', 'a.log.1']]);
});

test('rotationPlan : maxFiles<=1 => plan vide (pas d’archive, l’appelant tronque)', () => {
  expect(rotationPlan('a.log', 1)).toEqual([]);
  expect(rotationPlan('a.log', 0)).toEqual([]);
});

// PROPERTY : en appliquant le plan dans l'ordre, chaque source est ENCORE intacte au moment où on
// la déplace — i.e. si un fichier x est à la fois source (étape i) et destination (étape j), alors
// i < j (on le lit AVANT de l'écraser). C'est l'invariant qui garantit zéro perte en cascade.
test('property : aucune génération n’est écrasée avant d’avoir été déplacée', () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 50 }), (maxFiles) => {
      const plan = rotationPlan('f.log', maxFiles);
      expect(plan.length).toBe(maxFiles - 1); // maxFiles-1 renames pour maxFiles générations
      const firstSourceAt = new Map();
      const firstDestAt = new Map();
      plan.forEach(([from, to], idx) => {
        if (!firstSourceAt.has(from)) firstSourceAt.set(from, idx);
        if (!firstDestAt.has(to)) firstDestAt.set(to, idx);
      });
      for (const [file, srcIdx] of firstSourceAt) {
        if (firstDestAt.has(file)) expect(srcIdx < firstDestAt.get(file), `${file} lu avant d'être écrasé`).toBeTruthy();
      }
      // toutes les destinations sont uniques (on n'écrit jamais deux fois la même cible)
      const dests = plan.map(([, to]) => to);
      expect(new Set(dests).size).toBe(dests.length);
    })
  );
});
