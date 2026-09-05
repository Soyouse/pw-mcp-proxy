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
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { log } from './logger.js';
import { bootLogger } from './log-boot.js';
import { ServerDaemon } from './server-daemon.js';
import { describeError, stackOf } from './error-detail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ⚠️ MEME journal que le proxy et le gardien (point UNIQUE `log-boot.js`) : un incident se lit sur
// UNE chronologie. Recopier la resolution du chemin ici ferait diverger les trois en silence.
bootLogger(path.join(__dirname, '..'));

process.on('uncaughtException', (e) => log('daemon uncaughtException: ' + describeError(e) + ' | ' + stackOf(e)));
process.on('unhandledRejection', (e) => log('daemon unhandledRejection: ' + describeError(e) + ' | ' + stackOf(e)));

// ⚠️ LE NOM DU CANAL EST IMPOSÉ PAR LE LANCEUR (argv[2]), il n'est PAS recalculé ici.
// Le client l'a déjà calculé pour tenter de s'y connecter : le recalculer serait une SECONDE
// vérité, et deux vérités divergent (env, utilisateur, tmpdir…) — le daemon écouterait alors un
// canal que personne n'écoute. Une seule source, celle qui a besoin de s'y connecter.
// Repli sur le calcul local uniquement si lancé à la main (diagnostic).
const canalImpose = process.argv[2];
// ⚠️ La limite est IMPOSÉE PAR LE LANCEUR (argv[3]), comme le nom du canal : lui seul a lu
// `profiles.json`. Le daemon ne lit AUCUNE config — il n'aurait aucun moyen de rester synchrone.
// ⚠️ CONSÉQUENCE À CONNAÎTRE : la limite est fixée au LANCEMENT du daemon. La changer dans
// profiles.json ne prend effet qu'au prochain daemon (donc quand plus aucun agent n'en tient).
const limiteImposee = process.argv[3];
// ⚠️ `--bind-host <hote>` (05/09/2026) : adresse d'ECOUTE des serveurs, IMPOSEE par le lanceur comme
// la limite (le premier proxy la lit dans profiles.json ; le daemon ne lit rien). Defaut `localhost`.
// Argument NOMME (pas positionnel) : argv[3] peut deja etre le marqueur de test, en position libre.
const iHote = process.argv.indexOf('--bind-host');
const hoteImpose = iHote >= 0 ? process.argv[iHote + 1] : undefined;
// ═══ NŒUD DISTANT (05/09/2026) : `--listen tcp://<hôte>:<port>` + `--token-file <chemin>` ═══
// Le jeton vient d'un FICHIER (jamais argv : `ps` le montrerait à tout utilisateur de la machine).
// Lancé À LA MAIN par l'opérateur sur un nœud (jamais par un proxy) : c'est lui qui expose.
const iListen = process.argv.indexOf('--listen');
const listenImpose = iListen >= 0 ? process.argv[iListen + 1] : undefined;
const iToken = process.argv.indexOf('--token-file');
const tokenFile = iToken >= 0 ? process.argv[iToken + 1] : undefined;
let listen = null, token = undefined;
if (listenImpose) {
  const u = new URL(listenImpose);
  if (u.protocol !== 'tcp:' || !u.hostname || !u.port) { log(`daemon: --listen invalide (${listenImpose}) — forme attendue tcp://<hôte>:<port>`); process.stdout.write('busy\n'); process.exit(1); }
  listen = { host: u.hostname, port: Number(u.port) };
}
if (tokenFile) {
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { log(`daemon: --token-file illisible — ${describeError(e)}`); process.stdout.write('busy\n'); process.exit(1); }
}
// ⚠️ `onArret` : le daemon s'arrete SEUL des qu'il n'a plus ni profil ni client. C'est ICI, et
// nulle part ailleurs, qu'on en tire la sortie du process — la classe est instanciee telle quelle
// par les tests, un `process.exit()` en son sein tuerait leur worker.
const daemon = new ServerDaemon({
  ...(canalImpose ? { nomCanal: canalImpose } : {}),
  ...(hoteImpose ? { bindHost: hoteImpose } : {}),
  ...(listen ? { listen } : {}),
  ...(token ? { token } : {}),
  limite: limiteImposee,
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
