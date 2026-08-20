// GATE STATIQUE — un module qui AGIT au chargement ne doit jamais pouvoir etre importe par erreur.
//
// 🔴 LA CLASSE D'ERREUR QU'IL FERME (payee du 03/08 au 20/08/2026) : `src/janitor-main.js` se
// terminait par un `await principal()` de TOP-LEVEL, sans aucune garde. Or `tests/janitor.test.js`
// l'importe pour `planInstallation`. Un simple `import` declenchait donc une PASSE DE CONCIERGE
// reelle — `listProcesses()` puis `treeKill()`, c'est-a-dire `process.kill(-pid, 'SIGKILL')` sur
// tout un GROUPE de processus — et Stryker recharge l'environnement de test a chaque mutant.
// En CI, aucun daemon n'ecoute ⇒ `daemonVivant` rend false ⇒ branche DESTRUCTRICE, sur le runner
// GitHub lui-meme. Resultat : « The hosted runner lost communication with the server », 46 a 51 min,
// AUCUN step en echec, AUCUN log televerse. **Le gate de mutation n'a plus rendu de verdict
// pendant 17 jours.**
// ⚠️ ET C'ETAIT INVISIBLE EN LOCAL : sur le poste de dev un daemon REEL ecoute, donc la passe sort
// par la branche inoffensive. Le defaut ne se manifestait QUE la ou personne ne pouvait le lire.
//
// 🛑 POURQUOI UN GATE **STATIQUE** ET NON UN TEST DE COMPORTEMENT : le seul test comportemental
// honnete serait « importer le module et verifier qu'aucune passe ne tourne ». Mais tant que le
// defaut est present, ce test EXECUTE la passe destructrice — c'est-a-dire qu'il tuerait le runner
// qu'il est cense proteger. Un juge ne doit jamais avoir a commettre la faute pour la constater.
// Ici la propriete est DECIDABLE a la lecture de la source : on la decide, sans rien executer.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Un appel de top-level a la fonction principale, avec ou sans `await`, avec ou sans try/catch.
const RX_APPEL_TOP_LEVEL = /^\s*(?:try\s*\{\s*)?(?:await\s+)?(?:principal|main)\s*\(\s*\)/m;
// La garde : une comparaison entre `process.argv[1]` et l'adresse MESUREE du module lui-meme.
const RX_GARDE = /process\.argv\[1\][\s\S]{0,400}?(?:import\.meta\.url|\bMOI\b)|(?:import\.meta\.url|\bMOI\b)[\s\S]{0,400}?process\.argv\[1\]/;

function modulesSources() {
  const noms = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  // ⚠️ Anti-sonde-muette : un dossier mal resolu ressemble EXACTEMENT a un depot parfaitement sain.
  expect(noms.length, 'aucun module lu dans src/ — la sonde vise a cote, elle ne prouve RIEN').toBeGreaterThan(10);
  return noms.map((f) => ({ nom: f, code: fs.readFileSync(path.join(SRC, f), 'utf8') }));
}

test('tout module qui AGIT au chargement porte une garde de point d entree', () => {
  const fautifs = [];
  for (const { nom, code } of modulesSources()) {
    if (!RX_APPEL_TOP_LEVEL.test(code)) continue; // n'agit pas au chargement : rien a garder
    if (!RX_GARDE.test(code)) fautifs.push(nom);
  }
  expect(fautifs,
    "Ces modules executent leur fonction principale au CHARGEMENT, donc un simple `import` " +
    "(un test, un outil, un autre module) declenche leurs effets de bord — ici de l'enumeration " +
    "de processus et des `kill` de GROUPE. Garder l'appel derriere une comparaison entre " +
    "`process.argv[1]` et l'adresse MESUREE du module (`import.meta.url`), jamais une chaine ecrite " +
    "a la main. Fails-closed : importe ⇒ on n'execute pas.").toEqual([]);
});

// 🛑 NEGATIVE-CHECK OBLIGATOIRE (doctrine anti-gate-creux) : un juge qui ne sait pas dire NON ne
// prouve rien. On lui soumet la forme EXACTE qui a coute 17 jours de gate muet.
test('negative-check : la forme fautive du 03/08 est bien REJETEE', () => {
  const fautif = "import { log } from './logger.js';\nasync function principal() {}\ntry { await principal(); } catch (e) { log(e); }\n";
  expect(RX_APPEL_TOP_LEVEL.test(fautif), 'l appel de top-level DOIT etre detecte').toBe(true);
  expect(RX_GARDE.test(fautif), 'et l absence de garde DOIT etre constatee').toBe(false);

  const garde = fautif.replace('try { await principal(); }',
    'const E = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MOI);\nif (E) try { await principal(); }');
  expect(RX_GARDE.test(garde), 'la forme GARDEE doit etre acceptee — sinon le gate serait toujours rouge').toBe(true);
});

// Le cas reel, nomme : il ancre le gate a l'incident plutot qu'a une regle abstraite.
test('janitor-main.js : un import ne doit JAMAIS pouvoir declencher une passe de concierge', () => {
  const code = fs.readFileSync(path.join(SRC, 'janitor-main.js'), 'utf8');
  expect(RX_APPEL_TOP_LEVEL.test(code), 'ce fichier reste bien un point d entree executable').toBe(true);
  expect(RX_GARDE.test(code),
    'et son appel reste GARDE — c est ce qui empeche `tests/janitor.test.js` de tuer le runner').toBe(true);
});
