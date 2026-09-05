// PUR + property — la DÉCISION du coffre d'identités. Cible Stryker : src/identity-store-pure.js
//
// ENJEU : ce module décide ce qu'on COPIE (une identité = un compte connecté) et ce qu'on EFFACE.
// Un exclu de trop = un compte qui se déconnecte en silence ; une éviction de trop = un compte
// perdu. D'où : cas EXACTS sur chaque segment, propriétés (idempotence du filtre, convergence de
// l'éviction, jamais d'éviction sous les plafonds), et totalité (aucune entrée ne fait throw).

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  STRATEGIES,
  estExclu,
  nomIdentiteValide,
  instanceId,
  lirePlafonds,
  verdictSnapshot,
  planEviction,
  cheminsCoffre,
} from '../src/identity-store-pure.js';

const MIB = 1024 * 1024;
const JOUR = 24 * 60 * 60 * 1000;

// ── stratégies ────────────────────────────────────────────────────────────────────────────────
test('la liste des stratégies est FIGÉE : snapshot et inplace, rien d autre', () => {
  expect(STRATEGIES).toEqual(['snapshot', 'inplace']);
  expect(Object.isFrozen(STRATEGIES)).toBe(true);
});

// ── filtre du snapshot ────────────────────────────────────────────────────────────────────────
test('chaque cache de Chrome est EXCLU, par segment EXACT, à toute profondeur', () => {
  for (const seg of ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
    expect(estExclu(seg), seg).toBe(true);
    expect(estExclu(`Default/${seg}`), `Default/${seg}`).toBe(true);
    expect(estExclu(`Default/${seg}/index`), `${seg}/index`).toBe(true);
    expect(estExclu(`Default\\${seg}\\data_0`), `backslash ${seg}`).toBe(true);
  }
});

test('les verrous d instance de Chrome sont EXCLUS (un verrou copié = un Chrome qui croit un autre vivant)', () => {
  for (const f of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) expect(estExclu(f), f).toBe(true);
});

test('Service Worker/CacheStorage EXCLU, mais Service Worker/Database CONSERVÉ (c est de l état)', () => {
  expect(estExclu('Default/Service Worker/CacheStorage/abc')).toBe(true);
  expect(estExclu('Default/Service Worker/Database/000003.log')).toBe(false);
  expect(estExclu('Default/Service Worker')).toBe(false);
  expect(estExclu('CacheStorage'), 'CacheStorage SEUL (hors Service Worker) n est pas dans la liste').toBe(false);
});

test('ce qui PORTE l identité n est JAMAIS exclu (cookies, stockage, préférences, clés de session)', () => {
  for (const p of [
    'Default/Cookies', 'Default/Network/Cookies', 'Default/Local Storage/leveldb/000005.ldb',
    'Default/IndexedDB/https_mail.google.com_0.indexeddb.leveldb/CURRENT', 'Default/Preferences',
    'Local State', 'Default/Session Storage/000003.log', 'Default/Web Data', 'Default/Login Data',
    'Default/Sessions/Session_13300000000000000',
  ]) expect(estExclu(p), p).toBe(false);
});

test('un segment qui CONTIENT « Cache » sans l être n est pas exclu (comparaison exacte, pas includes)', () => {
  expect(estExclu('Default/MonCacheDeMots/x')).toBe(false);
  expect(estExclu('Default/cache')).toBe(false); // casse différente = autre nom
  expect(estExclu('Default/Cache2')).toBe(false);
});

test('entrées vides ou non-string : PAS exclues (on ne juge pas ce qu on ne voit pas)', () => {
  expect(estExclu('')).toBe(false);
  expect(estExclu(null)).toBe(false);
  expect(estExclu(undefined)).toBe(false);
  expect(estExclu(42)).toBe(false);
  expect(estExclu('///')).toBe(false);
});

test('PROPERTY : estExclu est stable au séparateur (slash ≡ backslash) et aux slashs doublés', () => {
  fc.assert(
    fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9 ._-]{1,12}$/), { minLength: 1, maxLength: 6 }), (segs) => {
      const a = estExclu(segs.join('/'));
      const b = estExclu(segs.join('\\'));
      const c = estExclu(segs.join('//'));
      return a === b && b === c;
    }),
    { numRuns: 300 }
  );
});

