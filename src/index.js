#!/usr/bin/env node
// Entry. Cable : stdin Claude -> Router -> backends MCP isoles -> stdout Claude.
// ⚠️ stdout = JSON-RPC PUR (writeMessage uniquement). Tout log -> stderr/fichier.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { NdjsonReader } from './jsonrpc.js';
import { initLogger, log } from './logger.js';
import { Manager } from './manager.js';
import { Router } from './router.js';
import { describeError } from './error-detail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const configPath = process.env.PW_MCP_PROFILES || path.join(root, 'profiles.json');
const logPath = process.env.PW_MCP_LOG || path.join(root, 'pw-mcp-proxy.log');

initLogger(logPath);
// ⚠️ DERNIERS FILETS du process : ce sont les seules traces d'une erreur que PERSONNE n'a rattrapee.
// `describeError` AVANT la stack — une erreur socket a un `code` (ECONNRESET…) mais souvent un
// `message` VIDE, et `.stack` seule affiche alors « Error\n at … » sans le moindre indice
// (exactement l'aveuglement de 5 h du 01/08). Le code d'abord, la stack ensuite pour la localisation.
process.on('uncaughtException', (e) => log('uncaughtException: ' + describeError(e) + ' | ' + (e?.stack || '')));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + describeError(e) + ' | ' + (e?.stack || '')));

const manager = new Manager(configPath);
const router = new Router(manager, process.stdout, pkg.version);

// MULTI-AGENT : PLUS de lock d'abdication ni de boot-sweep global (ils tueraient le serveur partage
// qu'un AUTRE agent utilise / feraient abdiquer un proxy vivant). La coordination inter-proxys passe
// desormais par le SUPERVISEUR (serveurs @playwright/mcp HTTP partages, ref-comptes ; cf supervisor.js).
// bootSupervision() = boot-reap (purge les serveurs morts/idle d'anciennes sessions) + reaper periodique
// (dead-man). No-op en mode stdio pur. NE PAS reintroduire de lock/boot-sweep global (regression P0-inverse
// = casse le multi-agent). Le self-heal d'orphelin est CIBLE dans supervisor.ensureServer.
// ⚠️ try/catch OBLIGATOIRE — NE PAS RETIRER. C'est un `await` de TOP-LEVEL : une exception ici
// avorte l'evaluation du module ES => le process meurt AVANT de servir la moindre requete, et
// `uncaughtException` ci-dessus ne la voit PAS (rien n'atterrit dans le fichier de log). Or la
// supervision est un BONUS (serveurs HTTP partages) : le proxy sait servir sans elle, en stdio.
// Un disque plein / un canal impossible doit DEGRADER, jamais tuer le MCP entier.
try {
  await manager.bootSupervision();
} catch (e) {
  log('bootSupervision a echoue, on sert SANS supervision (mode degrade): ' + describeError(e));
}

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(reason);
  try { await manager.stopSupervision(); } catch {} // retire mes heartbeats (ref-count), ne tue aucun serveur partage
  manager.stopAll();
  process.exit(0);
}

const reader = new NdjsonReader(process.stdin);
reader.on('message', (m) =>
  router.handleClientMessage(m).catch((e) => log('handle error: ' + (e?.stack || e)))
);
reader.on('parse_error', (e, line) => log('bad json from client: ' + String(line).slice(0, 200)));
reader.on('close', () => shutdown('client deconnecte, arret'));

process.on('SIGINT', () => shutdown('signal SIGINT, arret'));
process.on('SIGTERM', () => shutdown('signal SIGTERM, arret'));

log(`pw-mcp-proxy v${pkg.version} demarre | config=${configPath} | profil par defaut=${manager.activeProfile}`);
