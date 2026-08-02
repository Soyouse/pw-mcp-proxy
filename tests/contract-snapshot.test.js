// DRIFT-TEST des surfaces TIERCES — `contracts/playwright-mcp.json` vs le binaire RÉEL.
//
// ⚠️ POURQUOI (né le 02/08/2026) : ce projet dépend de flags `@playwright/mcp` que PERSONNE ne
// surveille. Jusqu'ici, chaque changement d'upstream était redécouvert À LA MAIN, une session sur
// deux, en relisant `--help`. C'est du travail humain répétitif = un défaut du système (doctrine
// « tuer le travail »). Ici la machine le fait : au bump de version, un flag disparu devient ROUGE
// AVANT tout déploiement, jamais une panne en prod.
//
// Trois niveaux, volontairement distincts :
//   1. REQUIS   — flags que le code CONSTRUIT. Disparition = le proxy est cassé => ROUGE FATAL.
//   2. ABSENTS  — capacités vérifiées absentes. Leur APPARITION est une BONNE nouvelle : un
//                 auto-shutdown natif rendrait le daemon maison inutile. ROUGE = « va SIMPLIFIER ».
//   3. SURFACE  — les 47 flags du snapshot. Divergence = l'upstream a bougé, relire les diffs.
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

test('le snapshot est PINNÉ sur la version réellement utilisée par la prod', () => {
  const profiles = path.join(ROOT, 'profiles.example.json');
  const txt = fs.readFileSync(profiles, 'utf8');
  expect(
    txt.includes(`@playwright/mcp@${SNAP.version}`),
    `Le snapshot cible ${SNAP.version} mais profiles.example.json épingle autre chose.\n` +
      `Deux vérités qui divergent = le drift-test surveille une version que personne n'exécute.`
  ).toBe(true);
});
