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
import { sweepByCmd } from './prockill.js';
import { acquireSingleInstanceLock } from './lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const configPath = process.env.PW_MCP_PROFILES || path.join(root, 'profiles.json');
const logPath = process.env.PW_MCP_LOG || path.join(root, 'pw-mcp-proxy.log');

initLogger(logPath);
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e?.stack || e)));

const manager = new Manager(configPath);

// BOOT-SWEEP self-healing (fix leak P0) : un proxy neuf n'a encore RIEN spawne, donc tout
// process tenant un de nos --user-data-dir est un ORPHELIN d'un proxy precedent (SIGKILL par
// le superviseur MCP => cleanup jamais execute => backends+Chrome survivants qui gardent le lock).
// On les tue avant de servir => plus jamais de "Browser is already in use" au demarrage.
// ⚠️ Sweep par user-data-dir UNIQUEMENT (jamais le Chrome perso). needles vide (aucun profil
// avec userDataDir, ex: tests a faux backends) => no-op, aucune enumeration.
try {
  const killed = sweepByCmd(manager.userDataDirs());
  if (killed.length) log(`boot-sweep: ${killed.length} orphelin(s) tue(s) [${killed.join(',')}]`);
} catch (e) {
  log('boot-sweep erreur (ignoree): ' + (e?.message || e));
}

const router = new Router(manager, process.stdout, pkg.version);

// LOCK single-instance COOPERATIF (cf lock.js) : acquis APRES le boot-sweep (on reclame d'abord la
// ressource navigateur, puis on revendique le lock, ce qui signale aux anciens proxys d'abdiquer).
// Si un proxy plus recent reprend le lock => on s'arrete proprement (zero zombie). Complementaire
// du boot-sweep (coop vs forceful = defense en profondeur contre un client MCP qui n'arrete pas
// l'ancien proxy comme la spec l'exige).
const lock = acquireSingleInstanceLock(configPath, () => {
  manager.stopAll();
  process.exit(0);
});

let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(reason);
  lock.release();
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
