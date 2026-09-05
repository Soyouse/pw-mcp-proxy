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
  lireLimite,
  placeDisponible,
} from '../src/daemon-protocol.js';

const specValide = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.78', '--port', '1234'] };

// ── requêtes ──────────────────────────────────────────────────────────────────────────────────
test('une requête construite est acceptée, et rend EXACTEMENT ce qui a été envoyé', () => {
  const r = validerRequete(requeteAcquire('vegeta', specValide));
  expect(r.valide).toBe(true);
  expect(r.profile).toBe('vegeta');
  expect(r.spec).toEqual({ ...specValide, configuration: null });
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
test('SÉCURITÉ : la spec rendue ne contient QUE command, args et configuration (rien ne passe en contrebande)', () => {
  const r = validerRequete({
    op: 'acquire',
    profile: 'p',
    spec: { command: 'npx', args: ['--port'], cwd: '/etc', env: { PATH: '/evil' }, shell: true },
  });
  expect(r.valide).toBe(true);
  expect(Object.keys(r.spec).sort()).toEqual(['args', 'command', 'configuration']);
});

// ── instance (identité à matérialiser) — depuis le 05/09/2026 ─────────────────────────────────
const instanceValide = () => ({ identite: 'vegeta', strategie: 'snapshot', persist: true, storeDir: 'C:/coffre', instancesDir: 'C:/tmp/inst', plafonds: { maxParIdentiteMo: 300 } });

test('sans instance : la requête reste celle d hier, et `instance` vaut null (profil v1 / isolé)', () => {
  const r = validerRequete(requeteAcquire('p', specValide));
  expect(r.valide).toBe(true);
  expect(r.instance).toBe(null);
  expect('instance' in requeteAcquire('p', specValide), 'pas de champ fantôme sur le fil').toBe(false);
  expect(validerRequete({ op: 'acquire', profile: 'p', spec: specValide, instance: null }).instance).toBe(null);
});

test('avec instance : copie STRICTE, rien en contrebande, plafonds copiés (pas la même référence)', () => {
  const inst = { ...instanceValide(), cwd: '/etc', shell: true };
  const r = validerRequete(requeteAcquire('vegeta', specValide, inst));
  expect(r.valide).toBe(true);
  expect(Object.keys(r.instance).sort()).toEqual(['identite', 'instancesDir', 'persist', 'plafonds', 'storeDir', 'strategie']);
  expect(r.instance.plafonds).toEqual({ maxParIdentiteMo: 300 });
  expect(r.instance.plafonds, 'copie, pas la référence du message').not.toBe(inst.plafonds);
  expect(r.instance.persist).toBe(true);
  expect(r.instance.strategie).toBe('snapshot');
});

test('instance : plafonds absents ou non-objet ⇒ objet VIDE (les défauts se lisent dans identity-store-pure)', () => {
  const sans = instanceValide(); delete sans.plafonds;
  expect(validerRequete(requeteAcquire('v', specValide, sans)).instance.plafonds).toEqual({});
  expect(validerRequete(requeteAcquire('v', specValide, { ...instanceValide(), plafonds: [] })).instance.plafonds).toEqual({});
  expect(validerRequete(requeteAcquire('v', specValide, { ...instanceValide(), plafonds: 'non' })).instance.plafonds).toEqual({});
});

// ⚠️ Le daemon COPIE et EFFACE des dossiers à partir de ces champs : chaque garde a SON motif.
test('instance : chaque garde produit SON motif (un seul défaut par cas)', () => {
  const cas = [
    ['non-objet', () => 42, /instance non-objet/],
    ['tableau', () => [], /instance non-objet/],
    ['identité hors alphabet (../)', () => ({ ...instanceValide(), identite: '../perso' }), /identite invalide/],
    ['identité vide', () => ({ ...instanceValide(), identite: '' }), /identite invalide/],
    ['identité non-string', () => ({ ...instanceValide(), identite: 7 }), /identite invalide/],
    ['stratégie hors liste', () => ({ ...instanceValide(), strategie: 'clone' }), /strategie hors liste: clone/],
    ['stratégie absente', () => { const i = instanceValide(); delete i.strategie; return i; }, /strategie hors liste/],
    ['persist non booléen', () => ({ ...instanceValide(), persist: 'oui' }), /persist doit être un booléen/],
    ['persist absent', () => { const i = instanceValide(); delete i.persist; return i; }, /persist/],
    ['storeDir vide', () => ({ ...instanceValide(), storeDir: '' }), /storeDir absent ou vide/],
    ['storeDir non-string', () => ({ ...instanceValide(), storeDir: null }), /storeDir/],
    ['instancesDir vide', () => ({ ...instanceValide(), instancesDir: '' }), /instancesDir absent ou vide/],
    ['instancesDir non-string', () => ({ ...instanceValide(), instancesDir: 1 }), /instancesDir/],
  ];
  for (const [nom, fabrique, motif] of cas) {
    const r = validerRequete({ op: 'acquire', profile: 'p', spec: specValide, instance: fabrique() });
    expect(r.valide, `doit être refusé : ${nom}`).toBe(false);
    expect(r.raison, nom).toMatch(motif);
  }
});

// ── jeton (canal RÉSEAU, nœud distant — 05/09/2026) ───────────────────────────────────────────
test('token : absent par défaut (tuyau local) ; présent et non vide ⇒ transporté tel quel ; vide ⇒ absent', () => {
  expect('token' in requeteAcquire('p', specValide), 'pas de champ fantôme sur le fil').toBe(false);
  expect(validerRequete(requeteAcquire('p', specValide)).token).toBe(null);
  const r = validerRequete(requeteAcquire('p', specValide, null, 'secret-42'));
  expect(r.valide).toBe(true);
  expect(r.token).toBe('secret-42');
  expect('token' in requeteAcquire('p', specValide, null, ''), 'jeton vide = pas de jeton').toBe(false);
  expect(validerRequete({ op: 'acquire', profile: 'p', spec: specValide, token: 42 }).token, 'non-string = absent (le daemon refusera)').toBe(null);
});

test('instance : les DEUX stratégies de la liste passent, persist:false aussi', () => {
  expect(validerRequete(requeteAcquire('v', specValide, { ...instanceValide(), strategie: 'inplace', persist: false })).valide).toBe(true);
});

// ── réponses ──────────────────────────────────────────────────────────────────────────────────
test('réponse ok : URL et instanceId traversent intacts', () => {
  expect(lireReponse(reponseOk('http://localhost:14013/mcp', 'vegeta-1'))).toEqual({ ok: true, url: 'http://localhost:14013/mcp', instanceId: 'vegeta-1' });
});

// ⚠️ FAILS-CLOSED : un `ok` sans url construirait `http://undefined/...` côté proxy.
test('réponse ok SANS url = traitée comme une ERREUR, jamais comme un succès vide', () => {
  for (const msg of [{ ok: true }, { ok: true, url: '' }, { ok: true, url: 42 }]) {
    const r = lireReponse(msg);
    expect(r.ok, `doit échouer : ${JSON.stringify(msg)}`).toBe(false);
    expect(r.erreur).toMatch(/url/);
  }
});

// 🛑 Un daemon ANCIEN (serveur PARTAGÉ) répond sans instanceId : REFUSÉ, avec le geste à faire.
test('réponse ok SANS instanceId = daemon PÉRIMÉ, refusé et nommé (jamais accepté « pour compatibilité »)', () => {
  for (const msg of [{ ok: true, url: 'http://localhost:1/mcp' }, { ok: true, url: 'http://localhost:1/mcp', instanceId: '' }, { ok: true, url: 'http://localhost:1/mcp', instanceId: 3 }]) {
    const r = lireReponse(msg);
    expect(r.ok, JSON.stringify(msg)).toBe(false);
    expect(r.erreur).toMatch(/instanceId absent/);
    expect(r.erreur).toMatch(/daemon PÉRIMÉ/);
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

test('PROPERTY round-trip : réponse ok → JSON → réponse ok, url ET instanceId préservés', () => {
  fc.assert(
    fc.property(fc.webUrl(), fc.string({ minLength: 1, maxLength: 40 }), (url, id) => {
      const r = lireReponse(JSON.parse(JSON.stringify(reponseOk(url, id))));
      return r.ok === true && r.url === url && r.instanceId === id;
    }),
    { numRuns: 200 }
  );
});

test('PROPERTY round-trip : requête AVEC instance → JSON → identique (identité, stratégie, persist, dossiers)', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/),
      fc.constantFrom('snapshot', 'inplace'),
      fc.boolean(),
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.string({ minLength: 1, maxLength: 40 }),
      (identite, strategie, persist, storeDir, instancesDir) => {
        const envoye = requeteAcquire('p', specValide, { identite, strategie, persist, storeDir, instancesDir });
        const r = validerRequete(JSON.parse(JSON.stringify(envoye)));
        return r.valide === true && r.instance.identite === identite && r.instance.strategie === strategie
          && r.instance.persist === persist && r.instance.storeDir === storeDir && r.instance.instancesDir === instancesDir;
      }
    ),
    { numRuns: 300 }
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

// ---------- maxBrowsers : un garde-fou CHOISI, jamais un défaut subi ----------
// 🛑 La limite REFUSE, elle n'ÉVINCE PAS. Depuis le refcount du noyau, tout navigateur vivant est
// TENU par un agent : en évincer un casserait S5 (« les autres continuent sans interruption »).

test('ABSENTE par défaut = AUCUNE limite (la machine de l utilisateur décide, pas ce code)', () => {
  expect(lireLimite(undefined)).toBe(null);
  expect(lireLimite(null)).toBe(null);
  expect(placeDisponible(999, lireLimite(undefined)), 'illimité veut dire ILLIMITÉ').toBe(true);
});

test('valeurs ABSURDES => illimité, jamais un blocage (fonction TOTALE, fails-open assumé)', () => {
  for (const v of [0, -1, 2.5, '', 'beaucoup', NaN, Infinity, {}, [], true])
    expect(lireLimite(v), `valeur rejetée: ${String(v)}`).toBe(null);
});

test('valeur VALIDE acceptée, y compris en chaîne (JSON permissif)', () => {
  expect(lireLimite(3)).toBe(3);
  expect(lireLimite('7')).toBe(7);
});

test('la limite borne la CRÉATION : le dernier slot est utilisable, pas un de plus', () => {
  expect(placeDisponible(2, 3), 'il reste de la place').toBe(true);
  expect(placeDisponible(3, 3), 'pile à la limite : REFUS').toBe(false);
  expect(placeDisponible(4, 3), 'au-delà : REFUS').toBe(false);
});

test('property : sous la limite on passe TOUJOURS, à partir d elle on refuse TOUJOURS', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 0, max: 500 }), (limite, n) => {
      expect(placeDisponible(n, limite)).toBe(n < limite);
    })
  );
});

