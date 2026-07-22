// Decision PURE d'auto-restart (COUCHE 2b, garde anti-boucle). Cible Stryker (vitest.pure.config.js).
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { shouldAutoRestart, DEFAULT_MAX_RESTARTS, DEFAULT_WINDOW_MS } from '../src/auto-restart.js';

test('aucun restart recent => autorise', () => {
  expect(shouldAutoRestart([], 1000, { maxRestarts: 3, windowMs: 300000 })).toBe(true);
});

test('sous le seuil dans la fenetre => autorise', () => {
  const now = 1000000;
  const hist = [now - 100, now - 200];
  expect(shouldAutoRestart(hist, now, { maxRestarts: 3, windowMs: 300000 })).toBe(true);
});

test('exactement au seuil (maxRestarts atteint DANS la fenetre) => refuse', () => {
  const now = 1000000;
  const hist = [now - 10, now - 20, now - 30]; // 3 restarts recents, maxRestarts=3
  expect(shouldAutoRestart(hist, now, { maxRestarts: 3, windowMs: 300000 })).toBe(false);
});

test('un de moins que le seuil => autorise (borne stricte <)', () => {
  const now = 1000000;
  const hist = [now - 10, now - 20]; // 2 < 3
  expect(shouldAutoRestart(hist, now, { maxRestarts: 3, windowMs: 300000 })).toBe(true);
});

test('timestamps HORS fenetre (trop vieux) => ignores', () => {
  const now = 1000000;
  const windowMs = 300000;
  const hist = [now - windowMs - 1, now - windowMs - 100]; // strictement avant windowStart
  expect(shouldAutoRestart(hist, now, { maxRestarts: 1, windowMs })).toBe(true);
});

test('timestamp EXACTEMENT sur la borne windowStart => compte (fenetre fermee)', () => {
  const now = 1000000;
  const windowMs = 300000;
  const hist = [now - windowMs]; // == windowStart, INCLUS
  expect(shouldAutoRestart(hist, now, { maxRestarts: 1, windowMs })).toBe(false);
});

test('timestamp futur (now < t, cas degrade) ignore par la borne <=now', () => {
  const now = 1000000;
  const hist = [now + 50];
  expect(shouldAutoRestart(hist, now, { maxRestarts: 1, windowMs: 300000 })).toBe(true);
});

test('defauts prod : maxRestarts=3, windowMs=300000 (5 min)', () => {
  expect(DEFAULT_MAX_RESTARTS).toBe(3);
  expect(DEFAULT_WINDOW_MS).toBe(300000);
  const now = 1000000;
  const hist = [now - 1, now - 2, now - 3];
  expect(shouldAutoRestart(hist, now)).toBe(false); // defauts utilises si options omises
  expect(shouldAutoRestart(hist.slice(0, 2), now)).toBe(true);
});

test('recentTimestamps null/undefined/non-array => traite comme vide (robuste)', () => {
  expect(shouldAutoRestart(null, 1000, { maxRestarts: 1, windowMs: 1000 })).toBe(true);
  expect(shouldAutoRestart(undefined, 1000, { maxRestarts: 1, windowMs: 1000 })).toBe(true);
});

test('entrees non-numeriques dans le tableau => ignorees (pas de NaN qui fausse le compte)', () => {
  const now = 1000000;
  const hist = [now - 10, 'x', null, undefined, NaN];
  expect(shouldAutoRestart(hist, now, { maxRestarts: 1, windowMs: 300000 })).toBe(false); // 1 valide compte
});

test('garde typeof stricte : "null" (coerce a 0 par >=/<=) NE compte PAS sans le check typeof', () => {
  // windowStart = now - windowMs = 0 (windowMs=now) : null >= 0 est TRUE en JS (coercion), donc
  // SANS le garde `typeof t === 'number'` ce null serait compte a tort. Tue le mutant qui remplace
  // le typeof-check par `true` (ConditionalExpression sur `typeof t === 'number' && ...`).
  const now = 1000000;
  expect(shouldAutoRestart([null], now, { maxRestarts: 1, windowMs: now })).toBe(true);
});

// ========================= property-based =========================

test('property : jamais plus de maxRestarts autorises consecutivement dans une fenetre fixe', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1000, max: 1000000 }),
      fc.integer({ min: 10000, max: 100000 }),
      (maxRestarts, now, windowMs) => {
        // simule N decisions successives : a chaque true, on enregistre now comme nouvel horodatage.
        let hist = [];
        let allowedCount = 0;
        for (let i = 0; i < maxRestarts + 5; i++) {
          const ok = shouldAutoRestart(hist, now, { maxRestarts, windowMs });
          if (ok) { hist.push(now); allowedCount++; }
        }
        expect(allowedCount).toBe(maxRestarts);
      }
    )
  );
});

test('property : monotonie — retirer un timestamp ne peut jamais faire passer true => false', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 1000000 }), { minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 1000000 }),
      (hist, now, maxRestarts, windowMs) => {
        const before = shouldAutoRestart(hist, now, { maxRestarts, windowMs });
        if (!before) return; // seule la direction true (avec hist complet) => true (sous-ensemble) importe
        const reduced = hist.slice(1);
        const after = shouldAutoRestart(reduced, now, { maxRestarts, windowMs });
        expect(after).toBe(true);
      }
    )
  );
});
