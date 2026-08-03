// Test d'INTÉGRATION de la rotation RÉELLE (I/O disque) de logger.js.
// Prouve la BORNE DURE : sous écriture continue, le nombre de fichiers et la taille du fichier
// courant restent bornés (jamais de croissance infinie = fuite disque). Aucun process spawné.

import { test, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLogger, log, logPertes } from '../src/logger.js';

const base = path.join(os.tmpdir(), `pw-mcp-logtest-${process.pid}-${Math.floor(performance.now())}.log`);

function cleanup() {
  for (const suffix of ['', '.1', '.2', '.3', '.4']) {
    try { fs.unlinkSync(base + suffix); } catch {}
  }
}
afterEach(cleanup);

test('rotation : sous écriture continue, la borne (maxFiles générations) est respectée + fichier courant borné', () => {
  const maxBytes = 200;
  const maxFiles = 3; // => base + base.1 + base.2 au MAXIMUM, jamais base.3
  initLogger(base, { maxBytes, maxFiles });

  for (let i = 0; i < 200; i++) log(`ligne de log numero ${i} avec un peu de contenu pour peser`);

  expect(fs.existsSync(base), 'le fichier courant existe').toBeTruthy();
  expect(fs.existsSync(base + '.1'), 'une archive .1 a été produite (rotation a bien eu lieu)').toBeTruthy();
  expect(fs.existsSync(base + '.2'), 'une archive .2 a été produite').toBeTruthy();
  expect(!fs.existsSync(base + '.3'), 'BORNE : aucune génération au-delà de maxFiles (pas de fuite disque)').toBeTruthy();

  // Le fichier courant ne dépasse jamais maxBytes de plus d'UNE ligne (on rote AVANT d'écrire).
  const sizeCur = fs.statSync(base).size;
  const oneLine = Buffer.byteLength(`[${new Date().toISOString()}] ligne de log numero 999 avec un peu de contenu pour peser\n`);
  expect(sizeCur <= maxBytes + oneLine, `fichier courant borné (${sizeCur} <= ${maxBytes}+1 ligne)`).toBeTruthy();
});

// ⚠️ ANTI-RÉGRESSION MULTI-AGENT (bug trouvé 02/08/2026 par simulation, jamais observé en prod).
// N proxys écrivent dans le MÊME fichier de log. Tant que logger.js comptait ses octets EN MÉMOIRE,
// chaque process ne voyait QUE ses propres écritures : le fichier réel pouvait valoir N fois le cap
// avant que quiconque ne rote. La borne « 15 Mo » annoncée était donc FAUSSE dès 2 agents.
// Ici, l'écriture d'un TIERS (= l'autre proxy) est simulée par un appendFileSync direct.
// Ce test ÉCHOUE avec un compteur mémoire et PASSE en lisant la taille réelle du filesystem.
test('MULTI-AGENT : les octets écrits par un AUTRE process comptent dans la borne', () => {
  const maxBytes = 500;
  initLogger(base, { maxBytes, maxFiles: 3 });

  log('ma premiere ligne'); // ce process n'a écrit que ~50 octets : loin du cap de son point de vue

  // Un AUTRE proxy (autre process, même fichier) dépasse le cap à lui seul.
  fs.appendFileSync(base, 'X'.repeat(maxBytes));
  expect(fs.statSync(base).size > maxBytes, 'préalable : le fichier dépasse déjà le cap').toBeTruthy();

  log('ma seconde ligne'); // DOIT constater la taille RÉELLE et roter

  expect(fs.existsSync(base + '.1'), 'la rotation a eu lieu malgré des octets venus d\'un autre process').toBeTruthy();
  expect(fs.statSync(base).size <= maxBytes, 'le fichier courant est repassé sous le cap').toBeTruthy();
});

// ⚠️ FILET DUR : si le plan de rotation ne libère PAS le fichier courant (maxFiles<=1 par
// construction ; Windows multi-agent : renameSync refusé car un autre proxy tient le fichier),
// la borne disque serait perdue en SILENCE. Le truncate de dernier recours doit la garantir.
test('FILET DUR : sans archive possible (maxFiles=1), le fichier reste borné', () => {
  const maxBytes = 300;
  initLogger(base, { maxBytes, maxFiles: 1 }); // plan de rotation VIDE : aucun rename possible

  for (let i = 0; i < 200; i++) log(`ligne ${i} avec du contenu pour peser un peu sur le fichier`);

  expect(!fs.existsSync(base + '.1'), 'maxFiles=1 => aucune archive').toBeTruthy();
  const size = fs.statSync(base).size;
  expect(size <= maxBytes * 2, `BORNE DURE tenue sans archive (${size} octets)`).toBeTruthy();
});

