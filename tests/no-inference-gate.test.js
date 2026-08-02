// GATE STATIQUE fails-closed : le TEMPS est une ressource RARE et DÉCLARÉE.
//
// POURQUOI (incident 31/07→01/08/2026, ~5 h de blocage) : un délai ne répond jamais à
// « est-il mort ? » — il le DEVINE. `registry lock: timeout` a bouclé sur tous les profils
// alors qu'aucun verrou n'était réellement orphelin : la cascade crash→respawn saturait le
// verrou plus vite qu'il ne se libérait. Or AUCUNE question posée par supervisor.js n'exige
// un délai : le noyau y répond EXACTEMENT et par ÉVÉNEMENT (fin de processus, socket fermé
// par l'OS, EADDRINUSE).
//
// RÈGLE (universelle — memory feedback-interroger-ce-qui-sait) :
//   On n'interroge QUE ce qui SAIT. Un délai n'est recevable que dans 2 cas :
//     • "distant"     : aucune autorité joignable (réseau, autre machine)
//     • "indécidable" : « vivant mais figé » vs « vivant mais lent » → problème de l'arrêt
//   Tout le reste est LOCAL ⇒ le noyau sait ⇒ un délai y est un BUG, pas un compromis.
//
// ⚠️ DÉTECTION PAR AST (ast-grep + tree-sitter), JAMAIS par regex : `setTimeout` dans un
//    commentaire ou une chaîne produirait un faux positif, et une regex rate ce qu'elle
//    n'a pas prévu. Règle : rules/no-undeclared-timing.yml (source unique du MOTIF).
// ⚠️ SÉPARATION : ast-grep DÉTECTE (aucune exemption dedans) · ce fichier décide la POLITIQUE
//    (budget par fichier + justification). Dupliquer les exemptions des deux côtés créerait
//    deux vérités qui divergent.
// ⚠️ Ce gate NE JUGE PAS si un délai est légitime (théorème de Rice : indécidable). Il rend
//    le pari VISIBLE et COÛTEUX — il faut l'écrire, le nommer, le défendre au diff.
// ⚠️ NE JAMAIS augmenter un budget pour faire passer le test. Un délai de plus se justifie
//    en revue, pas en éditant la baseline.

import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = path.join(ROOT, 'rules', 'no-undeclared-timing.yml');

// ── BASELINE : état MESURÉ le 01/08/2026 (ast-grep ET regex concordants : 2/1/4).
//    `max` est un CLIQUET — il ne peut que DESCENDRE. ──
const BUDGET = {
  'backend.js': {
    max: 2,
    motif: 'indécidable',
    pourquoi:
      "watchdog ping MCP : distinguer un backend FIGÉ d'un backend OCCUPÉ est le problème de " +
      "l'arrêt — aucune observation exacte n'existe. Seul délai théoriquement irréductible.",
  },
  'http-transport.js': {
    max: 1,
    motif: 'distant',
    pourquoi: 'I/O réseau : le pair est hors de portée du noyau local, aucune autorité à interroger.',
  },
  // ⚠️ CLIQUET DESCENDU 4 → 3 le 02/08 : la readiness est partie dans readiness.js (source unique
  // partagée avec le daemon). Ne JAMAIS le remonter — un budget ne se relâche pas parce qu'on
  // réorganise le code.
  'readiness.js': {
    max: 2,
    motif: 'indécidable',
    pourquoi:
      "budget d'UNE sonde HTTP + pause entre deux sondes. La question « ce serveur écoutera-t-il ? » " +
      "est le problème de l'arrêt : aucune observation ne tranche. ⚠️ Mais les DEUX autres issues, " +
      'elles, sont des FAITS SANS délai (port qui répond ⇒ prêt · process disparu ⇒ mort) — le ' +
      'budget ne sert QUE au cas « vivant mais muet ». Modèle systemd Type=notify.',
    impact:
      "Si le budget expire sur un serveur SAIN mais lent : verdict 'muet' ⇒ le serveur est tué et " +
      'respawné pour rien. ⚠️ ATTÉNUÉ par construction : le verdict à 3 états rend la mort du ' +
      'process immédiate, donc le budget ne peut plus déclarer cassé un process qui a simplement ' +
      "démarré lentement. C'est le défaut mesuré le 02/08 (7 tests rouges, machine chargée).",
  },
  // ⛔ `supervisor.js` RETIRÉ le 03/08 avec le fichier lui-même. Cible 0 ATTEINTE — pas par un
  // réglage, par la SUPPRESSION du composant. La DETTE d'appels temporels est donc à ZÉRO.
};

