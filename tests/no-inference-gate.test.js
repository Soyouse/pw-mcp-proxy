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
  'supervisor.js': {
    max: 4,
    motif: 'DETTE',
    pourquoi:
      '⛔ NON JUSTIFIÉ — questions 100 % LOCALES (le lanceur vit-il ? le serveur est-il prêt ? ' +
      'reste-t-il des clients ?). Le noyau y répond par ÉVÉNEMENT. Cible : 0, via canal nommé ' +
      "(named pipe / socket Unix) + événement de fin de processus. Cf skill §DÉCISION D'ARCHITECTURE.",
  },
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
  'server-registry.js': {
    max: 3,
    motif: 'DETTE',
    pourquoi:
      "⛔ NON JUSTIFIÉ — « ce client bat-il encore ? » est 100 % LOCAL : la fermeture de sa " +
      'connexion au canal nommé est un ÉVÉNEMENT exact du noyau. Cible : 0 (refcount).',
  },
  'supervisor.js': {
    max: 4,
    motif: 'DETTE',
    pourquoi:
      '⛔ NON JUSTIFIÉ — 3x péremption de verrou (LOCK_STALE_MS) + 1x poll de readiness. Le canal ' +
      'nommé rend le verrou périmé IMPOSSIBLE par construction (le noyau le détruit à la mort du ' +
      'processus). Cible : 0. Cf skill §DÉCISION D\'ARCHITECTURE.',
  },
};

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

test('la DETTE reste visible et ne grossit pas (supervisor.js : cible = 0)', { timeout: 30000 }, () => {
  const n = scanRule(RULE)['supervisor.js'] || 0;
  expect(n, `supervisor.js : ${n} délais LOCAUX (cible 0). Ne jamais remonter.`).toBeLessThanOrEqual(
    BUDGET['supervisor.js'].max
  );
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