test('property : sans limite, AUCUN nombre de profils ne bloque (même 90 milliards)', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 9e9 }), (n) => placeDisponible(n, null) === true));
});


// ═══ configuration (fichier --config) traverse la frontiere, REVALIDEE (05/09/2026) ═══
test('validerRequete : spec.configuration acceptee et clonee ; absente ⇒ null', () => {
  const cfg = { browser: { contextOptions: { locale: 'fr-FR' } } };
  const v = validerRequete({ op: 'acquire', profile: 'p', spec: { ...specValide, configuration: cfg } });
  expect(v.valide).toBe(true);
  expect(/** @type {any} */ (v).spec.configuration).toEqual(cfg);
  expect(/** @type {any} */ (v).spec.configuration).not.toBe(cfg);
  expect(/** @type {any} */ (validerRequete({ op: 'acquire', profile: 'p', spec: specValide })).spec.configuration).toBe(null);
});

test('validerRequete : une cle reservee glissee par un client est REFUSEE (port/hote/dossier ne se detournent pas)', () => {
  const v = validerRequete({ op: 'acquire', profile: 'p', spec: { ...specValide, configuration: { server: { port: 1 } } } });
  expect(v).toEqual({ valide: false, raison: 'playwrightConfig.server est decide par le proxy (interdit dans le fichier)' });
  const v2 = validerRequete({ op: 'acquire', profile: 'p', spec: { ...specValide, configuration: { browser: { userDataDir: '/x' } } } });
  expect(v2.valide).toBe(false);
});