// Constantes temporelles : tolérées UNIQUEMENT dans la source unique + le pur qui les REÇOIT.
const CONST_OK = new Set(['budget.js', 'auto-restart.js']);
const RX_CONST = /\b([A-Z][A-Z0-9_]*(?:_MS|_TIMEOUT|_TTL|_INTERVAL|_DELAY|_STALE|_RETRY)[A-Z0-9_]*)\s*=/g;

function binAstGrep() {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(ROOT, 'node_modules', '.bin', `ast-grep${ext}`);
  return fs.existsSync(local) ? local : `npx${ext}`;
}

/**
 * Détections réelles par fichier, via AST.
 *
 * ⚠️ `execFileSync` SYNCHRONE et non `harness.spawnTracked` : le harnais protège des process
 *    qui SURVIVENT au test (serveurs, navigateurs). Ici le process est terminé quand la
 *    fonction rend la main — fuite impossible par construction. Exception justifiée, pas un oubli.
 * ⚠️ ast-grep sort en code NON-ZÉRO dès qu'il TROUVE une occurrence (comportement normal d'un
 *    linter avec `severity: error`). NE PAS traiter ça comme un échec : le JSON attendu est
 *    dans `err.stdout`. Sans ce catch, le gate échoue toujours — y compris quand tout va bien.
 */
// ⚠️ CACHE PAR RÈGLE — OBLIGATOIRE, ne pas retirer. Chaque test appelait son propre scan : avec
// 2 règles × 5 tests, ça faisait 6 spawns d'ast-grep par run. Le code source ne change pas PENDANT
// le run, donc 5 de ces scans étaient du gaspillage pur — et sur une machine chargée ils suffisaient
// à faire déborder les attentes des tests réseau voisins (mesuré 02/08 : http-transport.test.js
// vert seul en 183 ms, ROUGE en suite à 18 s). Un gate ne doit jamais coûter assez cher pour
// faire rougir un AUTRE test : une suite qui rougit au hasard est une suite qu'on cesse de lire.
// `_invalider()` existe pour les negative-checks, qui eux modifient src/ en cours de run.
const _cache = new Map();
function _invalider() { _cache.clear(); }

// ⚠️ Règle passée en PARAMÈTRE (un fichier YAML), jamais un pattern en argv : sur Windows
// l'invocation passe par cmd.exe qui découperait le pattern à l'espace (piège mesuré le 02/08).
function scanRule(rule) {
  if (_cache.has(rule)) return _cache.get(rule);
  const res = _scanRuleUncached(rule);
  _cache.set(rule, res);
  return res;
}

function _scanRuleUncached(rule) {
  const bin = binAstGrep();
  const base = bin.startsWith('npx') ? ['ast-grep'] : [];
  const opts = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  };
  let out;
  try {
    out = execFileSync(bin, [...base, 'scan', '-r', rule, 'src', '--json=compact'], opts);
  } catch (err) {
    if (typeof err.stdout !== 'string') throw err; // vrai échec (binaire absent, règle invalide)
    out = err.stdout;
  }
  const par = {};
  for (const m of JSON.parse(out || '[]')) {
    const f = String(m.file).split(/[/\\]/).pop();
    par[f] = (par[f] || 0) + 1;
  }
  return par;
}

