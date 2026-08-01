// GATE STATIQUE fails-closed — scelle les acquis STRUCTURELS de l'incident 2026-07-31.
//
// ⚠️ POURQUOI UN GATE ET PAS SEULEMENT DES TESTS DE COMPORTEMENT : les tests de `pickPort` prouvent
// que le code ACTUEL se comporte bien. Ils ne protegent PAS contre un agent qui reecrirait le code
// ET ses tests « pour simplifier » (le scenario exact qui a produit `derivePort` le 13/07, puis sa
// justification ecrite « justifie, pas un defaut » qui a ferme le debat pendant 18 jours).
// Ce fichier lit le CODE SOURCE : il rougit meme si tous les autres tests sont reecrits en vert.
//
// ⚠️ ZERO I/O PROCESS : lecture de fichiers uniquement. Ce gate peut tourner pendant que des agents
// utilisent le MCP en production — il ne spawn rien, ne tue rien, ne prend aucun port.
//
// ⚠️ FAILS-CLOSED DES DEUX COTES (anti-gate-creux, doctrine) : la derniere section prouve que ces
// detecteurs savent aussi dire NON, sur des extraits FABRIQUES. Un gate incapable d'echouer ne
// prouve rien — il rassure, ce qui est pire que rien.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const lire = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const modules = () => fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

