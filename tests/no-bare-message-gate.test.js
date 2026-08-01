// GATE STATIQUE fails-closed : aucun chemin de LOG ne journalise `err.message` SEUL.
//
// POURQUOI (incident 31/07→01/08/2026) : `transport error: POST request:` — message VIDE.
// L'erreur venait de `node:http`, qui porte TOUJOURS un `err.code` (`ECONNRESET`/`EPIPE`/…).
// Ce champ n'etait pas journalise ⇒ ~5 h de panne, cause premiere JAMAIS identifiee, et un
// diagnostic qu'aucune relecture n'aurait rattrape (le code « avait l'air » correct).
//
// REGLE : dans un fichier d'I/O, toute erreur qui part au log passe par `describeError()`
// (`src/error-detail.js`). `err.message` seul est INTERDIT : il peut etre vide, `err.code` non.
//
// ⚠️ Gate deliberement TEXTUEL et etroit : il ne scanne QUE les fichiers d'I/O reseau/process
//    et ne cherche QU'UN motif (`.message` concatene/interpole dans un log ou un _fail).
//    Un gate large produirait des faux positifs, donc des exemptions, donc plus de gate.
// ⚠️ NE JAMAIS ajouter un fichier a EXEMPTS pour faire passer le test : c'est la classe
//    d'erreur entiere qu'on scelle. Corriger l'appel, pas la liste.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Fichiers d'I/O ou une erreur remonte d'un pair distant / du noyau : ce sont EXACTEMENT
// ceux dont l'erreur peut avoir un message vide et un code parlant.
const IO_FILES = ['http-transport.js', 'stdio-transport.js', 'supervisor.js', 'notify.js', 'backend.js'];

// `.message` utilise dans une CONCATENATION ou une INTERPOLATION (donc destine a etre affiche).
// ⚠️ `\??\.` OBLIGATOIRE : la 1re version de ce gate ratait `e?.message` — c'etait PRECISEMENT
//    la ligne de `backend.js` qui a produit le log vide du 01/08. Un gate qui rate son propre
//    cas fondateur est pire qu'aucun gate (il rassure a tort).
// ⚠️ Le repli `(e?.message || e)` est AUSSI interdit : sur une Error a message vide il rend ''
//    (chaine vide, falsy... mais deja consommee par l'interpolation) — le bug exact.
const RX_BARE = /(?:\+\s*\w+\??\.message\b|\$\{\s*\w+\??\.message\b[^}]*\}|\w+\??\.message\s*\+)/g;

function stripComments(code) {
  return code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('aucun `err.message` NU dans un chemin de log d I/O (incident 01/08)', () => {
  const fautifs = IO_FILES.filter((f) => fs.existsSync(path.join(SRC, f)))
    .map((f) => {
      const code = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
      return { f, n: (code.match(RX_BARE) || []).length };
    })
    .filter(({ n }) => n > 0);

  expect(
    fautifs,
    `\`err.message\` seul dans : ${fautifs.map((x) => `${x.f}(${x.n})`).join(', ')}\n` +
      `→ Utiliser describeError(e) (src/error-detail.js) : un message peut etre VIDE, err.code non.\n` +
      `→ C'est la cause exacte pour laquelle l'incident du 01/08 est reste non diagnosticable.`
  ).toEqual([]);
});

test('NEGATIVE-CHECK : le gate detecte VRAIMENT le motif interdit', () => {
  // Sans ce test, un gate dont la regex ne matche plus rien resterait VERT a jamais.
  const echantillons = [
    "log('x: ' + e.message)",
    'log(`x: ${e.message}`)',
    "this._fail(err.message + '!')",
    'log(`x: ${e?.message}`)', // <- cas RATE par la 1re version du gate
    'log(`x: ${e?.message || e}`)', // <- la ligne EXACTE de l'incident du 01/08
  ];
  for (const s of echantillons) expect(s.match(RX_BARE), s).not.toBeNull();
  // Et il n'accuse pas un usage legitime (message lu, pas concatene vers un log).
  expect('const m = e.message;'.match(RX_BARE)).toBeNull();
});
