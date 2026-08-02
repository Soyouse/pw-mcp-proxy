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

// Dossiers où un nom NU (`foo.test.js`, sans préfixe) peut légitimement se résoudre.
// ⚠️ ORDRE SANS IMPORTANCE : on cherche l'existence, pas la priorité.
const RACINES_DE_RESOLUTION = ['', 'src', 'tests', 'tests/fixtures', 'rules', 'contracts'];

/** Le fichier existe-t-il sous l'une des racines connues ? */
function existeQuelquePart(nom) {
  return RACINES_DE_RESOLUTION.some((d) => fs.existsSync(path.join(RACINE, d, nom)));
}

test('GATE : tout fichier cité dans ARBORESCENCE.md existe encore (aucun MENSONGE)', () => {
  // ⚠️ DEUX FORMES DE CITATION, et la seconde a été un TROU BÉANT jusqu'au 02/08/2026.
  //   ① chemin PRÉFIXÉ   `src/foo.js`      — seule forme détectée à l'origine
  //   ② nom NU           `foo.test.js`     — ÉCHAPPAIT au gate, qui restait VERT
  // Mesuré à la découverte : **7 fichiers fantômes** cités en forme ② (supervisor.js,
  // clock.test.js, server-registry.test.js, proc-identity*.test.js, launch-channel.test.js)
  // survivaient à l'amputation du superviseur, gate au vert. Un filet qui ne couvre qu'une
  // moitié de la surface donne la CONFIANCE sans la protection — pire qu'aucun filet.
  // ⚠️ NE JAMAIS restreindre à la forme ① « parce que c'est la convention » : l'arbo est
  // écrite à la main, les deux formes y coexistent, et c'est un FAIT à couvrir, pas un style.
  const prefixes = [...ARBO.matchAll(/`((?:src|tests|rules|contracts)\/[A-Za-z0-9._/-]+\.(?:js|json|yml))`/g)].map((m) => m[1]);
  const nus = [...ARBO.matchAll(/`([A-Za-z0-9._-]+\.(?:js|json|yml))`/g)].map((m) => m[1]);

  const fantomes = [
    ...new Set([
      ...prefixes.filter((f) => !fs.existsSync(path.join(RACINE, f))),
      ...nus.filter((f) => !existeQuelquePart(f)),
    ]),
  ];
  expect(fantomes, `Fichiers CITÉS mais DISPARUS (un agent va les chercher) :\n${fantomes.join('\n')}`).toEqual([]);
});

// ⚠️ LA LISTE DE CIBLES D'UNE CONFIG EST UNE CITATION COMME UNE AUTRE — et elle ment PIRE.
// `vitest.pure.config.js` énumère les suites que Stryker mute (via `stryker.conf.json`).
// Vitest IGNORE EN SILENCE une entrée `include` qui ne matche aucun fichier : une suite
// renommée sort donc de la MUTATION sans un seul mot, et le score reste vert sur un
// périmètre AMPUTÉ. Mesuré le 02/08/2026 : **4 entrées fantômes** (server-registry,
// listening-line, proc-identity-pure, clock) laissées par l'amputation.
// ⚠️ Ce gate ne vérifie PAS l'inverse (une suite pure absente de la liste) : ce serait un
// autre invariant, et `stryker.conf.json` en est la source — ne pas les confondre ici.
test('GATE : toute suite listée dans vitest.pure.config.js existe (Stryker ne mute pas du vide)', () => {
  const cfg = fs.readFileSync(path.join(RACINE, 'vitest.pure.config.js'), 'utf8');
  const cibles = [...cfg.matchAll(/'(tests\/[A-Za-z0-9._/-]+\.js)'/g)].map((m) => m[1]);
  expect(cibles.length, 'la liste ne doit jamais être vide (sinon ce gate est creux)').toBeGreaterThan(5);
  const fantomes = cibles.filter((f) => !fs.existsSync(path.join(RACINE, f)));
  expect(fantomes, `Suites listées mais INEXISTANTES — vitest les ignore en SILENCE :\n${fantomes.join('\n')}`).toEqual([]);
});

// NEGATIVE-CHECK : sans lui, ce gate pourrait être vert parce qu'il ne lit rien du tout.
test('NEGATIVE-CHECK : les deux détecteurs voient bien un écart fabriqué', () => {
  const faux = '- `src/nexistepas.js` — ligne bidon';
  const cites = [...faux.matchAll(/`((?:src|tests)\/[A-Za-z0-9._/-]+\.js)`/g)].map((m) => m[1]);
  expect(cites, 'le détecteur de citations doit extraire le chemin').toEqual(['src/nexistepas.js']);
  expect(fs.existsSync(path.join(RACINE, cites[0])), 'et constater son absence').toBe(false);
  expect(PERIMETRE.length, 'le périmètre ne doit jamais être vide (sinon le 1er gate est creux)').toBeGreaterThan(20);
});
