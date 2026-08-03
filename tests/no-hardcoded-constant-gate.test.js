// GATE STATIQUE — « une vérité partagée n'existe qu'UNE fois » (posé le 03/08/2026, à l'audit).
//
// 🛑 POURQUOI CE GATE EXISTE, ET POURQUOI LES AUTRES NE SUFFISAIENT PAS.
// Le dépôt affirmait déjà deux invariants de SOURCE UNIQUE, et les DEUX étaient violés en silence :
//
//   ① `budget.js` : « TOUT délai du proxy vit ICI », en nommant explicitement `backend.js`.
//      Or `backend.js` portait `?? 15000` et `?? 10000`, et `http-transport.js` `_delay(500)` ×2 +
//      `_delay(300)`. Le gate temporel (`no-inference-gate`) ne les voyait PAS : son `RX_CONST` ne
//      reconnaît que les CONSTANTES EN MAJUSCULES (`/[A-Z_]*_MS/`). Un nombre écrit à la main dans
//      un `??` ou un appel échappait donc au cliquet — 5 délais hors source unique, gate VERT.
//
//   ② La version de protocole MCP de repli existait en TROIS exemplaires (`router.js`,
//      `manager.js`, `http-transport.js`). `jscpd` ne l'a jamais vue : il cherche des BLOCS
//      dupliqués, pas un littéral isolé répété dans trois fichiers.
//
// ⚠️ LEÇON GÉNÉRALE, à ne pas perdre : un invariant écrit en PROSE dans un en-tête n'est pas un
// garde-fou. Tant qu'aucune machine ne le vérifie, il décrit une INTENTION, pas le code — et il
// dérive d'autant plus facilement qu'on le croit tenu. Ces deux violations vivaient sous des
// commentaires impératifs (« NE JAMAIS redeclarer un delai ailleurs ») qui les décrivaient.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Les `.js` de `src/`, hors les fichiers exemptés (qui SONT la source unique). */
function sources(exempts) {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.js') && !exempts.includes(f))
    .map((f) => ({ nom: f, code: fs.readFileSync(path.join(SRC, f), 'utf8') }));
}

/**
 * Retire ce qui est du COMMENTAIRE. ⚠️ Les commentaires de ce dépôt CITENT les valeurs fautives
 * (« `?? 15000` », « `_delay(500)` ») pour expliquer POURQUOI elles sont interdites — y compris
 * dans les en-têtes que ce gate défend. Les analyser ferait rougir la documentation de la règle
 * par la règle elle-même, et pousserait à effacer la mémoire du projet pour faire taire le gate.
 * @param {string} ligne
 */
