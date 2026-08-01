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
function scanAst() {
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
    out = execFileSync(bin, [...base, 'scan', '-r', RULE, 'src', '--json=compact'], opts);
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

test('aucun appel temporel dans un fichier NON déclaré (le temps se déclare)', { timeout: 30000 }, () => {
  const clandestins = Object.entries(scanAst()).filter(([f]) => !BUDGET[f]);
  expect(
    clandestins,
    `Appel temporel dans un fichier non déclaré : ${clandestins.map(([f, n]) => `${f}(${n})`).join(', ')}\n` +
      `→ Avant d'ajouter un délai : QUI SAIT ? Local ⇒ le noyau sait, le délai est un bug.\n` +
      `→ Si vraiment "distant" ou "indécidable", le déclarer dans BUDGET avec sa justification.`
  ).toEqual([]);
});

test('CLIQUET : aucun fichier déclaré ne dépasse son budget', { timeout: 30000 }, () => {
  const par = scanAst();
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
  const n = scanAst()['supervisor.js'] || 0;
  expect(n, `supervisor.js : ${n} délais LOCAUX (cible 0). Ne jamais remonter.`).toBeLessThanOrEqual(
    BUDGET['supervisor.js'].max
  );
});