test('rotation désactivée (maxBytes=0) : aucune archive, un seul fichier qui grossit', () => {
  initLogger(base, { maxBytes: 0, maxFiles: 3 });
  for (let i = 0; i < 100; i++) log(`x${i}`);
  expect(fs.existsSync(base), 'le fichier existe').toBeTruthy();
  expect(!fs.existsSync(base + '.1'), 'maxBytes=0 => rotation désactivée => aucune archive').toBeTruthy();
});

// ⚠️ ANTI-PANNE-MUETTE : LE JOURNAL LUI-MÊME PEUT ÉCHOUER (posé le 03/08/2026).
//
// 🛑 LE SILENCE ÉTAIT JUSTIFIÉ, L'IGNORANCE NE L'ÉTAIT PAS. Le `catch` d'`appendFileSync` est
// OBLIGATOIRE (se logguer soi-même = récursion ; faire remonter = tuer le proxy pour une ligne de
// journal). Mais il avalait l'échec SANS RIEN COMPTER : disque plein ⇒ on perd exactement le log
// dont on a besoin, et on relit ensuite un journal TROUÉ en le croyant complet — pire qu'un
// journal absent, parce qu'on en tire des conclusions fausses.
// ⚠️ La panne est simulée par un RÉPERTOIRE INEXISTANT (ENOENT) : déterministe sur les 3 OS, là où
// « remplir le disque » ne l'est nulle part. La classe d'erreur diffère, le chemin de code est le même.
test('PERTE DE JOURNAL : les lignes perdues sont COMPTÉES et CRIÉES hors du journal', () => {
  const dossier = path.join(os.tmpdir(), `pw-mcp-perte-${process.pid}-${Math.floor(performance.now())}`);
  const fichier = path.join(dossier, 'journal.log'); // le dossier N'EXISTE PAS ⇒ toute écriture échoue
  const cris = [];
  initLogger(fichier, { onPerte: (m) => cris.push(m) });

  expect(logPertes(), 'état initial : aucune perte').toEqual({ enCours: 0, total: 0 });

  log('cette ligne est perdue');
  log('celle-ci aussi');

  expect(logPertes().total, 'CHAQUE ligne perdue doit être comptée — sinon la perte reste invisible').toBe(2);
  expect(cris.length, "UN SEUL cri par épisode : alerter à chaque ligne noierait l'opérateur").toBe(1);
  expect(cris[0], 'le cri doit NOMMER le fichier en cause').toContain(fichier);

  // RETOUR À LA NORMALE : le journal redevient écrivable.
  fs.mkdirSync(dossier, { recursive: true });
  log('le disque est revenu');

  const contenu = fs.readFileSync(fichier, 'utf8');
  expect(contenu, "le journal DOIT avouer son propre trou — sans ça on le relit en le croyant complet")
    .toMatch(/ECRITURE RETABLIE — 2 ligne\(s\) DEFINITIVEMENT PERDUE\(S\)/);
  expect(logPertes(), 'épisode clos : compteur courant remis à zéro, cumul CONSERVÉ').toEqual({ enCours: 0, total: 2 });

  // 🛑 SECOND ÉPISODE : le cri DOIT repartir. Une alerte unique à vie vaudrait vaccination contre
  // toutes les pannes suivantes — le mode de défaillance le plus vicieux d'un système d'alerte.
  fs.unlinkSync(fichier);
  fs.rmdirSync(dossier);
  log('nouvelle panne');
  expect(cris.length, 'un NOUVEL épisode doit crier à nouveau').toBe(2);
  expect(logPertes(), 'le cumul ne redescend JAMAIS').toEqual({ enCours: 1, total: 3 });

  initLogger(base, {}); // on rend le logger au reste du fichier (état global de module)
});

// NEGATIVE-CHECK — sans la panne, rien ne doit être compté ni crié : un compteur qui monte tout
// seul serait tout aussi inexploitable qu'un compteur qui reste à zéro.
test('NEGATIVE-CHECK : journal SAIN ⇒ zéro perte comptée, zéro cri', () => {
  const cris = [];
  initLogger(base, { onPerte: (m) => cris.push(m) });
  for (let i = 0; i < 20; i++) log(`ligne saine ${i}`);
  expect(logPertes()).toEqual({ enCours: 0, total: 0 });
  expect(cris).toEqual([]);
});
