// PUR + property — sémantique du protocole proxy ↔ daemon. Cible Stryker : src/daemon-protocol.js
//
// ENJEU : c'est la FRONTIÈRE entre deux processus. Une erreur de forme n'y produit pas un crash
// franc mais un malentendu SILENCIEUX — le daemon spawne le mauvais serveur, ou le proxy se
// branche sur une URL absente. D'où : round-trip (paire encode↔decode, doctrine) + totalité
// (aucune entrée ne doit faire tomber le daemon, il sert N clients).

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  OPS,
  requeteAcquire,
  reponseOk,
  reponseErreur,
  validerRequete,
  lireReponse,
} from '../src/daemon-protocol.js';

const specValide = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.78', '--port', '1234'] };

// ── requêtes ──────────────────────────────────────────────────────────────────────────────────
test('une requête construite est acceptée, et rend EXACTEMENT ce qui a été envoyé', () => {
  const r = validerRequete(requeteAcquire('vegeta', specValide));
  expect(r.valide).toBe(true);
  expect(r.profile).toBe('vegeta');
  expect(r.spec).toEqual(specValide);
});

test('REFUS explicite (jamais un throw) sur toute requête malformée', () => {
  const refuses = [
    null, undefined, 42, 'texte', [],
    {},
    { op: 'supprime-tout', profile: 'p', spec: specValide },
    { op: 'acquire', spec: specValide },
    { op: 'acquire', profile: '', spec: specValide },
    { op: 'acquire', profile: 42, spec: specValide },
    { op: 'acquire', profile: 'p' },
    { op: 'acquire', profile: 'p', spec: [] },
    { op: 'acquire', profile: 'p', spec: { args: [] } },
    { op: 'acquire', profile: 'p', spec: { command: '', args: [] } },
    { op: 'acquire', profile: 'p', spec: { command: 'npx' } },
    { op: 'acquire', profile: 'p', spec: { command: 'npx', args: 'pas-un-tableau' } },
    { op: 'acquire', profile: 'p', spec: { command: 'npx', args: [1, 2] } },
  ];
  for (const msg of refuses) {
    const r = validerRequete(msg);
    expect(r.valide, `doit être refusé : ${JSON.stringify(msg)}`).toBe(false);
    expect(typeof r.raison, 'un refus NOMME toujours son motif').toBe('string');
  }
});

// ⚠️ Le daemon SPAWNE à partir de ces données : la validation est une frontière de sécurité.
test('SÉCURITÉ : la spec rendue ne contient QUE command et args (rien ne passe en contrebande)', () => {
  const r = validerRequete({
    op: 'acquire',
    profile: 'p',
    spec: { command: 'npx', args: ['--port'], cwd: '/etc', env: { PATH: '/evil' }, shell: true },
  });
  expect(r.valide).toBe(true);
  expect(Object.keys(r.spec).sort()).toEqual(['args', 'command']);
});

// ── réponses ──────────────────────────────────────────────────────────────────────────────────
test('réponse ok : l URL traverse intacte', () => {
  expect(lireReponse(reponseOk('http://localhost:14013/mcp'))).toEqual({ ok: true, url: 'http://localhost:14013/mcp' });
});

// ⚠️ FAILS-CLOSED : un `ok` sans url construirait `http://undefined/...` côté proxy.
test('réponse ok SANS url = traitée comme une ERREUR, jamais comme un succès vide', () => {
  for (const msg of [{ ok: true }, { ok: true, url: '' }, { ok: true, url: 42 }]) {
    const r = lireReponse(msg);
    expect(r.ok, `doit échouer : ${JSON.stringify(msg)}`).toBe(false);
    expect(r.erreur).toMatch(/url/);
  }
});

test('réponse erreur : le motif traverse intact, et n est JAMAIS vide', () => {
  expect(lireReponse(reponseErreur('port occupé')).erreur).toBe('port occupé');
  expect(lireReponse({ ok: false }).erreur.length).toBeGreaterThan(0);
  expect(lireReponse(null).erreur.length).toBeGreaterThan(0);
  expect(lireReponse(reponseErreur(null)).erreur.length).toBeGreaterThan(0);
});

// ── round-trip : le message survit à la sérialisation ndjson (framing de jsonrpc.js) ──────────
// ⚠️ C'est ce qui prouve que réutiliser le framing existant est SÛR pour ce protocole.
test('PROPERTY round-trip : requête → JSON → requête, identique après un aller-retour', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 60 }),
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.array(fc.string({ maxLength: 40 }), { maxLength: 12 }),
      (profile, command, args) => {
        const envoye = requeteAcquire(profile, { command, args });
        const recu = JSON.parse(JSON.stringify(envoye)); // ce que fait writeMessage + NdjsonReader
        const r = validerRequete(recu);
        return r.valide === true && r.profile === profile && r.spec.command === command
          && JSON.stringify(r.spec.args) === JSON.stringify(args);
      }
    ),
    { numRuns: 300 }
  );
});

test('PROPERTY round-trip : réponse ok → JSON → réponse ok, url préservée', () => {
  fc.assert(
    fc.property(fc.webUrl(), (url) => {
      const r = lireReponse(JSON.parse(JSON.stringify(reponseOk(url))));
      return r.ok === true && r.url === url;
    }),
    { numRuns: 200 }
  );
});

