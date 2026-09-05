// DRIFT-TEST des surfaces TIERCES — `contracts/playwright-mcp.json` vs le binaire RÉEL.
//
// ⚠️ POURQUOI (né le 02/08/2026) : ce projet dépend de flags `@playwright/mcp` que PERSONNE ne
// surveille. Jusqu'ici, chaque changement d'upstream était redécouvert À LA MAIN, une session sur
// deux, en relisant `--help`. C'est du travail humain répétitif = un défaut du système (doctrine
// « tuer le travail »). Ici la machine le fait : au bump de version, un flag disparu devient ROUGE
// AVANT tout déploiement, jamais une panne en prod.
//
// Quatre niveaux, volontairement distincts :
//   1. REQUIS   — flags que le code CONSTRUIT. Disparition = le proxy est cassé => ROUGE FATAL.
//   2. INTERDITS— flags dont la PRÉSENCE dans une spec construite par le proxy est une régression
//                 (collision d'agents mesurée 04/09/2026, `--shared-browser-context`). Le littéral
//                 ne doit exister nulle part dans `src/`, et l'interdit doit rester dans le binaire
//                 (sinon il n'a plus de sens et doit être réexaminé).
//   3. ABSENTS  — capacités vérifiées absentes. Leur APPARITION est une BONNE nouvelle : un
//                 auto-shutdown natif rendrait le daemon maison inutile. ROUGE = « va SIMPLIFIER ».
//   4. SURFACE  — tous les flags du snapshot. Divergence = l'upstream a bougé, relire les diffs.
//
// ⚠️ NE JAMAIS « corriger » un rouge en éditant le JSON pour qu'il colle. Le rouge est le PRODUIT
// de ce test. La marche à suivre est : re-capturer, LIRE les diffs, décider, puis mettre à jour
// le snapshot ET le skill `playwright-mcp-api` ET le BACKLOG dans le même geste.
//
// ⚠️ `--help` ne lance AUCUN navigateur (mesuré : 3,6 s) => ce test tourne TOUJOURS, sans skip.
// Un drift-test qu'on saute par défaut ne protège de rien.

import { test, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRegle, invaliderCacheAstGrep } from './ast-grep.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'playwright-mcp.json'), 'utf8'));

let reels = null; // flags lus sur le binaire

beforeAll(() => {
  // ⚠️ `execFileSync` synchrone assumé hors harnais : le process est MORT au retour, fuite
  // impossible par construction (même exception justifiée que dans no-inference-gate).
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['-y', `${SNAP.package}@${SNAP.version}`, '--help'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }
  );
  reels = new Set(out.match(/--[a-z-]+/g) || []);
}, 120000);

test('REQUIS : tous les flags que le code construit existent encore dans le binaire', () => {
  const manquants = SNAP.requis.flags.filter((f) => !reels.has(f));
  expect(
    manquants,
    `⛔ FATAL — flag(s) disparu(s) de ${SNAP.package}@${SNAP.version} : ${manquants.join(', ')}\n` +
      `Le proxy les CONSTRUIT (src/spec.js, src/supervisor.js) : il est cassé en production.\n` +
      `NE PAS retirer la ligne du snapshot — corriger le code, ou re-piner la version.`
  ).toEqual([]);
});

test('ABSENTS : aucun auto-shutdown natif n est apparu (sinon : le daemon devient INUTILE)', () => {
  const apparus = SNAP.absents.flags.filter((f) => reels.has(f));
  expect(
    apparus,
    `🎁 BONNE NOUVELLE — ${SNAP.package} expose maintenant : ${apparus.join(', ')}\n` +
      `Le serveur saurait s'arrêter seul ⇒ le daemon maison (et sa complexité) n'a peut-être PLUS\n` +
      `de raison d'être. Relire « QUI DOIT ARRÊTER LE SERVEUR » dans le skill et SIMPLIFIER.\n` +
      `Ce rouge signale une OPPORTUNITÉ, pas une panne.`
  ).toEqual([]);
});

test('SURFACE : la liste de flags est identique au snapshot (sinon l upstream a bougé)', () => {
  const attendus = new Set(SNAP.surfaceComplete.flags);
  const ajoutes = [...reels].filter((f) => !attendus.has(f)).sort();
  const retires = [...attendus].filter((f) => !reels.has(f)).sort();
  expect(
    { ajoutes, retires },
    `L'upstream a bougé depuis le snapshot du ${SNAP.captureLe} (version ${SNAP.version}).\n` +
      `AJOUTÉS : ${ajoutes.join(', ') || '(aucun)'}\nRETIRÉS : ${retires.join(', ') || '(aucun)'}\n` +
      `→ LIRE les diffs, décider, puis mettre à jour snapshot + skill playwright-mcp-api + BACKLOG.`
  ).toEqual({ ajoutes: [], retires: [] });
});

