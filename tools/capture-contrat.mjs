#!/usr/bin/env node
// capture-contrat.mjs — DÉRIVE `contracts/playwright-mcp.json` du binaire RÉEL (`--help`).
//
// ⚠️ Le contrat n'est JAMAIS édité à la main pour faire passer un test (cf `_lisez_moi` du JSON) :
// ce script est la SEULE voie de mise à jour. Il REFUSE (exit 1, message nommé) si un flag `requis`
// a disparu du --help, ou si un flag `interdits` n'existe plus dans le binaire (un interdit qui n'a
// plus de sens doit être réexaminé, jamais recopié en silence).
//
// Usage : node tools/capture-contrat.mjs [version]   (défaut : 0.0.80)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@playwright/mcp';
const VERSION = process.argv[2] || '0.0.80';

// Flags REQUIS par le code (src/spec.js, src/manager.js) : leur disparition casse le proxy en prod.
const REQUIS = ['--caps', '--host', '--isolated', '--port', '--proxy-server', '--user-data-dir'];

// Flags dont la PRÉSENCE dans une spec construite par le proxy est une RÉGRESSION (mesuré
// 04/09/2026 : deux clients d'un serveur partagé s'écrasent la page). Interdit ≠ absent du binaire :
// le flag existe toujours côté @playwright/mcp, mais src/ ne doit JAMAIS le construire.
const INTERDITS = {
  _pourquoi:
    "Flag présent dans le --help mais dont la PRÉSENCE dans une spec du proxy est une " +
    'régression : deux clients HTTP partageant un même contexte navigateur (--shared-browser-context) ' +
    "s'écrasent mutuellement la page (collision mesurée le 04/09/2026, scène du 03/09 rejouée). " +
    'Le parallélisme multi-agent passe désormais par une instance par client, jamais par un contexte partagé.',
  flags: ['--shared-browser-context'],
};

// Capacités vérifiées ABSENTES : leur apparition simplifierait le projet (cf skill playwright-mcp-api).
const ABSENTS = ['--idle-timeout', '--shutdown-when-idle', '--auto-shutdown', '--exit-when-idle'];

function capturerHelp(version) {
  // ⚠️ `npx` est une commande BARE sous Windows => shell obligatoire (même contrat que
  // stdio-transport.js / spawn-cmd.js). `.cmd` requis pour l'exécution directe sous Windows.
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(bin, ['-y', `${PACKAGE}@${version}`, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  });
}

function extraireFlags(helpText) {
  // Toutes les occurrences de `--xxx` (options + mentions croisées dans les descriptions),
  // dédoublonnées et triées. Un flag mentionné en description est de toute façon un flag réel
  // (cf --mobile qui cite --device) : aucun faux positif possible sur ce format `commander`.
  const trouves = helpText.match(/--[a-z][a-z-]*/g) || [];
  return [...new Set(trouves)].sort();
}

function main() {
  const help = capturerHelp(VERSION);
  const surface = extraireFlags(help);
  const surfaceSet = new Set(surface);

  const manquantsRequis = REQUIS.filter((f) => !surfaceSet.has(f));
  if (manquantsRequis.length > 0) {
    console.error(
      `⛔ REFUS — flag(s) REQUIS absent(s) du --help de ${PACKAGE}@${VERSION} : ${manquantsRequis.join(', ')}\n` +
        'Le code construit ces flags (src/spec.js) : le proxy serait cassé en production.\n' +
        'Ne PAS mettre à jour le contrat tant que ce point n\'est pas résolu (code ou version).'
    );
    process.exit(1);
  }

  const interditsDisparus = INTERDITS.flags.filter((f) => !surfaceSet.has(f));
  if (interditsDisparus.length > 0) {
    console.error(
      `⛔ REFUS — flag(s) INTERDIT(S) absent(s) du --help de ${PACKAGE}@${VERSION} : ${interditsDisparus.join(', ')}\n` +
        "Un interdit qui n'existe plus dans le binaire n'a plus de sens : il faut le RÉEXAMINER\n" +
        '(le retirer de la liste, avec sa justification, dans le même geste), jamais le recopier en silence.'
    );
    process.exit(1);
  }

  let distTagLatest;
  try {
    distTagLatest = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', PACKAGE, 'version'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim();
  } catch (err) {
    console.error(`⛔ REFUS — \`npm view ${PACKAGE} version\` a échoué : ${err.message}`);
    process.exit(1);
  }

  const contrat = {
    _lisez_moi:
      'INSTANTANE DATE des surfaces TIERCES dont pw-mcp-proxy depend. Compare au binaire reel par ' +
      'tests/contract-snapshot.test.js. NE PAS editer a la main pour faire passer un test : re-capturer ' +
      '(tools/capture-contrat.mjs), RELIRE les diffs, puis mettre a jour le skill playwright-mcp-api ET le ' +
      'BACKLOG dans le meme geste.',
    package: PACKAGE,
    version: VERSION,
    distTagLatestAuMomentDuSnapshot: distTagLatest,
    capturePar: `npx -y ${PACKAGE}@${VERSION} --help`,
    captureLe: new Date().toISOString().slice(0, 10),
    requis: {
      _pourquoi:
        'Flags que le CODE construit reellement (src/spec.js, src/manager.js). La disparition de ' +
        "l'UN d'eux casse le proxy en PRODUCTION => ROUGE FATAL.",
      flags: [...REQUIS].sort(),
    },
    interdits: INTERDITS,
    absents: {
      _pourquoi:
        'Capacites VERIFIEES ABSENTES au moment du snapshot. Leur APPARITION est une BONNE nouvelle ' +
        'qui doit remonter : un auto-shutdown natif rendrait le daemon maison INUTILE (cf skill ' +
        'playwright-mcp-api, alternatives epuisees). Le test rougit alors pour signaler une OPPORTUNITE ' +
        'DE SIMPLIFIER, jamais une panne.',
      flags: [...ABSENTS].sort(),
    },
    surfaceComplete: {
      _pourquoi:
        "Tous les flags au moment du snapshot. Divergence = l'upstream a bouge => relire les diffs AVANT " +
        'de deployer. Sur une version PINNEE ce test ne peut rougir qu au BUMP : exactement le moment ou ' +
        "l'on veut etre alerte.",
      flags: surface,
    },
  };

  const dest = path.join(ROOT, 'contracts', 'playwright-mcp.json');
  fs.writeFileSync(dest, JSON.stringify(contrat, null, 2) + '\n', 'utf8');
  console.log(`✅ contrat ${PACKAGE}@${VERSION} écrit dans ${path.relative(ROOT, dest)} (${surface.length} flags).`);
}

main();