test('PROPERTY totalité : estExclu ne throw sur AUCUNE entrée', () => {
  fc.assert(fc.property(fc.anything(), (x) => typeof estExclu(x) === 'boolean'), { numRuns: 300 });
});

// ── nom d identité et instanceId ──────────────────────────────────────────────────────────────
test('nom d identité : alphabet FERMÉ (deviendra un nom de dossier du coffre)', () => {
  for (const ok of ['vegeta', 'perso', 'job', 'a', 'x.y_z-1', 'A'.repeat(64)]) expect(nomIdentiteValide(ok), ok).toBe(true);
  for (const ko of ['', '../perso', 'a/b', 'a\\b', '.hidden', '-x', 'é', 'a b', 'A'.repeat(65), null, 42, {}]) expect(nomIdentiteValide(ko), String(ko)).toBe(false);
});

test('instanceId = <identite>-<n>', () => {
  expect(instanceId('vegeta', 1)).toBe('vegeta-1');
  expect(instanceId('a-1', 2)).toBe('a-1-2');
});

test('PROPERTY : instanceId est injectif sur (nom valide, n)', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/), fc.integer({ min: 1, max: 1e6 }),
      fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/), fc.integer({ min: 1, max: 1e6 }),
      (i1, n1, i2, n2) => (i1 === i2 && n1 === n2) === (instanceId(i1, n1) === instanceId(i2, n2))
    ),
    { numRuns: 500 }
  );
});

// ── chemins (source unique des défauts : manager ET concierge) ────────────────────────────────
const OS = { homedir: '/home/u', tmpdir: '/tmp' };
const join = (...p) => p.join('/');

test('cheminsCoffre : défauts dérivés de homedir/tmpdir INJECTÉS (jamais lus ici)', () => {
  expect(cheminsCoffre({}, OS, join)).toEqual({ storeDir: '/home/u/.pw-identities', instancesDir: '/tmp/pw-mcp-instances' });
  expect(cheminsCoffre(undefined, OS, join)).toEqual({ storeDir: '/home/u/.pw-identities', instancesDir: '/tmp/pw-mcp-instances' });
  expect(cheminsCoffre([], OS, join)).toEqual({ storeDir: '/home/u/.pw-identities', instancesDir: '/tmp/pw-mcp-instances' });
});

test('cheminsCoffre : la config PRIME quand elle est une chaîne non vide, sinon défaut (champ par champ)', () => {
  expect(cheminsCoffre({ identityStore: { dir: 'D:/coffre' }, instances: { dir: 'D:/inst' } }, OS, join)).toEqual({ storeDir: 'D:/coffre', instancesDir: 'D:/inst' });
  expect(cheminsCoffre({ identityStore: { dir: '' }, instances: { dir: 42 } }, OS, join)).toEqual({ storeDir: '/home/u/.pw-identities', instancesDir: '/tmp/pw-mcp-instances' });
  expect(cheminsCoffre({ identityStore: 'non', instances: null }, OS, join)).toEqual({ storeDir: '/home/u/.pw-identities', instancesDir: '/tmp/pw-mcp-instances' });
  expect(cheminsCoffre({ identityStore: { dir: 'D:/coffre' } }, OS, join).instancesDir).toBe('/tmp/pw-mcp-instances');
});

// ── plafonds ──────────────────────────────────────────────────────────────────────────────────
test('plafonds ABSENTS ou absurdes ⇒ ceux de l industrie, JAMAIS « illimité » (l espace se déclare)', () => {
  expect(lirePlafonds(undefined)).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 });
  expect(lirePlafonds(null)).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 });
  expect(lirePlafonds([])).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 });
  expect(lirePlafonds({ maxParIdentiteMo: 0, maxTotalMo: -1, retentionJours: 2.5 })).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 });
  expect(lirePlafonds({ maxParIdentiteMo: '500', maxTotalMo: true, retentionJours: null })).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 });
});