// ⚠️ AST, JAMAIS une lecture textuelle : un commentaire qui EXPLIQUE pourquoi le flag est banni
// contient le flag. La première version (lecture `includes` des sources) rougissait sur 3
// commentaires (05/09/2026) — un juge qui refuse le progrès qu'il provoque finit désarmé.
// `rules/no-forbidden-flag.yml` ne regarde que les `string_fragment` (contenu des chaînes).
const REGLE_INTERDITS = path.join(ROOT, 'rules', 'no-forbidden-flag.yml');

test('INTERDITS : aucun flag interdit dans un LITTÉRAL de chaîne de src/ (AST, commentaires ignorés)', () => {
  const occurrences = scanRegle(REGLE_INTERDITS, ['src']);
  expect(
    occurrences,
    `⛔ FLAG INTERDIT dans une chaîne de src/ :\n${occurrences.join('\n')}\n${SNAP.interdits._pourquoi}\n` +
      `Retirer le littéral du/des fichier(s) nommé(s) ci-dessus (un commentaire, lui, est autorisé).`
  ).toEqual([]);
});

// 🛑 CLIQUET EXACT entre la POLITIQUE (contrat) et la DÉTECTION (règle) : un interdit ajouté au
// contrat sans sa ligne `regex:` serait un permis dormant (le contrat le dit, personne ne le voit).
test('INTERDITS : chaque flag interdit du contrat a SA ligne regex dans rules/no-forbidden-flag.yml', () => {
  const regle = fs.readFileSync(REGLE_INTERDITS, 'utf8');
  const sansRegle = SNAP.interdits.flags.filter((f) => !regle.includes(`regex: '${f}'`));
  expect(sansRegle, `⛔ interdit(s) sans détection AST : ${sansRegle.join(', ')}`).toEqual([]);
});

// NEGATIVE-CHECK (joué à chaque run, jamais « une fois à la pose ») : un fichier de src/ qui porte
// le flag dans une CHAÎNE doit être NOMMÉ ; le même flag dans un COMMENTAIRE ne doit pas l'être.
test('INTERDITS : la règle NOMME une chaîne fautive et IGNORE un commentaire (negative-check permanent)', () => {
  const leurre = path.join(ROOT, 'src', 'zz-sonde-interdit.js');
  const flag = SNAP.interdits.flags[0];
  try {
    fs.writeFileSync(leurre, `// ${flag} dans un commentaire : autorise\nexport const args = ['${flag}'];\n`);
    invaliderCacheAstGrep();
    const occ = scanRegle(REGLE_INTERDITS, ['src']);
    expect(occ.filter((f) => f.endsWith('zz-sonde-interdit.js')).length, 'UNE occurrence : la chaîne, pas le commentaire').toBe(1);
    fs.writeFileSync(leurre, `// ${flag} seulement en commentaire\nexport const rien = 1;\n`);
    invaliderCacheAstGrep();
    expect(scanRegle(REGLE_INTERDITS, ['src']).filter((f) => f.endsWith('zz-sonde-interdit.js')), 'un commentaire seul = silence').toEqual([]);
  } finally {
    try { fs.unlinkSync(leurre); } catch { /* SILENCE: leurre deja retire */ }
    invaliderCacheAstGrep();
  }
});

test('INTERDITS ⊂ SURFACE : un interdit disparu du binaire doit ROUGIR pour être réexaminé', () => {
  const surface = new Set(SNAP.surfaceComplete.flags);
  const disparus = SNAP.interdits.flags.filter((f) => !surface.has(f));
  expect(
    disparus,
    `⛔ Flag(s) interdit(s) absent(s) de surfaceComplete : ${disparus.join(', ')}\n` +
      `Un interdit qui n'existe plus dans le binaire n'a plus de raison d'être interdit : c'est une` +
      ` OPPORTUNITÉ de le retirer de la liste (avec sa justification), jamais un silence.`
  ).toEqual([]);
});

test('le snapshot est PINNÉ sur la version réellement utilisée par la prod', () => {
  const profiles = path.join(ROOT, 'profiles.example.json');
  const txt = fs.readFileSync(profiles, 'utf8');
  expect(
    txt.includes(`@playwright/mcp@${SNAP.version}`),
    `Le snapshot cible ${SNAP.version} mais profiles.example.json épingle autre chose.\n` +
      `Deux vérités qui divergent = le drift-test surveille une version que personne n'exécute.`
  ).toBe(true);
});
