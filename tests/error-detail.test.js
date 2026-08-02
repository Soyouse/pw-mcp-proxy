// PUR (Stryker) — describeError : rendre une erreur de transport DIAGNOSTICABLE.
// Ne du bug REEL du 01/08/2026 : `transport error: POST request:` — message VIDE, `err.code`
// jamais journalise ⇒ ~5 h de panne dont la cause premiere est restee inconnue.
//
// ⚠️ Le GATE anti-regression (interdire `e.message` seul dans les chemins de log) vit dans
//    `no-bare-message-gate.test.js` : ici on prouve le COMPORTEMENT, la-bas on scelle l'USAGE.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { describeError, stackOf } from '../src/error-detail.js';

test('LE BUG DU 01/08 : message vide ⇒ le code porte seul le diagnostic', () => {
  // Erreur socket telle que node:http la produit : message vide, code present.
  const err = Object.assign(new Error(''), { code: 'ECONNRESET', syscall: 'read', errno: -4077 });
  const out = describeError(err);
  expect(out).toContain('ECONNRESET'); // <- l'information qui manquait
  expect(out).toContain('syscall=read');
  expect(out).toContain('errno=-4077');
  expect(out).not.toBe(''); // un log vide est EXACTEMENT ce qu'on corrige
});

test('message ET code : les deux, message en tete', () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  expect(describeError(err)).toBe('socket hang up [code=ECONNRESET]');
});

test('message + PLUSIEURS champs : separateur espace conserve (lisibilite du log)', () => {
  // Avec un seul champ, `join(' ')` et `join('')` sont indistinguables : il en faut DEUX
  // pour prouver le separateur. Sinon `code=Csyscall=s` passerait le gate en silence.
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', syscall: 'read' });
  expect(describeError(err)).toBe('socket hang up [code=ECONNRESET syscall=read]');
});

test('erreur nue (aucun champ diagnostique) : le message seul', () => {
  expect(describeError(new Error('boum'))).toBe('boum');
});

test('adresse et port sont repris (quel pair a lache ?)', () => {
  const err = Object.assign(new Error(''), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 51234 });
  expect(describeError(err)).toBe('[code=ECONNREFUSED address=127.0.0.1 port=51234]');
});

test('ordre des champs STABLE : code en premier (le seul qui tranche la nature de la panne)', () => {
  const err = Object.assign(new Error(''), { port: 1, address: 'a', errno: -1, syscall: 's', code: 'C' });
  expect(describeError(err)).toBe('[code=C syscall=s errno=-1 address=a port=1]');
});

test('objet sans message ni code : on le DIT, on ne rend jamais une chaine vide', () => {
  expect(describeError({})).toBe('<no error>');
  expect(describeError(null)).toBe('<no error>');
  expect(describeError(undefined)).toBe('<no error>');
  expect(describeError('')).toBe('<no error>');
});

test('valeurs non-objet : rendues telles quelles', () => {
  expect(describeError('boum')).toBe('boum');
  expect(describeError(42)).toBe('42');
});

test('faute de message, le NOM de l erreur sert de tete (AbortError)', () => {
  const err = Object.assign(new Error(''), { name: 'AbortError' });
  expect(describeError(err)).toBe('AbortError');
});

test('champ vide ou nul : IGNORE (pas de "code=" orphelin dans le log)', () => {
  const err = Object.assign(new Error('x'), { code: '', syscall: null, errno: undefined });
  expect(describeError(err)).toBe('x');
});

test('errno=0 est une VALEUR, pas une absence (piege du falsy)', () => {
  const err = Object.assign(new Error(''), { errno: 0 });
  expect(describeError(err)).toBe('[errno=0]');
});

test('un getter qui explose ne casse JAMAIS le chemin de log', () => {
  const err = { get code() { throw new Error('piege'); }, message: 'ok' };
  expect(describeError(err)).toBe('ok');
});

test('PROPRIETE : fonction TOTALE et JAMAIS vide, quelle que soit l entree', () => {
  fc.assert(
    fc.property(fc.anything(), (x) => {
      const out = describeError(x);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    })
  );
});

test('PROPRIETE : tout code non vide APPARAIT dans la sortie (jamais perdu)', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.string(), (code, msg) => {
      const out = describeError(Object.assign(new Error(msg), { code }));
      expect(out).toContain(code);
    })
  );
});

// ── stackOf ──────────────────────────────────────────────────────────────────────────────────
// ⚠️ ZÉRO test jusqu'au 02/08/2026 : 12 mutants SANS COUVERTURE. Le trou était masqué par le
// score parfait de `channelName` (fonction MORTE) ; la supprimer a fait tomber le total sous le
// cliquet et RÉVÉLÉ ce manque. Leçon : un score global peut être porté par du code inutile.
//
// RAISON D'ÊTRE de la fonction : sur `unhandledRejection`, la raison est de type INCONNU
// (`Promise.reject('boum')` est légal) ⇒ lire `.stack` dessus rendait `undefined` EN SILENCE,
// donc un log tronqué au moment précis où on en a besoin.

test('stackOf : une vraie Error rend sa pile', () => {
  const e = new Error('boum');
  expect(stackOf(e)).toBe(e.stack);
  expect(stackOf(e)).toContain('boum');
});

test('stackOf : rejet NON-Error ⇒ chaine VIDE, jamais `undefined` dans le log', () => {
  // Le cas exact qui motive la fonction : `Promise.reject('boum')`.
  expect(stackOf('boum')).toBe('');
  expect(stackOf(42)).toBe('');
  expect(stackOf(true)).toBe('');
});

test('stackOf : null / undefined ⇒ chaine vide (jamais un throw sur le chemin de log)', () => {
  expect(stackOf(null)).toBe('');
  expect(stackOf(undefined)).toBe('');
});

test('stackOf : objet dont `stack` n est PAS une chaine ⇒ rejete', () => {
  // Un objet exotique peut porter n'importe quoi sous `stack` : on n'accepte QUE du texte,
  // sinon le log recevrait `[object Object]` ou `undefined` au lieu d'une pile.
  expect(stackOf({ stack: 123 })).toBe('');
  expect(stackOf({ stack: null })).toBe('');
  expect(stackOf({ stack: {} })).toBe('');
  expect(stackOf({})).toBe('');
});

test('stackOf : objet SIMPLE portant une `stack` texte ⇒ acceptee (pas besoin d etre une Error)', () => {
  // On teste le CONTRAT (« porte-t-il une pile lisible ? »), jamais `instanceof Error` — une
  // erreur venue d'un autre realm/worker n'est pas `instanceof` la Error locale.
  expect(stackOf({ stack: 'Error: x\n    at y' })).toBe('Error: x\n    at y');
});

test('PROPRIETE : stackOf est TOTALE — toujours une chaine, jamais une exception', () => {
  fc.assert(
    fc.property(fc.anything(), (x) => {
      expect(typeof stackOf(x)).toBe('string');
    })
  );
});