test('plafonds VALIDES pris tels quels, indépendamment les uns des autres', () => {
  expect(lirePlafonds({ maxParIdentiteMo: 500 })).toEqual({ maxParIdentiteMo: 500, maxTotalMo: 6000, retentionJours: 30 });
  expect(lirePlafonds({ maxTotalMo: 1 })).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 1, retentionJours: 30 });
  expect(lirePlafonds({ retentionJours: 7 })).toEqual({ maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 7 });
});

test('verdictSnapshot : sous le plafond OK, pile au plafond OK, un octet de plus REFUSÉ et NOMMÉ', () => {
  expect(verdictSnapshot(0, { maxParIdentiteMo: 1 })).toEqual({ ok: true });
  expect(verdictSnapshot(1 * MIB, { maxParIdentiteMo: 1 })).toEqual({ ok: true });
  const r = verdictSnapshot(1 * MIB + 1, { maxParIdentiteMo: 1 });
  expect(r.ok).toBe(false);
  expect(r.raison).toMatch(/maxParIdentiteMo=1/);
  expect(r.raison).toMatch(/ancien snapshot est conserve/);
});

test('verdictSnapshot : taille invalide = REFUS nommé (jamais un OK par défaut)', () => {
  for (const v of [-1, NaN, Infinity, undefined, null, 'gros']) {
    const r = verdictSnapshot(v, {});
    expect(r.ok, String(v)).toBe(false);
    expect(r.raison).toMatch(/taille de snapshot invalide/);
  }
});

// ── éviction ──────────────────────────────────────────────────────────────────────────────────
const E = (identite, octets, dernierUsageMs) => ({ identite, octets, dernierUsageMs });

test('rien à évincer sous les plafonds et dans la rétention', () => {
  const now = 100 * JOUR;
  const r = planEviction([E('a', 10 * MIB, now - 1 * JOUR), E('b', 20 * MIB, now)], { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 }, now);
  expect(r).toEqual({ evincer: [], depassent: [] });
});

test('RÉTENTION : au-delà de retentionJours ⇒ évincée ; pile à la limite ⇒ conservée', () => {
  const now = 100 * JOUR;
  const p = { retentionJours: 30 };
  expect(planEviction([E('vieille', 1, now - 30 * JOUR - 1)], p, now).evincer).toEqual([{ identite: 'vieille', motif: 'retention' }]);
  expect(planEviction([E('limite', 1, now - 30 * JOUR)], p, now).evincer).toEqual([]);
});

test('PLAFOND TOTAL : on évince par ÂGE (la moins récemment utilisée d abord), jusqu à repasser sous le plafond', () => {
  const now = 100 * JOUR;
  const r = planEviction(
    [E('recente', 3 * MIB, now), E('ancienne', 3 * MIB, now - 5 * JOUR), E('moyenne', 3 * MIB, now - 2 * JOUR)],
    { maxTotalMo: 7 }, now
  );
  // total 9 Mo > 7 : évincer la plus ancienne (3) ⇒ 6 ≤ 7, on s arrête — jamais une de plus
  expect(r.evincer).toEqual([{ identite: 'ancienne', motif: 'plafond-total' }]);
});

test('PLAFOND TOTAL : égalité d usage départagée par le nom (déterminisme)', () => {
  const now = 100 * JOUR;
  const r = planEviction([E('b', 5 * MIB, now), E('a', 5 * MIB, now)], { maxTotalMo: 6 }, now);
  expect(r.evincer).toEqual([{ identite: 'a', motif: 'plafond-total' }]);
});

test('une identité déjà évincée par rétention ne compte plus dans le total', () => {
  const now = 100 * JOUR;
  const r = planEviction([E('vieille', 100 * MIB, now - 40 * JOUR), E('vivante', 5 * MIB, now)], { maxTotalMo: 10, retentionJours: 30 }, now);
  expect(r.evincer).toEqual([{ identite: 'vieille', motif: 'retention' }]);
});

test('DÉPASSEMENT individuel : signalé dans depassent, JAMAIS évincé pour ça', () => {
  const now = 100 * JOUR;
  const r = planEviction([E('grosse', 301 * MIB, now)], { maxParIdentiteMo: 300, maxTotalMo: 6000 }, now);
  expect(r.depassent).toEqual(['grosse']);
  expect(r.evincer).toEqual([]);
  expect(planEviction([E('pile', 300 * MIB, now)], { maxParIdentiteMo: 300, maxTotalMo: 6000 }, now).depassent).toEqual([]);
});

