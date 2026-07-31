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
  START_STALE_FACTOR,
  startStaleMs,
  SPAWN_ATTEMPTS,
  RETRY_READY_TIMEOUT_MS,
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
test('startStaleMs : DERIVE du budget de readiness, avec marge (> READY_TIMEOUT_MS)', () => {
  expect(startStaleMs()).toBe(Math.floor(READY_TIMEOUT_MS * START_STALE_FACTOR));
  expect(startStaleMs(), 'jamais sous le budget de readiness : sinon on tue un demarrage SAIN')
    .toBeGreaterThan(READY_TIMEOUT_MS);
  expect(startStaleMs(20000)).toBe(30000);
});

test('property : startStaleMs depasse TOUJOURS le budget de readiness qu on lui donne', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 300000 }), (t) => startStaleMs(t) >= t));
});

// ---------- SPAWN_ATTEMPTS : politique de reessai sur port neuf (refonte 2026-07-31) ----------
test('SPAWN_ATTEMPTS : valeur EXACTE scellee (3 = deux reessais sur des ports DIFFERENTS)', () => {
  // ⚠️ Valeur epinglee A DESSEIN (tueur de mutant sur le litteral). La changer est une DECISION :
  // 1 => plus aucun reessai, un port raffle par la fenetre TOCTOU redevient une panne (retour au 31/07).
  // Trop grand => une machine ou AUCUN port ne repond bloque le boot d autant plus longtemps.
  expect(SPAWN_ATTEMPTS).toBe(3);
});

test('SPAWN_ATTEMPTS : au moins 2 (sinon zero reessai) et borne (sinon boot interminable)', () => {
  // Double garde de SENS, complementaire de la valeur exacte : elle survit a un changement volontaire
  // et continue d interdire les deux extremes dangereux.
  expect(SPAWN_ATTEMPTS, 'un reessai MINIMUM : c est lui qui absorbe la course d allocation').toBeGreaterThanOrEqual(2);
  expect(SPAWN_ATTEMPTS, 'borne DURE : le boot ne doit jamais s eterniser en silence').toBeLessThanOrEqual(5);
});

test('SPAWN_ATTEMPTS : entier (un compteur de tentatives fractionnaire n a aucun sens)', () => {
  expect(Number.isInteger(SPAWN_ATTEMPTS)).toBe(true);
});

test('RETRY_READY_TIMEOUT_MS : STRICTEMENT plus court que la 1re tentative (et non nul)', () => {
  // ⚠️ L'INVARIANT, pas juste la valeur : les 20 s nominales servent au 1er lancement (npx peut
  // TELECHARGER le paquet) ; des la 2e tentative ce cout est paye. Rendre les reessais aussi longs
  // porterait le pire cas a 60 s — au-dela du mur client (30 s) — donc une liste d'outils degradee
  // la ou une reponse complete restait possible. MESURE le 31/07 : c'est ce qui a fait ROUGE le
  // test live « serveur partage TUE » (timeout 30 s) avant cet ajustement.
  expect(RETRY_READY_TIMEOUT_MS).toBeLessThan(READY_TIMEOUT_MS);
  expect(RETRY_READY_TIMEOUT_MS, 'jamais 0 : un reessai a besoin de temps pour aboutir').toBeGreaterThan(0);
});

test('RETRY_READY_TIMEOUT_MS : le PIRE CAS total reste borne (gate de bout en bout)', () => {
  // Somme reelle = 1re tentative + (SPAWN_ATTEMPTS-1) reessais. Ce gate est le seul endroit qui
  // regarde le COUT TOTAL d'un demarrage : allonger l'un des deux reglages sans y penser => ROUGE.
  const pireCas = READY_TIMEOUT_MS + (SPAWN_ATTEMPTS - 1) * RETRY_READY_TIMEOUT_MS;
  expect(pireCas, 'un boot ne doit jamais pouvoir durer une minute').toBeLessThanOrEqual(45000);
});
