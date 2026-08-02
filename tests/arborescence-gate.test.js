// GATE STATIQUE — `ARBORESCENCE.md` est le FILET D'EXHAUSTIVITÉ, il ne peut pas mentir.
//
// 🛑 POURQUOI UN GATE PLUTÔT QU'UNE RELECTURE. Ce fichier se périme SANS BRUIT : renommer, ajouter
// ou supprimer un module ne le casse pas, aucun test ne rougit, et il dérive un peu à chaque
// session. Mesuré le 02/08 après l'amputation : **22 écarts** d'un coup — 6 fichiers cités qui
// n'existaient plus, 16 fichiers réels absents. Un filet troué ne se voit que le jour où on
// comptait dessus. Aucun humain ne relit : la seule parade est mécanique.
//
// LES DEUX SENS COMPTENT, et pour des raisons DIFFÉRENTES :
//   fichier réel ABSENT de la liste  ⇒ un TROU : le prochain agent ignore que ce fichier existe ;
//   fichier cité mais DISPARU        ⇒ un MENSONGE : il le cherche, ou pire, raisonne dessus.
// ⚠️ NE JAMAIS assouplir en « au moins un des deux » : le second cas est le plus toxique.
//
// ⚠️ La bonne façon de faire passer ce gate est d'ÉCRIRE LA LIGNE (1 fichier = 1 ligne + rôle),
// jamais de retirer un fichier du périmètre.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARBO = fs.readFileSync(path.join(RACINE, 'ARBORESCENCE.md'), 'utf8');

/** Les fichiers SUIVIS PAR GIT = le périmètre exact de ce qui est publié. Pas un glob maison. */
function suivis(motif) {
  // ⚠️ `execFileSync` synchrone assumé : le process est mort au retour, fuite impossible.
  return execFileSync('git', ['ls-files', motif], { cwd: RACINE, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const PERIMETRE = [...suivis('src/*.js'), ...suivis('tests/*.js'), ...suivis('tests/fixtures/*.js')];

test('GATE : tout fichier de src/ et tests/ figure dans ARBORESCENCE.md (aucun TROU)', () => {
  const absents = PERIMETRE.filter((f) => !ARBO.includes(path.basename(f)));
  expect(absents, `Fichiers RÉELS absents du filet — écrire « - \`chemin\` — rôle » pour chacun :\n${absents.join('\n')}`).toEqual([]);
});

test('GATE : tout fichier cité dans ARBORESCENCE.md existe encore (aucun MENSONGE)', () => {
  const cites = [...ARBO.matchAll(/`((?:src|tests|rules|contracts)\/[A-Za-z0-9._/-]+\.(?:js|json|yml))`/g)].map((m) => m[1]);
  const fantomes = [...new Set(cites)].filter((f) => !fs.existsSync(path.join(RACINE, f)));
  expect(fantomes, `Fichiers CITÉS mais DISPARUS (un agent va les chercher) :\n${fantomes.join('\n')}`).toEqual([]);
});

// NEGATIVE-CHECK : sans lui, ce gate pourrait être vert parce qu'il ne lit rien du tout.
test('NEGATIVE-CHECK : les deux détecteurs voient bien un écart fabriqué', () => {
  const faux = '- `src/nexistepas.js` — ligne bidon';
  const cites = [...faux.matchAll(/`((?:src|tests)\/[A-Za-z0-9._/-]+\.js)`/g)].map((m) => m[1]);
  expect(cites, 'le détecteur de citations doit extraire le chemin').toEqual(['src/nexistepas.js']);
  expect(fs.existsSync(path.join(RACINE, cites[0])), 'et constater son absence').toBe(false);
  expect(PERIMETRE.length, 'le périmètre ne doit jamais être vide (sinon le 1er gate est creux)').toBeGreaterThan(20);
});