test('FAILS-CLOSED : sans dernierUsageMs lisible ⇒ traitée comme utilisée À L INSTANT (jamais évincée par rétention, dernière au plafond)', () => {
  const now = 100 * JOUR;
  expect(planEviction([{ identite: 'inconnue', octets: 1 }], { retentionJours: 1 }, now).evincer).toEqual([]);
  const r = planEviction([{ identite: 'inconnue', octets: 5 * MIB }, E('datee', 5 * MIB, now - 1)], { maxTotalMo: 6 }, now);
  expect(r.evincer).toEqual([{ identite: 'datee', motif: 'plafond-total' }]);
});

test('entrées malformées IGNORÉES, jamais un throw (fonction totale, le coffre sert N identités)', () => {
  const now = 100 * JOUR;
  expect(planEviction(null, {}, now)).toEqual({ evincer: [], depassent: [] });
  expect(planEviction([null, 42, {}, { identite: '' }, { identite: 'ok', octets: 'x', dernierUsageMs: 'y' }], {}, now)).toEqual({ evincer: [], depassent: [] });
  expect(planEviction([E('a', 1, now)], {}, NaN).evincer).toEqual([]);
});

test('PROPERTY convergence : appliquer le plan puis re-planifier ⇒ plus rien à évincer', () => {
  const entree = fc.record({
    identite: fc.stringMatching(/^[a-z]{1,6}$/),
    octets: fc.integer({ min: 0, max: 50 * MIB }),
    dernierUsageMs: fc.integer({ min: 0, max: 200 * JOUR }),
  });
  fc.assert(
    fc.property(
      fc.uniqueArray(entree, { selector: (e) => e.identite, maxLength: 20 }),
      fc.record({ maxParIdentiteMo: fc.integer({ min: 1, max: 60 }), maxTotalMo: fc.integer({ min: 1, max: 400 }), retentionJours: fc.integer({ min: 1, max: 100 }) }),
      fc.integer({ min: 0, max: 300 * JOUR }),
      (entrees, plafonds, now) => {
        const p1 = planEviction(entrees, plafonds, now);
        const evincees = new Set(p1.evincer.map((e) => e.identite));
        const restantes = entrees.filter((e) => !evincees.has(e.identite));
        const p2 = planEviction(restantes, plafonds, now);
        return p2.evincer.length === 0;
      }
    ),
    { numRuns: 300 }
  );
});

test('PROPERTY sécurité : sous le plafond total ET dans la rétention, AUCUNE éviction, quelles que soient les tailles', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.record({ identite: fc.stringMatching(/^[a-z]{1,6}$/), octets: fc.integer({ min: 0, max: 10 * MIB }), age: fc.integer({ min: 0, max: 29 * JOUR }) }), { selector: (e) => e.identite, maxLength: 10 }),
      (rows) => {
        const now = 100 * JOUR;
        const entrees = rows.map((r) => E(r.identite, r.octets, now - r.age));
        return planEviction(entrees, { maxTotalMo: 100, retentionJours: 30, maxParIdentiteMo: 10 }, now).evincer.length === 0;
      }
    ),
    { numRuns: 300 }
  );
});

test('PROPERTY : une identité n apparaît qu UNE fois dans le plan, et jamais avec deux motifs', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.record({ identite: fc.stringMatching(/^[a-z]{1,6}$/), octets: fc.integer({ min: 0, max: 50 * MIB }), dernierUsageMs: fc.integer({ min: 0, max: 200 * JOUR }) }), { selector: (e) => e.identite, maxLength: 20 }),
      fc.integer({ min: 0, max: 300 * JOUR }),
      (entrees, now) => {
        const p = planEviction(entrees, { maxTotalMo: 20, retentionJours: 10 }, now);
        const noms = p.evincer.map((e) => e.identite);
        return new Set(noms).size === noms.length;
      }
    ),
    { numRuns: 300 }
  );
});
