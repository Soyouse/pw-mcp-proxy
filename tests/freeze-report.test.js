// freeze-report.js (PUR) : le rapport forensique de gel. Mutation-teste (Stryker) : chaque fait ET
// chaque label DOIT apparaitre exactement, le discriminant Chrome mort/fige NE DOIT PAS muter en
// silence, et la fonction est TOTALE (jamais throw, meme sur des faits pourris) — c'est le « bloc de
// logs » de Theo scelle. Les asserts `toBe` (sortie EXACTE) tuent les mutants de chaine de format.
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { formatFreezeReport } from '../src/freeze-report.js';

test('sortie EXACTE, tous les faits fournis (verrouille chaque label + valeur + le round de l age)', () => {
  // ageMs=47600 => 48s : tue le mutant Math.round (sans lui: 47.6s) ET le mutant /1000 -> *1000.
  const out = formatFreezeReport({
    profile: 'vegeta', reason: 'unresponsive', serverPid: 1234, serverAlive: true, port: 9462,
    browserCount: 2, missedPings: 3, inflight: [{ method: 'browser_navigate', ageMs: 47600 }],
  });
  expect(out).toBe(
    '[FREEZE] profil="vegeta" reason=unresponsive\n' +
    '  serveur: pid=1234 vivant=true port=9462\n' +
    '  browser: 2 Chrome vivant(s) => FIGE (pas mort)\n' +
    '  watchdog: pings_rates_consecutifs=3\n' +
    '  requetes EN VOL (1):\n' +
    '    - browser_navigate en vol depuis 48s'
  );
});

test('sortie EXACTE, Chrome MORT (0) + aucune requete + tous les fallbacks (pid/port/pings ?)', () => {
  const out = formatFreezeReport({ profile: 'p', browserCount: 0 });
  expect(out).toBe(
    '[FREEZE] profil="p" reason=unresponsive\n' +
    '  serveur: pid=? vivant=inconnu port=?\n' +
    '  browser: AUCUN Chrome vivant (mort/absent)\n' +
    '  watchdog: pings_rates_consecutifs=?\n' +
    '  requetes EN VOL: aucune'
  );
});

test('sortie EXACTE, serverAlive=false + requete SANS age (jamais de "depuis"/NaN)', () => {
  const out = formatFreezeReport({ profile: 'x', serverAlive: false, browserCount: 1, inflight: [{ method: 'browser_click' }] });
  expect(out).toBe(
    '[FREEZE] profil="x" reason=unresponsive\n' +
    '  serveur: pid=? vivant=false port=?\n' +
    '  browser: 1 Chrome vivant(s) => FIGE (pas mort)\n' +
    '  watchdog: pings_rates_consecutifs=?\n' +
    '  requetes EN VOL (1):\n' +
    '    - browser_click'
  );
});

test('discriminant Chrome : inconnu quand le fait n est pas collecte (null OU undefined)', () => {
  expect(formatFreezeReport({ browserCount: null })).toContain('browser: inconnu');
  expect(formatFreezeReport({})).toContain('browser: inconnu'); // undefined
});

test('serverAlive : null => inconnu (distinct de false/true)', () => {
  expect(formatFreezeReport({ serverAlive: null })).toContain('vivant=inconnu');
});

test('inflight non-array (fait pourri) => traite comme aucune requete, jamais un throw', () => {
  expect(formatFreezeReport({ inflight: 'pas-un-tableau' })).toContain('requetes EN VOL: aucune');
});

test('requete a method absente => "?" (jamais "undefined")', () => {
  const out = formatFreezeReport({ inflight: [{}] });
  expect(out).toContain('    - ?');
  expect(out).not.toContain('undefined');
});

test('reason personnalisee est respectee (pas figee sur unresponsive)', () => {
  expect(formatFreezeReport({ reason: 'crash-boucle' })).toContain('reason=crash-boucle');
});

test('TOTALE : ne throw JAMAIS, contient toujours [FREEZE], meme sur des faits arbitraires', () => {
  fc.assert(
    fc.property(
      fc.record({
        profile: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
        browserCount: fc.oneof(fc.nat(), fc.constant(null), fc.constant(undefined)),
        inflight: fc.oneof(
          fc.array(fc.record({ method: fc.oneof(fc.string(), fc.constant(undefined)), ageMs: fc.oneof(fc.integer(), fc.constant(undefined)) })),
          fc.constant(undefined), fc.constant(null)
        ),
      }, { requiredKeys: [] }),
      (facts) => {
        const out = formatFreezeReport(facts);
        return typeof out === 'string' && out.includes('[FREEZE]') && !out.includes('undefined');
      }
    )
  );
  expect(() => formatFreezeReport()).not.toThrow();
  expect(formatFreezeReport()).toContain('[FREEZE]');
});