// ═══ VOLET 2 : le RAISONNEMENT temporel (`now - t > seuil`) ═══════════════════════════════════
//
// ⚠️ ANGLE MORT COMBLÉ LE 02/08/2026. Le volet 1 ci-dessus ne détecte que les APPELS temporels.
// Il se croyait exhaustif avec 7 points — il en manquait 7 AUTRES, sans aucun setTimeout dedans :
//   server-registry.js x3  « ce client vit-il ? ce démarrage a-t-il abouti ? »  (module PUR !)
//   supervisor.js      x3  LOCK_STALE_MS — l'inférence EXACTE de la panne de 5 h du 31/07→01/08,
//                          que le gate censé la surveiller ne voyait PAS
//   supervisor.js      x1  boucle de poll ready
// Leçon : un module PUR qui reçoit `now` en paramètre est parfaitement testable ET parfaitement
// inférentiel. La pureté rend une supposition VÉRIFIABLE, jamais VRAIE.
const BUDGET_INFERENCE = {
  // ⛔ LA DETTE EST TOMBÉE À ZÉRO LE 02/08. `server-registry.js` (3 comparaisons d'horodatage,
  // « ce client bat-il encore ? ») et `supervisor.js` (4) ont été SUPPRIMÉS avec le registre : la
  // question ne se pose plus, la fermeture de la socket est un ÉVÉNEMENT exact du noyau.
  // ⚠️ Plus AUCUNE entrée `motif: 'DETTE'` ne subsiste ici. En réintroduire une exige de démontrer
  // qu'aucune autorité locale ne peut répondre — sinon c'est le bug du 31/07 qui revient.
  // ⚠️ 1 comparaison : la borne de boucle de `attendreReady`. Le budget n'y est qu'un FILET —
  // les deux issues utiles (port qui répond / process mort) sont des faits SANS délai.
  'readiness.js': {
    max: 1,
    motif: 'indécidable',
    pourquoi:
      "borne de l'attente « vivant mais muet » — problème de l'arrêt, aucune observation ne tranche.",
  },
  // ⛔ `supervisor.js` RETIRÉ le 03/08 avec le fichier. Le verrou à péremption (LOCK_STALE_MS),
  // cause de la cascade de 5 h du 31/07, n'existe plus : le canal nommé rend le verrou périmé
  // IMPOSSIBLE par construction. Cible 0 ATTEINTE par suppression, pas par réglage.
};

// ⚠️ Toute entrée en DETTE DOIT porter son IMPACT — ajouté le 02/08 après une leçon coûteuse.
// Les deux lignes de `_pollReady` qui transformaient une machine lente en PANNE étaient DÉJÀ
// comptées par ce gate. Il disait « 4 en dette, cible 0 » ; il ne disait pas qu'une de ces 4
// déclarait cassé un serveur parfaitement sain. J'ai lu un COMPTEUR, pas un RISQUE.
// Un budget mesure la QUANTITÉ d'inférence ; sans `impact`, il n'en mesure jamais la GRAVITÉ.
// Écrire la conséquence FORCE à se demander « et si ça décide faux ? » — au moment où on ajoute
// la dette, pas trois semaines plus tard en pleine panne.
test('CHAQUE dette déclare son IMPACT (le compteur ne dit pas la gravité)', () => {
  const sansImpact = [];
  for (const [nom, budget] of [['appels', BUDGET], ['inférence', BUDGET_INFERENCE]]) {
    for (const [f, b] of Object.entries(budget)) {
      if (b.motif !== 'DETTE') continue;
      if (typeof b.impact !== 'string' || b.impact.trim().length < 40) sansImpact.push(`${nom}/${f}`);
    }
  }
  expect(
    sansImpact,
    `Dette SANS impact déclaré : ${sansImpact.join(', ')}\n` +
      `→ Écrire ce qui se passe quand cette inférence décide FAUX. Un compteur seul ne hiérarchise ` +
      `rien : on relit « 4 en dette » sans voir que l'une d'elles casse sous charge (vécu le 02/08).`
  ).toEqual([]);
});