// Retire les LIGNES DE COMMENTAIRE PUR : un detecteur qui matcherait dans un commentaire rougirait sur
// la doc d'invariant elle-meme (elle NOMME forcement l'interdit pour l'expliquer — « ne jamais
// reintroduire derivePort » contient `derivePort`). On ne juge donc que des lignes de CODE.
//
// ⚠️ VOLONTAIREMENT NAIF, et c'est un CHOIX : la premiere version de ce gate tentait aussi de neutraliser
// les chaines par regex. Resultat le 31/07 : elle effacait `'--port'` AVANT de le chercher (detecteur
// aveugle, donc VERT pour toujours) et un template literal avalait des fichiers entiers. On ne parse pas
// du JavaScript a coups de regex — c'est exactement la fragilite que ce fichier denonce ailleurs.
// Le negative-check en fin de fichier existe pour attraper ce genre de betise : il l'a attrapee.
function codeSeul(source) {
  return source
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

// ---------- 1. le port DERIVE ne revient JAMAIS ----------
test('GATE : aucun calcul de port dans src/ (derivePort/PORT_BASE/PORT_SPAN bannis)', () => {
  // ⚠️ CAUSE RACINE du 31/07 : un port calcule PRESUPPOSE « ce numero sera libre ET joignable ».
  // Faux une seule fois => le profil est mort DEFINITIVEMENT (chaque tentative recalcule le meme).
  // Le rendez-vous multi-agent est le REGISTRE, il n'a jamais eu besoin d'un hash.
  const coupables = [];
  for (const f of modules()) {
    const code = codeSeul(lire(f));
    for (const interdit of ['derivePort', 'PORT_BASE', 'PORT_SPAN']) {
      if (code.includes(interdit)) coupables.push(`${f} → ${interdit}`);
    }
  }
  expect(coupables, 'le proxy ne doit JAMAIS calculer un numero de port — il le DEMANDE a l OS (port-alloc.js)').toEqual([]);
});

test('GATE : aucun port TCP en dur passe au backend (--port suivi d un litteral)', () => {
  // ⚠️ Variante sournoise du meme defaut : « juste une valeur par defaut au cas ou ». Un port fixe
  // ramene exactement la panne, avec en prime une collision garantie entre deux profils.
  const coupables = [];
  for (const f of modules()) {
    const code = codeSeul(lire(f));
    // `--port` suivi d'un nombre, ou une affectation `port = <nombre>` (hors 0 = demande a l'OS).
    if (/--port['"\s,]+\d/.test(code)) coupables.push(`${f} → --port litteral`);
    const affect = code.match(/\bport\s*[:=]\s*(\d+)/g) || [];
    for (const a of affect) if (!/[:=]\s*0\b/.test(a)) coupables.push(`${f} → ${a.trim()}`);
  }
  expect(coupables, 'seul l OS choisit le port (listen(0)) ; aucun numero en dur nulle part').toEqual([]);
});

test('GATE : supervisor.js obtient son port UNIQUEMENT via port-alloc.js', () => {
  // ⚠️ Source UNIQUE d'allocation. Si un jour le superviseur fabrique son port autrement, tout le
  // raisonnement (« le port est forcement libre ») s'effondre en silence.
  const sup = lire('supervisor.js');
  expect(sup, 'import de l allocateur obligatoire').toMatch(/from\s+['"]\.\/port-alloc\.js['"]/);
  expect(codeSeul(sup), 'le port frais vient de l allocateur injecte').toMatch(/_allocatePort\s*\(/);
});

test('GATE : port-alloc alloue sur la LOOPBACK, jamais sur toutes les interfaces', () => {
  // ⚠️ Libre sur 0.0.0.0 ≠ libre sur 127.0.0.1. Le serveur bind `localhost` : interroger l'OS sur une
  // AUTRE interface rendrait un port « valide » que le backend n'arriverait pas a prendre.
  const code = codeSeul(lire('port-alloc.js'));
  expect(code, 'listen(0) = demande a l OS').toMatch(/listen\s*\(\s*0\s*,/);
  expect(code, 'jamais 0.0.0.0 : ce n est pas la meme interface que le bind du serveur').not.toMatch(/0\.0\.0\.0/);
});

// ---------- 2. le WRITE-AHEAD ne s'inverse JAMAIS ----------
test('GATE : l intention `starting` est ECRITE AVANT le poll de readiness (ordre, pas presence)', () => {
  // ⚠️ Inverser cet ordre recree l'ORPHELIN INVISIBLE : un serveur DETACHE existe des le spawn ; s'il
  // n'est inscrit qu'apres ~20 s de poll, toute mort du proxy dans l'intervalle laisse un process
  // vivant que PERSONNE ne connait => panne metastable (le remede fabrique la cause suivante).
  // On verifie l'ORDRE dans le source : une simple presence des deux appels ne prouverait rien.
  const code = codeSeul(lire('supervisor.js'));
  const debut = code.indexOf('_spawnReady');
  const zone = code.slice(debut);
  const iEcriture = zone.indexOf('STATE_STARTING');
  const iPoll = zone.indexOf('_pollReady');
  expect(iEcriture, 'l entree `starting` doit etre ecrite dans _spawnReady').toBeGreaterThan(-1);
  expect(iPoll, 'le poll doit exister').toBeGreaterThan(-1);
  expect(iEcriture, 'INSCRIRE L INTENTION AVANT L ACTION — jamais l inverse').toBeLessThan(iPoll);
});

test('GATE : `startedAt` (spawn) et `spawnedAt` (promotion) restent DEUX champs distincts', () => {
  // ⚠️ Les fusionner raccourcirait la grace de boot du reaper de toute la duree du demarrage =>
  // un serveur SAIN en cours de boot se ferait tuer. Regression silencieuse, tres difficile a voir.
  const reg = codeSeul(lire('server-registry.js'));
  expect(reg).toMatch(/startedAt/);
  expect(reg).toMatch(/spawnedAt/);
  expect(reg, 'promoteServer pose spawnedAt A LA PROMOTION').toMatch(/promoteServer[\s\S]{0,400}spawnedAt/);
});

// ---------- 3. le HANDSHAKE reste borne ----------
test('GATE : le handshake du router passe par deadline.js (jamais une attente sans borne)', () => {
  // ⚠️ C'est l'attente SANS BORNE d'`initialize` qui a tue la session du 31/07 : un serveur stdio
  // n'est JAMAIS reconnecte automatiquement par Claude Code. Retirer cette borne = session morte.
  const router = lire('router.js');
  expect(router, 'import de la course a echeance').toMatch(/from\s+['"]\.\/deadline\.js['"]/);
  expect(codeSeul(router), 'initialize/tools/list sous echeance').toMatch(/withDeadline\s*\(/);
});

test('GATE : aucun delai redeclare hors budget.js (source unique)', () => {
  // ⚠️ C'est la DISPERSION des timeouts couche par couche qui a coute la connexion : chaque couche
  // avait le sien, aucune ne connaissait le mur du client. On interdit les gros litteraux de temps.
  const coupables = [];
  for (const f of modules()) {
    if (f === 'budget.js') continue; // LA source unique, seule autorisee
    const code = codeSeul(lire(f));
    // Litteraux >= 1000 affectes a quelque chose qui ressemble a un delai.
    // ⚠️ Prefixe AUTORISE (`\w*` devant) : sans lui le detecteur etait BORGNE — il voyait
    // `timeout: 5000` mais RATAIT `readyTimeout = 5000`, la forme la plus courante en JS.
    // Trou revele par le negative-check ci-dessous, pas par une relecture. C'est sa raison d'etre.
    const m = code.match(/\w*(?:timeout|delay|ttl|interval|budget|stale|wait)\w*\s*[:=]\s*(\d{4,})/gi) || [];
    for (const hit of m) coupables.push(`${f} → ${hit.trim()}`);
  }
  expect(coupables, 'tout delai vit dans budget.js — jamais recopie ailleurs').toEqual([]);
});

// ---------- 4. NEGATIVE-CHECK : ces detecteurs savent-ils DIRE NON ? ----------
test('NEGATIVE-CHECK : les detecteurs rougissent bien sur du code fautif fabrique', () => {
  // ⚠️ ANTI-GATE-CREUX : sans cette section, un detecteur casse (regex trop stricte, chemin errone)
  // resterait VERT pour toujours et on croirait etre protege. On lui montre la faute a detecter.
  const fautes = {
    'port derive': codeSeul('export function derivePort(p) { return 9300 + hash(p); }'),
    'port en dur': codeSeul("const args = ['--port', 9639];"),
    'affectation de port': codeSeul('const port = 9639;'),
    'delai disperse': codeSeul('const readyTimeout = 20000;'),
    'toutes interfaces': codeSeul("srv.listen(0, '0.0.0.0', cb);"),
  };
  expect(/derivePort|PORT_BASE|PORT_SPAN/.test(fautes['port derive']), 'doit detecter un port derive').toBe(true);
  expect(/--port['"\s,]+\d/.test(fautes['port en dur']), 'doit detecter un --port litteral').toBe(true);
  expect(/\bport\s*[:=]\s*\d+/.test(fautes['affectation de port']), 'doit detecter port = <nombre>').toBe(true);
  expect(/\w*(?:timeout|delay|ttl)\w*\s*[:=]\s*\d{4,}/i.test(fautes['delai disperse']), 'doit detecter un delai disperse MEME en mot compose (readyTimeout)').toBe(true);
  expect(/0\.0\.0\.0/.test(fautes['toutes interfaces']), 'doit detecter le bind trop large').toBe(true);

  // ...et qu'ils ne crient PAS sur du code sain (anti-faux-positif : un gate qui hurle pour rien
  // finit ignore, puis desactive — exactement ce qu'on veut eviter).
  const sain = codeSeul("srv.listen(0, '127.0.0.1', cb); const port = await this._allocatePort();");
  expect(/derivePort|PORT_BASE|PORT_SPAN/.test(sain)).toBe(false);
  expect(/\bport\s*[:=]\s*\d+/.test(sain), 'une allocation dynamique n est PAS un port en dur').toBe(false);
});
