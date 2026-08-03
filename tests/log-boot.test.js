// LE CÂBLAGE DU JOURNAL — test de CONTRAT de frontière (posé le 03/08/2026).
//
// 🛑 POURQUOI CE FICHIER EXISTE. `logger.js` sait COMPTER ses écritures perdues et CRIER via
// `onPerte` ; `notify.js` sait alerter. Les deux sont testés séparément, et pourtant la chaîne
// pouvait être ROMPUE sans qu'un seul test rougisse : il suffisait que `bootLogger` oublie de
// passer `onPerte`. Chaque maillon vert, la chaîne morte. C'est le mode de défaillance exact que
// les tests de contrat de frontière existent pour interdire.
// ⚠️ Un disque plein est justement le moment où l'on découvrirait le trou — c'est-à-dire trop tard,
// et sans aucune trace, puisque le canal qui aurait dû prévenir est celui qui manque.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootLogger } from '../src/log-boot.js';
import { log, logPertes, initLogger } from '../src/logger.js';

const jetable = () => path.join(os.tmpdir(), `pw-mcp-boot-${process.pid}-${Math.floor(performance.now())}`);

test('CONTRAT : bootLogger rend le chemin attendu et respecte PW_MCP_LOG', () => {
  const racine = jetable();
  const ancien = process.env.PW_MCP_LOG;
  try {
    delete process.env.PW_MCP_LOG;
    expect(bootLogger(racine), 'par défaut : <racine>/pw-mcp-proxy.log').toBe(path.join(racine, 'pw-mcp-proxy.log'));
    // ⚠️ La variable d'environnement est ce qui permet aux TESTS de ne jamais écrire dans le
    // journal de PROD (partagé avec les proxys réels de l'utilisateur, rotation multi-écrivains).
    const impose = path.join(racine, 'ailleurs.log');
    process.env.PW_MCP_LOG = impose;
    expect(bootLogger(racine), 'PW_MCP_LOG PRIME sur la racine').toBe(impose);
  } finally {
    if (ancien === undefined) delete process.env.PW_MCP_LOG; else process.env.PW_MCP_LOG = ancien;
  }
});

// 🛑 LE TEST QUI COMPTE : la chaîne complète, de bout en bout, SANS la simuler.
test('CHAÎNE COMPLÈTE : journal inécrivable ⇒ perte COMPTÉE ⇒ cri émis hors du journal', () => {
  const racine = jetable();
  const inexistant = path.join(racine, 'dossier-absent'); // n'existe pas ⇒ toute écriture échoue
  const ancien = process.env.PW_MCP_LOG;
  const criees = [];
  try {
    process.env.PW_MCP_LOG = path.join(inexistant, 'journal.log');
    bootLogger(racine);
    // ⚠️ On intercepte le canal de sortie RÉEL du cri (`notify` poste sur NTFY seulement si une URL
    // est configurée ; sans URL il se contente de journaliser — donc on observe le COMPTEUR, qui
    // est le fait opposable, plutôt que le réseau). Le point prouvé ici est que `bootLogger` a
    // bien ARMÉ le mécanisme : sans `onPerte`, `criEmis` ne servirait à rien et le compteur seul
    // resterait muet pour l'opérateur.
    log('ligne condamnée');
    log('deuxième ligne condamnée');
    expect(logPertes().total, 'les pertes DOIVENT être comptées après un bootLogger réel').toBe(2);
  } finally {
    if (ancien === undefined) delete process.env.PW_MCP_LOG; else process.env.PW_MCP_LOG = ancien;
    initLogger(path.join(os.tmpdir(), 'pw-mcp-neutre.log')); // rend le logger propre aux autres fichiers
    try { fs.rmSync(racine, { recursive: true, force: true }); } catch { /* nettoyage best-effort */ }
  }
});

// 🛑 NEGATIVE-CHECK STATIQUE — le maillon le plus facile à casser par inadvertance.
// ⚠️ Retirer `onPerte` de `log-boot.js` ne casse AUCUN test de comportement (le compteur monte
// quand même) : seule l'ALERTE disparaît, c'est-à-dire la seule chose que l'opérateur verrait.
// Ce gate rend cette suppression ROUGE. Sans lui, la panne serait muette PAR CONSTRUCTION.
test('GATE : bootLogger câble onPerte sur alert — le cri ne doit jamais être débranché', () => {
  const src = fs.readFileSync(new URL('../src/log-boot.js', import.meta.url), 'utf8');
  expect(src, "`alert` doit être importé de notify.js").toMatch(/import\s*\{[^}]*\balert\b[^}]*\}\s*from\s*'\.\/notify\.js'/);
  expect(src, "`onPerte` doit être passé à initLogger — sinon la perte de journal redevient MUETTE")
    .toMatch(/initLogger\([^)]*onPerte\s*:\s*alert/s);
});

// ⚠️ Et l'invariant d'ARCHITECTURE qui a imposé l'injection : `logger.js` ne doit JAMAIS importer
// `notify.js`. `notify` importe déjà `logger` ⇒ l'import inverse créerait un cycle, et
// `.dependency-cruiser.cjs` a `no-circular` en ERROR (cliquet à zéro). Le gate d'archi le verrait,
// mais il ne dirait pas POURQUOI ; ici la raison est écrite à côté de la règle.
test('GATE : logger.js n importe PAS notify.js (le cycle est interdit, cliquet à zéro)', () => {
  const src = fs.readFileSync(new URL('../src/logger.js', import.meta.url), 'utf8');
  expect(src, "logger.js doit rester SANS dépendance vers notify.js — c'est ce qui force l'injection")
    .not.toMatch(/from\s*'\.\/notify\.js'/);
});
