#!/usr/bin/env node
// Point d'entrée du DAEMON UNIQUE. Lancé par le premier proxy qui en a besoin, jamais à la main.
//
// ⚠️ CONTRAT DE DÉMARRAGE — le daemon SIGNALE sa disponibilité sur stdout, puis se TAIT :
//     `ready\n`  écrit UNE seule fois, quand le canal écoute vraiment
//     `busy\n`   un autre daemon tient déjà le canal (EADDRINUSE) — celui-ci est en trop
// C'est le modèle `systemd Type=notify` (READY=1) : le lanceur ATTEND UN ÉVÉNEMENT, il ne devine
// pas avec un chronomètre. Sans ce signal, le client n'aurait que le choix de sonder en boucle —
// exactement l'inférence que tout ce refactor supprime.
//
// ⚠️ POURQUOI IL SE TAIT ENSUITE (ne pas « améliorer » en logguant sur stdout) : le daemon SURVIT
// au proxy qui l'a lancé. Quand ce proxy meurt, le pipe se casse ; toute écriture ultérieure
// donnerait EPIPE — donc potentiellement la mort du daemon, et de TOUS les navigateurs avec lui.
// Une seule ligne, puis plus rien. Les logs vont dans le fichier (logger.js), jamais sur stdout.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { initLogger, log } from './logger.js';
import { ServerDaemon } from './server-daemon.js';
import { describeError } from './error-detail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initLogger(process.env.PW_MCP_LOG || path.join(__dirname, '..', 'pw-mcp-proxy.log'));

process.on('uncaughtException', (e) => log('daemon uncaughtException: ' + describeError(e) + ' | ' + (e?.stack || '')));
process.on('unhandledRejection', (e) => log('daemon unhandledRejection: ' + describeError(e) + ' | ' + (e?.stack || '')));

// ⚠️ LE NOM DU CANAL EST IMPOSÉ PAR LE LANCEUR (argv[2]), il n'est PAS recalculé ici.
// Le client l'a déjà calculé pour tenter de s'y connecter : le recalculer serait une SECONDE
// vérité, et deux vérités divergent (env, utilisateur, tmpdir…) — le daemon écouterait alors un
// canal que personne n'écoute. Une seule source, celle qui a besoin de s'y connecter.
// Repli sur le calcul local uniquement si lancé à la main (diagnostic).
const canalImpose = process.argv[2];
// ⚠️ `onArret` : le daemon s'arrete SEUL des qu'il n'a plus ni profil ni client. C'est ICI, et
// nulle part ailleurs, qu'on en tire la sortie du process — la classe est instanciee telle quelle
// par les tests, un `process.exit()` en son sein tuerait leur worker.
const daemon = new ServerDaemon({
  ...(canalImpose ? { nomCanal: canalImpose } : {}),
  onArret: () => process.exit(0),
});

// ⚠️ try/catch OBLIGATOIRE : `await` de top-level. Une exception y avorte le module ⇒ le process
// meurt sans rien signaler, et le lanceur attendrait un `ready` qui ne viendra jamais.
let pris = false;
try {
  pris = await daemon.demarrer();
} catch (e) {
  log('daemon: démarrage impossible — ' + describeError(e));
  process.stdout.write('busy\n'); // le lanceur DOIT être débloqué, même sur échec
  process.exit(1);
}

if (!pris) {
  // Un autre daemon tient le canal : ce process est en trop. Fait EXACT du noyau, pas un échec.
  process.stdout.write('busy\n');
  process.exit(0);
}

process.stdout.write('ready\n');

// ⚠️ On ne garde PAS stdout ouvert au-delà : cf en-tête (EPIPE à la mort du lanceur).
const partir = (raison) => { log(`daemon: ${raison}`); daemon.arreter(); process.exit(0); };
process.on('SIGINT', () => partir('SIGINT'));
process.on('SIGTERM', () => partir('SIGTERM'));
