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
import { readFileSync } from 'node:fs';
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

// 🛑 FUITE DE DESCRIPTEUR — la seule facon dont ce mecanisme peut mourir en silence.
// L'EOF n'arrive QUE si personne d'autre ne detient l'extremite d'ECRITURE du stdin du gardien.
// Si un descripteur fuit (enfant lance en 'inherit', ou pipe partage entre deux gardiens), l'EOF
// n'arrive JAMAIS et l'orphelin revient — sans le moindre message d'erreur.
// Ce test lance DEUX gardiens depuis le MEME process : si les tuyaux fuitaient de l'un a l'autre,
// fermer le premier ne suffirait pas, ou fermer les deux n'en tuerait qu'un.
test('DEUX gardiens : chaque tuyau est INDEPENDANT (aucune fuite de descripteur)', async () => {
  const m1 = `guard${process.pid}b1`;
  const m2 = `guard${process.pid}b2`;
  const g1 = lancerGardien(m1);
  const g2 = lancerGardien(m2);
  expect(await jusqua(async () => enfantDe(m1).length > 0 && enfantDe(m2).length > 0),
    'préalable : les deux enfants tournent').toBe(true);

  // On ne ferme QUE le premier tuyau.
  g1.stdin.destroy();
  expect(await jusqua(async () => enfantDe(m1).length === 0), 'l enfant 1 doit tomber').toBe(true);
  expect(enfantDe(m2).length, "l enfant 2 ne doit RIEN subir : les tuyaux sont independants").toBeGreaterThan(0);

  // Puis le second : il doit tomber AUSSI (donc son EOF n était pas retenu par le premier).
  g2.stdin.destroy();
  expect(await jusqua(async () => enfantDe(m2).length === 0),
    'FUITE DE DESCRIPTEUR : l enfant 2 n a jamais recu son EOF').toBe(true);
}, 60000);

// GATE STATIQUE — l'invariant qui conditionne TOUT le mecanisme, verifie dans la source.
test('GATE : le gardien ne transmet AUCUN descripteur à son enfant', () => {
  const src = readFileSync(new URL('../src/child-guard.js', import.meta.url), 'utf8');
  const spawnEnfant = /spawn\(command, args, \{([^}]*)\}/.exec(src)?.[1] || '';
  expect(spawnEnfant, 'le spawn de l enfant doit être trouvable').not.toBe('');
  expect(spawnEnfant, "stdio:'ignore' OBLIGATOIRE — 'inherit'/'pipe' feraient hériter le tuyau de vie")
    .toMatch(/stdio:\s*'ignore'/);
});