function sansCommentaire(ligne) {
  const t = ligne.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return ligne.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

// ── RÈGLE ① : aucun DÉLAI en littéral hors `budget.js` ────────────────────────────────────────
// Deux formes, ce sont exactement celles qui ont échappé au gate temporel :
//   `xxxMs = ... 15000`        un champ/variable de durée initialisé à un nombre écrit à la main
//   `setTimeout(fn, 500)`      un délai passé directement à un ordonnanceur (ou à un helper `_delay`)
// ⚠️ Un identifiant en second argument (`setTimeout(r, ms)`) est LÉGITIME : la valeur vient alors
// d'ailleurs, et `budget.js` reste sa seule origine possible.
// ⚠️ `(?<![=!<>])=(?!=)` : une AFFECTATION, jamais une COMPARAISON. Sans cette précision, le gate
// rougissait sur `typeof r.ageMs === 'number' ? … r.ageMs / 1000 …` (freeze-report.js) — du code
// parfaitement sain. Un gate qui crie au loup est un gate qu'on finit par désactiver : la précision
// n'est pas du confort, c'est ce qui le garde crédible donc VIVANT.
const RX_CHAMP_MS = /\b\w*[Mm]s\b\s*(?::|(?<![=!<>])=(?!=))\s*[^;\n]*?\b\d{2,}\b/;
// ⚠️ DEUX ALTERNATIVES, et la 2e a été écrite APRÈS un ROUGE du negative-check ci-dessous : une
// première version exigeait `[^,()]*` pour le 1er argument, donc elle ne franchissait PAS une
// lambda (`setTimeout(() => resolve(false), 3000)` — la forme même qu'utilise `backend.js`).
// Elle aurait été VERTE sur le cas le plus courant du dépôt. C'est le negative-check, et lui seul,
// qui l'a rendu visible. 🛑 NE JAMAIS resserrer ce motif sans rejouer ces cas.
const RX_DELAI_LITTERAL = /\b(?:setTimeout|setInterval|_delay)\s*\(\s*\d+\s*\)|\b(?:setTimeout|setInterval|_delay)\s*\(.*,\s*\d+\s*\)/;

test('AUCUN délai en littéral hors budget.js (source UNIQUE des durées)', () => {
  const fautes = [];
  for (const { nom, code } of sources(['budget.js'])) {
    code.split('\n').forEach((ligne, i) => {
      // Les commentaires RACONTENT les valeurs historiques (« 20000 etait arbitraire ») : les
      // compter rendrait le gate ininterprétable et pousserait à effacer la mémoire du projet.
      const nu = sansCommentaire(ligne);
      if (RX_CHAMP_MS.test(nu) || RX_DELAI_LITTERAL.test(nu)) fautes.push(`${nom}:${i + 1} ${ligne.trim()}`);
    });
  }
  expect(fautes, `Délai(s) hors budget.js — déplacer la valeur dans budget.js et l'importer :\n${fautes.join('\n')}`).toEqual([]);
});

// ── RÈGLE ② : la version de protocole MCP n'existe qu'une fois ────────────────────────────────
const RX_VERSION = /['"]\d{4}-\d{2}-\d{2}['"]/;

test('AUCUNE version de protocole MCP en dur hors protocol.js', () => {
  const fautes = [];
  for (const { nom, code } of sources(['protocol.js'])) {
    code.split('\n').forEach((ligne, i) => {
      const nu = ligne.replace(/\/\/.*$/, '');
      if (RX_VERSION.test(nu)) fautes.push(`${nom}:${i + 1} ${ligne.trim()}`);
    });
  }
  expect(fautes, `Version de protocole dupliquée — importer PROTOCOL_FALLBACK :\n${fautes.join('\n')}`).toEqual([]);
});

// ── NEGATIVE-CHECK ────────────────────────────────────────────────────────────────────────────
// 🛑 UN GATE QUI NE PEUT PAS ROUGIR N'EST PAS UNE PREUVE. On rejoue ici les DEUX violations
// RÉELLES trouvées à l'audit, telles qu'elles étaient écrites, et on exige que chacune soit vue.
// ⚠️ NE JAMAIS supprimer ce test comme « redondant » : sans lui, une regex cassée (un `\b` de trop)
// rendrait les deux règles ci-dessus définitivement muettes, et VERTES.
test('NEGATIVE-CHECK : les violations réelles du 03/08 sont bien détectées', () => {
  // Telles qu'elles vivaient dans backend.js et http-transport.js
  expect(RX_CHAMP_MS.test('    this._pingIntervalMs = options.pingIntervalMs ?? 15000;')).toBe(true);
  expect(RX_CHAMP_MS.test('    this._pingTimeoutMs = options.pingTimeoutMs ?? 10000;')).toBe(true);
  expect(RX_DELAI_LITTERAL.test('        await this._delay(500);')).toBe(true);
  expect(RX_DELAI_LITTERAL.test('      const h = setTimeout(() => resolve(false), 3000);')).toBe(true);
  expect(RX_VERSION.test("const PROTOCOL_FALLBACK = '2025-06-18';")).toBe(true);

  // ⚠️ Et l'inverse : les formes CORRECTES ne doivent pas rougir, sinon le gate serait un mur
  // qu'on finirait par contourner — un gate bruyant est un gate qu'on désactive.
  expect(RX_CHAMP_MS.test('    this._pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;')).toBe(false);
  expect(RX_DELAI_LITTERAL.test('      const t = setTimeout(r, ms);')).toBe(false);
  expect(RX_DELAI_LITTERAL.test('      await this._delay(GET_RETRY_MS);')).toBe(false);
});