function scanInference() {
  return scanRule(path.join(ROOT, 'rules', 'no-temporal-inference.yml'));
}

test('aucune comparaison d horodatage dans un fichier NON déclaré (une inférence se déclare aussi)', { timeout: 30000 }, () => {
  const clandestins = Object.entries(scanInference()).filter(([f]) => !BUDGET_INFERENCE[f]);
  expect(
    clandestins,
    `Comparaison d'horodatage dans un fichier non déclaré : ${clandestins.map(([f, n]) => `${f}(${n})`).join(', ')}\n` +
      `→ \`now - t > seuil\` ne CONSTATE rien, il SUPPOSE. QUI SAIT ? Local ⇒ le noyau, par événement.\n` +
      `→ Si vraiment "distant" ou "indécidable", le déclarer dans BUDGET_INFERENCE avec sa justification.`
  ).toEqual([]);
});

test('CLIQUET INFÉRENCE : aucun fichier déclaré ne dépasse son budget de comparaisons', { timeout: 30000 }, () => {
  const par = scanInference();
  const debordements = Object.entries(BUDGET_INFERENCE)
    .map(([f, b]) => ({ f, max: b.max, n: par[f] || 0 }))
    .filter(({ n, max }) => n > max);
  expect(
    debordements,
    `Budget d'inférence dépassé : ${debordements.map((d) => `${d.f} ${d.n}>${d.max}`).join(', ')}\n` +
      `→ NE PAS augmenter le budget pour faire passer ce test. Le cliquet ne DESCEND que.`
  ).toEqual([]);
});

test('aucun appel temporel dans un fichier NON déclaré (le temps se déclare)', { timeout: 30000 }, () => {
  const clandestins = Object.entries(scanRule(RULE)).filter(([f]) => !BUDGET[f]);
  expect(
    clandestins,
    `Appel temporel dans un fichier non déclaré : ${clandestins.map(([f, n]) => `${f}(${n})`).join(', ')}\n` +
      `→ Avant d'ajouter un délai : QUI SAIT ? Local ⇒ le noyau sait, le délai est un bug.\n` +
      `→ Si vraiment "distant" ou "indécidable", le déclarer dans BUDGET avec sa justification.`
  ).toEqual([]);
});

test('CLIQUET : aucun fichier déclaré ne dépasse son budget', { timeout: 30000 }, () => {
  const par = scanRule(RULE);
  const debordements = Object.entries(BUDGET)
    .map(([f, b]) => ({ f, max: b.max, n: par[f] || 0 }))
    .filter(({ n, max }) => n > max);
  expect(
    debordements,
    `Budget temporel dépassé : ${debordements.map((d) => `${d.f} ${d.n}>${d.max}`).join(', ')}\n` +
      `→ NE PAS augmenter le budget pour faire passer ce test.`
  ).toEqual([]);
});

