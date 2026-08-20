// SOURCE UNIQUE de l'INVOCATION d'ast-grep par les gates statiques de ce dépôt (outil de test).
//
// 🔑 EXTRAIT de `no-inference-gate.test.js` le 20/08/2026, en posant le gate de COMPLEXITÉ :
//    ce code est un NID À PIÈGES et il en fallait un DEUXIÈME consommateur. Deux copies
//    divergeraient au premier piège corrigé d'un seul côté — et le gate resté en arrière
//    deviendrait creux SANS rougir.
//      • ast-grep sort en code NON-ZÉRO dès qu'il TROUVE une occurrence (comportement NORMAL d'un
//        linter en `severity: error`). Le JSON attendu est dans `err.stdout` : sans ce catch, le
//        gate échoue TOUJOURS — y compris quand tout va bien.
//      • Windows : l'invocation passe par cmd.exe (`shell: true`), donc la règle est passée en
//        FICHIER (`-r chemin.yml`), JAMAIS un pattern en argv qui serait découpé aux espaces
//        (piège mesuré le 02/08).
//      • Binaire LOCAL (`node_modules/.bin`) préféré à `npx` : déterministe et hors ligne.
//
// 🛑 FAIL-CLOSED : binaire absent ⇒ THROW. Jamais un résultat vide qui passerait pour « aucune
//    occurrence » — la pire panne d'un gate est celle qui ressemble à une bonne nouvelle.
//
// ⚠️ `execFileSync` SYNCHRONE et non `harness.spawnTracked` : le harnais protège des process qui
//    SURVIVENT au test (serveurs, navigateurs). Ici le process est terminé quand la fonction rend
//    la main — fuite impossible par construction. Exception justifiée, pas un oubli.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function binAstGrep() {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(RACINE, 'node_modules', '.bin', `ast-grep${ext}`);
  if (!fs.existsSync(local)) {
    throw new Error(
      "ast-grep INTROUVABLE dans node_modules/.bin — lancer `npm install`.\n" +
        '🛑 Ne PAS neutraliser ce throw : un scan qui rend [] sans binaire rendrait TOUS les gates AST verts.'
    );
  }
  return local;
}

/**
 * Scan RÉEL (sans cache). Rend UNE entrée PAR OCCURRENCE, chemin RELATIF à la racine, en POSIX.
 * @param {string} regleYml chemin absolu du .yml
 * @param {string[]} cibles chemins RELATIFS à la racine
 * @returns {string[]}
 */
export function scanRegleSansCache(regleYml, cibles) {
  const bin = binAstGrep();
  const opts = {
    cwd: RACINE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  };
  let out;
  try {
    out = execFileSync(bin, ['scan', '-r', regleYml, ...cibles, '--json=compact'], opts);
  } catch (err) {
    // ⚠️ Code non-zéro AVEC un stdout JSON = des occurrences trouvées, PAS un échec.
    if (typeof err.stdout !== 'string' || err.stdout.trim() === '') throw err;
    out = err.stdout;
  }
  return JSON.parse(out || '[]').map((m) => String(m.file).split('\\').join('/'));
}

// ⚠️ CACHE PAR (règle × cibles) — OBLIGATOIRE, ne pas retirer. Chaque test appelait son propre
// scan : avec 2 règles × 5 tests, ça faisait 6 spawns d'ast-grep par run. Le code source ne change
// pas PENDANT le run ⇒ c'était du gaspillage pur, et sur une machine chargée ces scans suffisaient
// à faire déborder les attentes des tests réseau voisins (mesuré 02/08 : http-transport.test.js
// vert seul en 183 ms, ROUGE en suite à 18 s). Un gate ne doit jamais coûter assez cher pour faire
// rougir un AUTRE test : une suite qui rougit au hasard est une suite qu'on cesse de lire.
// `invaliderCacheAstGrep()` existe pour les negative-checks, qui modifient les sources en cours de run.
const _cache = new Map();

export function invaliderCacheAstGrep() {
  _cache.clear();
}

export function scanRegle(regleYml, cibles) {
  const cle = `${regleYml}::${cibles.join('|')}`;
  if (!_cache.has(cle)) _cache.set(cle, scanRegleSansCache(regleYml, cibles));
  return _cache.get(cle);
}

/** Agrège en { cheminRelatif: compte }. */
export function parFichier(occurrences) {
  const par = {};
  for (const f of occurrences) par[f] = (par[f] || 0) + 1;
  return par;
}

/**
 * Agrège en { basename: compte }.
 * ⚠️ À N'UTILISER que sur un périmètre PLAT (`src/` ici) : dès qu'un périmètre a des
 *    sous-dossiers, deux homonymes se confondraient et un budget couvrirait l'autre EN SILENCE.
 */
export function parBasename(occurrences) {
  const par = {};
  for (const f of occurrences) {
    const b = f.split('/').pop();
    par[b] = (par[b] || 0) + 1;
  }
  return par;
}
