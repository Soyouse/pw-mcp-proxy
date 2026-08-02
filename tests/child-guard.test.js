// LE GARDIEN — son contrat, vérifié DIRECTEMENT (et non à travers le daemon).
//
// 🛑 POURQUOI CE FICHIER EXISTE, ET PAS SEULEMENT LE TEST « daemon tué à -9 » :
// ce dernier ne DISCRIMINE PAS sous Windows. Mesuré le 02/08 par negative-check — gardien retiré,
// il reste VERT : Windows place les enfants dans le JOB OBJECT du parent et les tue avec lui, donc
// l'orphelin ne s'y reproduit pas. L'orphelin est un problème **POSIX** (Linux/macOS), où rien
// n'est automatique. Un test qui ne peut pas rougir n'est pas une preuve, c'est une décoration.
// ⇒ ICI on teste le MÉCANISME lui-même — « EOF sur stdin ⇒ l'enfant meurt » — ce qui rougit sur
// TOUS les OS si le lien de vie casse. Le test « -9 » garde sa valeur en CI Linux/macOS (matrice
// 3 OS), là où il devient réellement discriminant.

import { test, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTracked } from './harness.js'; // ⚠️ SEUL moyen de spawner (marqueur + ratchet)
import { isPidAlive, listProcesses } from '../src/prockill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(__dirname, '..', 'src', 'child-guard.js');

/** Attend un FAIT, borné. La mort d'un process est asynchrone : on la MESURE, on ne la suppose pas. */
async function jusqua(cond, budgetMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
  }
}

/** Lance le gardien sur un enfant qui ne meurt JAMAIS seul (sinon le test se prouverait tout seul). */
function lancerGardien(marqueur) {
  const proc = spawnTracked([GUARD, process.execPath, '-e', `/*${marqueur}*/setInterval(()=>{},1000)`], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return proc;
}

const enfantDe = (marqueur) => listProcesses().filter((p) => p.cmd.includes(marqueur) && !p.cmd.includes('child-guard'));

test('CONTRAT : EOF sur stdin (= mort du parent) ⇒ le gardien TUE son enfant et sort', async () => {
  const marqueur = `guard${process.pid}a`;
  const g = lancerGardien(marqueur);

  expect(await jusqua(async () => enfantDe(marqueur).length > 0), 'préalable : l enfant tourne').toBe(true);

  // ⚠️ C'EST TOUT LE MÉCANISME : fermer le tuyau = ce que fait le NOYAU quand le parent meurt,
  // quelle que soit la cause (kill -9, OOM, coupure). Aucun message, aucun signal applicatif.
  g.stdin.destroy();

  expect(await jusqua(async () => enfantDe(marqueur).length === 0),
    'LIEN DE VIE ROMPU : l enfant a survécu à la fermeture du tuyau').toBe(true);
  expect(await jusqua(async () => !isPidAlive(g.pid)), 'le gardien sort aussi (il n a plus d objet)').toBe(true);
}, 40000);

test('SYMÉTRIE : l enfant meurt de lui-même ⇒ le gardien sort (jamais un process qui traîne)', async () => {
  // L'enfant sort tout seul : le gardien n'a plus rien à garder. S'il restait, le daemon croirait
  // le serveur vivant (il surveille le pid du GARDIEN) — un mensonge dont personne ne sortirait.
  const g = spawnTracked([GUARD, process.execPath, '-e', 'process.exit(0)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  expect(await jusqua(async () => !isPidAlive(g.pid)), 'le gardien doit suivre son enfant dans la mort').toBe(true);
}, 40000);

test('commande INLANÇABLE : le gardien SORT, il ne reste jamais un process qui ne garde rien', async () => {
  // ⚠️ `spawnTracked` ajoute TOUJOURS son marqueur en argv (harnais) : le gardien reçoit donc ici
  // une « commande » inlançable plutôt qu'aucune. C'est le cas le plus utile de toute façon —
  // l'invariant qui compte n'est pas le NUMÉRO de sortie, c'est qu'il ne survive pas à vide.
  const g = spawnTracked([GUARD], { stdio: ['pipe', 'ignore', 'ignore'] });
  const code = await new Promise((r) => g.on('exit', r));
  expect(code, 'sortie NON NULLE : l échec est visible, jamais avalé').not.toBe(0);
  expect(isPidAlive(g.pid), 'aucun process fantôme derrière').toBe(false);
}, 20000);