test('les constantes temporelles restent dans la SOURCE UNIQUE (budget.js)', () => {
  const SRC = path.join(ROOT, 'src');
  const eparpillees = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.js') && !CONST_OK.has(f))
    .map((f) => {
      const code = fs
        .readFileSync(path.join(SRC, f), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      return { f, noms: [...new Set([...code.matchAll(RX_CONST)].map((m) => m[1]))] };
    })
    .filter(({ noms }) => noms.length > 0);
  expect(
    eparpillees,
    `Constante temporelle hors budget.js : ${eparpillees.map((e) => `${e.f}[${e.noms}]`).join(', ')}\n` +
      `→ budget.js est la SOURCE UNIQUE des délais. Un délai redéclaré ailleurs dérive en silence.`
  ).toEqual([]);
});

// 🛑 UN BUDGET ACCORDÉ À UN FICHIER QUI N'EXISTE PLUS EST UN **PERMIS DORMANT**.
//
// ⚠️ DÉFAUT RÉEL TROUVÉ LE 03/08/2026, dans ce gate même. `supervisor.js` a été SUPPRIMÉ le 02/08,
// mais ses deux entrées (`max: 3, motif: 'DETTE'`) sont restées dans les budgets. Conséquences,
// toutes silencieuses :
//   ① le test qui « surveillait » sa dette lisait `0 <= 3` ⇒ VERT ÉTERNEL, faux réconfort ;
//   ② surtout : un `supervisor.js` recréé demain aurait hérité d'un droit à **3 délais locaux
//      NON JUSTIFIÉS** sans que rien ne rougisse — exactement l'inférence qui a coûté 5 h le 31/07.
// Un cliquet ne protège que ce qui existe ; il faut donc aussi vérifier que ce qu'il couvre EXISTE.
// ⚠️ La bonne façon de faire passer ce gate est de RETIRER l'entrée, jamais de recréer le fichier.
test('AUCUN budget ne survit à son fichier (pas de permis dormant)', () => {
  const SRC = path.join(ROOT, 'src');
  const fantomes = [];
  for (const [nom, budget] of [['appels', BUDGET], ['inférence', BUDGET_INFERENCE]]) {
    for (const f of Object.keys(budget)) {
      if (!fs.existsSync(path.join(SRC, f))) fantomes.push(`${nom}/${f}`);
    }
  }
  expect(
    fantomes,
    `Budget accordé à un fichier INEXISTANT : ${fantomes.join(', ')}\n` +
      `→ RETIRER l'entrée. La laisser, c'est pré-autoriser des délais non justifiés dans un fichier ` +
      `qui n'existe pas encore — et le cliquet ne rougira pas le jour où il reviendra.`
  ).toEqual([]);
});

// NEGATIVE-CHECK : sans lui, le gate ci-dessus pourrait être vert parce qu'il ne vérifie rien.
test('NEGATIVE-CHECK : un budget fantôme fabriqué EST détecté', () => {
  const faux = { 'ce-fichier-n-existe-pas.js': { max: 1, motif: 'distant', pourquoi: 'leurre' } };
  const vus = Object.keys(faux).filter((f) => !fs.existsSync(path.join(ROOT, 'src', f)));
  expect(vus, 'le détecteur doit voir un budget sans fichier').toEqual(['ce-fichier-n-existe-pas.js']);
  // ET l'inverse : un fichier RÉEL ne doit jamais être signalé (sinon le gate crierait toujours).
  expect(fs.existsSync(path.join(ROOT, 'src', 'backend.js')), 'témoin : backend.js existe').toBe(true);
});

// ⚠️ NEGATIVE-CHECK OBLIGATOIRE (anti-gate-creux) : la règle du volet 2 est neuve — prouver
// qu'elle VOIT réellement une inférence introduite, sinon le budget ci-dessus ne vaut rien.
test('NEGATIVE-CHECK volet 2 : une comparaison d horodatage introduite est DÉTECTÉE', { timeout: 30000 }, () => {
  const leurre = path.join(ROOT, 'src', '__gate_probe_inference.js');
  fs.writeFileSync(leurre, 'export function stale(now, seen, ttl) {\n  return now - seen > ttl;\n}\n');
  try {
    _invalider(); // src/ vient de changer : le cache du run ne vaut plus
    const vu = Object.keys(scanInference()).includes('__gate_probe_inference.js');
    expect(vu, 'la règle DOIT voir `now - seen > ttl` introduit dans src/').toBe(true);
  } finally {
    fs.unlinkSync(leurre);
    _invalider(); // ⚠️ sinon un test suivant lirait un cache CONTAMINÉ par le leurre
  }
});