// ⚠️ TOTALITÉ : le daemon sert N clients ; un seul message hostile ne doit pas le faire tomber.
test('PROPERTY totalité : AUCUNE entrée ne fait throw, ni en validation ni en lecture', () => {
  fc.assert(
    fc.property(fc.anything(), (x) => {
      const a = validerRequete(x);
      const b = lireReponse(x);
      return typeof a.valide === 'boolean' && typeof b.ok === 'boolean';
    }),
    { numRuns: 500 }
  );
});

test('le jeu d opérations est FIGÉ (une op ajoutée sans validation = une porte ouverte)', () => {
  expect(OPS).toEqual(['acquire']);
  expect(Object.isFrozen(OPS)).toBe(true);
});

// ⚠️ Chaque cas ci-dessous n'a QU'UN SEUL défaut : c'est ce qui rend chaque prédicat de
// `validerRequete` individuellement responsable. Un cas cumulant deux défauts laisse survivre le
// mutant du second prédicat (mesuré 02/08 : score 93,99 < 94 pour cette seule raison).
test('REFUS : un seul prédicat en cause à la fois (chaque garde est responsable)', () => {
  const base = () => ({ op: 'acquire', profile: 'p', spec: { command: 'npx', args: ['--port'] } });
  const cas = [
    ['command non-string', (m) => { m.spec.command = 42; }],
    ['command null', (m) => { m.spec.command = null; }],
    ['command vide', (m) => { m.spec.command = ''; }],
    ['args objet et non tableau', (m) => { m.spec.args = { 0: 'x' }; }],
    ['args null', (m) => { m.spec.args = null; }],
    ['args : un non-string en 2e position', (m) => { m.spec.args = ['ok', 5]; }],
    ['args : un non-string en dernière position', (m) => { m.spec.args = ['a', 'b', null]; }],
    ['profile non-string', (m) => { m.profile = 42; }],
    ['profile vide', (m) => { m.profile = ''; }],
    ['op absente', (m) => { delete m.op; }],
  ];
  for (const [nom, casser] of cas) {
    const m = base();
    casser(m);
    expect(validerRequete(m).valide, `doit être refusé : ${nom}`).toBe(false);
  }
});

// ⚠️ Symétrique du test ci-dessus : ces formes VALIDES doivent passer. Sans elles, un mutant qui
// durcit une garde (ex. `args.length > 0` exigé) survivrait — le refus seul ne prouve rien.
test('ACCEPTE les formes valides limites (un mutant qui durcit une garde doit mourir)', () => {
  expect(validerRequete({ op: 'acquire', profile: 'p', spec: { command: 'x', args: [] } }).valide,
    'args VIDE est légitime (serveur sans argument)').toBe(true);
  expect(validerRequete({ op: 'acquire', profile: 'a', spec: { command: 'x', args: [''] } }).valide,
    'un argument chaîne VIDE reste une chaîne').toBe(true);
  expect(validerRequete({ op: 'acquire', profile: 'p'.repeat(200), spec: { command: 'x', args: [] } }).valide,
    'aucune borne de longueur sur le profil (N profils NON borné)').toBe(true);
});

// ⚠️ LE MOTIF EXACT DE CHAQUE REFUS EST VERIFIE, pas seulement sa présence.
// Deux raisons, et la seconde est la plus importante :
//   1. Un refus est ce qu'un HUMAIN lit au diagnostic. « refusé » sans dire POURQUOI, c'est
//      l'aveuglement du 01/08 (message vide, 5 h perdues) transposé à ce protocole.
//   2. Sans ça, les gardes deviennent interchangeables pour la mutation : retirer
//      `Array.isArray(msg)` laisse le message passer par une AUTRE garde, le refus final est
//      identique, et le mutant SURVIT. Vérifier la raison rend chaque garde irremplaçable.
//      (Mesuré 02/08 : 11 survivants, dont 7 StringLiteral, pour cette seule raison.)
test('chaque garde produit SON motif — les gardes ne sont pas interchangeables', () => {
  const attendus = [
    [null, /non-objet/],
    [[], /non-objet/],
    ['texte', /non-objet/],
    [{ op: 'inconnue', profile: 'p', spec: { command: 'x', args: [] } }, /op inconnue/],
    [{ op: 'acquire', profile: '', spec: { command: 'x', args: [] } }, /profile/],
    [{ op: 'acquire', profile: 'p', spec: null }, /spec absente/],
    [{ op: 'acquire', profile: 'p', spec: [] }, /spec absente/],
    [{ op: 'acquire', profile: 'p', spec: { args: [] } }, /command/],
    [{ op: 'acquire', profile: 'p', spec: { command: 'x', args: 'non' } }, /tableau/],
    [{ op: 'acquire', profile: 'p', spec: { command: 'x', args: [1] } }, /chaînes/],
  ];
  for (const [msg, motif] of attendus) {
    const r = validerRequete(msg);
    expect(r.valide).toBe(false);
    expect(r.raison, `motif attendu ${motif} pour ${JSON.stringify(msg)}`).toMatch(motif);
  }
});

test('lireReponse : chaque refus NOMME sa cause', () => {
  expect(lireReponse(null).erreur).toMatch(/non-objet/);
  expect(lireReponse([]).erreur).toMatch(/non-objet/);
  expect(lireReponse({ ok: true }).erreur).toMatch(/url absente/);
  expect(lireReponse({ ok: false }).erreur).toMatch(/sans succès ni motif/);
});
