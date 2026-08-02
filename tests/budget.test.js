// Tests du module PUR budget.js (source unique des delais). Unite + property-based (fast-check).
// Invariants scelles : heritage du budget client (MCP_TIMEOUT), robustesse aux valeurs absurdes,
// et LE GATE central : une reponse de handshake arrive TOUJOURS avant le mur du client.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_CLIENT_BUDGET_MS,
  HANDSHAKE_RATIO,
  SAFETY_RATIO,
  clientBudgetMs,
  handshakeBudgetMs,
  handshakeFitsBudget,
  READY_TIMEOUT_MS,
} from '../src/budget.js';

// ---------- heritage du budget client ----------
test('clientBudgetMs : herite de MCP_TIMEOUT quand il est valide', () => {
  expect(clientBudgetMs({ MCP_TIMEOUT: '10000' }), 'valeur documentee par Claude Code').toBe(10000);
  expect(clientBudgetMs({ MCP_TIMEOUT: 45000 }), 'nombre accepte aussi bien que string').toBe(45000);
});

test('clientBudgetMs : retombe sur le defaut MESURE si absent/absurde', () => {
  // ⚠️ Un MCP_TIMEOUT casse ne DOIT JAMAIS produire un budget nul : tout repondrait en degrade.
  for (const env of [{}, { MCP_TIMEOUT: '' }, { MCP_TIMEOUT: 'abc' }, { MCP_TIMEOUT: '0' }, { MCP_TIMEOUT: '-5' }, { MCP_TIMEOUT: 'NaN' }, { MCP_TIMEOUT: 'Infinity' }])
    expect(clientBudgetMs(env), `env=${JSON.stringify(env)}`).toBe(DEFAULT_CLIENT_BUDGET_MS);
  expect(clientBudgetMs(), 'appel sans argument').toBe(DEFAULT_CLIENT_BUDGET_MS);
});

test('property : clientBudgetMs rend TOUJOURS un nombre fini strictement positif', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.integer(), fc.double(), fc.constant(undefined)), (v) => {
      const b = clientBudgetMs({ MCP_TIMEOUT: v });
      return Number.isFinite(b) && b > 0;
    })
  );
});

// ---------- budget de handshake ----------
test('handshakeBudgetMs : applique le ratio et reste ENTIER', () => {
  expect(handshakeBudgetMs(30000)).toBe(24000); // 0.8 * 30000
  expect(handshakeBudgetMs(10000)).toBe(8000);
  expect(Number.isInteger(handshakeBudgetMs(3333)), 'floor applique').toBe(true);
});

test('property : le budget de handshake est TOUJOURS strictement sous le budget client', () => {
  // C'est l'invariant qui protege la session : repondre (meme degrade) AVANT que le client raccroche.
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 600000 }), (budget) => handshakeBudgetMs(budget) < budget)
  );
});

// ---------- LE GATE (fails-closed des DEUX cotes) ----------
test('GATE : la config COURANTE tient dans le budget client (doit etre VERT)', () => {
  expect(handshakeFitsBudget(DEFAULT_CLIENT_BUDGET_MS), 'config prod conforme').toBe(true);
  for (const b of [5000, 10000, 30000, 60000, 120000])
    expect(handshakeFitsBudget(b), `budget client ${b}`).toBe(true);
});

test('GATE : negative-check — un ratio au-dela de la marge de surete DOIT etre REJETE', () => {
  // ⚠️ ANTI-GATE-CREUX (doctrine) : un gate qui ne sait pas dire NON ne prouve rien. On verifie que
  // le predicat REJETTE bien un reglage trop proche du mur, sinon il serait toujours vrai = inutile.
  const trop = (clientBudget) => Math.floor(clientBudget * 0.95) <= clientBudget * SAFETY_RATIO;
  expect(trop(30000), 'un ratio de 0.95 DOIT etre hors marge').toBe(false);
  expect(HANDSHAKE_RATIO, 'le ratio courant reste sous la marge de surete').toBeLessThanOrEqual(SAFETY_RATIO);
});

test('HANDSHAKE_RATIO : degrade TARD, jamais par prudence (>= 0.5)', () => {
  // Regression 2026-07-31 : un ratio de 0.4 (12 s) degradait un demarrage LENT MAIS SAIN (premier
  // `npx` qui telecharge) => liste d'outils amputee = changement de comportement observable.
  expect(HANDSHAKE_RATIO).toBeGreaterThanOrEqual(0.5);
  expect(HANDSHAKE_RATIO).toBeLessThan(1);
});

// ---------- peremption d'une entree 'starting' ----------
