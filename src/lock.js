// lock.js — single-instance lock COOPERATIF (etat de l'art 2026 pour un serveur stdio increvable).
//
// POURQUOI : la spec MCP (lifecycle) dit que le CLIENT doit arreter un serveur stdio en fermant
// son stdin. Quand un client (ex: Claude Code, cf sdk#532) spawn un nouveau proxy SANS fermer le
// stdin de l'ancien, l'ancien reste VIVANT et garde son backend+Chrome (= la cause racine REPRODUITE
// des orphelins). La spec exige qu'on se protege « contre un client qui se comporte mal » => defense.
//
// PATTERN = last-writer-wins sur un lockfile PID, keye sur le chemin de config (les proxys de MEME
// config se coordonnent ; configs differentes = locks disjoints, zero interference). Un proxy neuf
// ecrit son PID ; les anciens voient le PID changer et ABDIQUENT (arret gracieux, self-exit).
// Complementaire du boot-sweep : le lockfile est COOPERATIF (l'ancien s'eteint seul, zero zombie),
// le boot-sweep est FORCEFUL (reclame la ressource si un ancien est bloque). Defense en profondeur.
//
// ⚠️ fs.watchFile (polling stat), PAS fs.watch : le polling est fiable cross-OS (fs.watch est
// capricieux/inconsistant selon la plateforme). NE PAS remplacer par fs.watch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { log } from './logger.js';

export function lockPathFor(configPath) {
  const id = crypto.createHash('sha1').update(String(configPath)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `pw-mcp-proxy-${id}.lock`);
}

// Acquiert le lock (ecrit mon PID) et surveille les reprises. onSuperseded() est appele SI un
// proxy plus recent reprend le lock => l'appelant doit s'arreter proprement (stopAll + exit).
// Retourne { lockPath, release() } ; release() ne supprime le fichier QUE s'il porte encore mon PID.
export function acquireSingleInstanceLock(configPath, onSuperseded, { interval = 1000 } = {}) {
  const lockPath = lockPathFor(configPath);
  const myPid = String(process.pid);
  try {
    fs.writeFileSync(lockPath, myPid);
  } catch (e) {
    log('lock: ecriture impossible (' + e.message + ') — on continue sans lock');
    return { lockPath, release() {} };
  }
  log(`lock single-instance acquis pid=${myPid} (${lockPath})`);

  let superseded = false;
  const onChange = () => {
    let cur = '';
    try {
      cur = fs.readFileSync(lockPath, 'utf8').trim();
    } catch {
      return; // fichier momentanement absent : on ignore
    }
    if (cur && cur !== myPid && !superseded) {
      superseded = true;
      log(`lock repris par pid=${cur} => abdication de pid=${myPid} (arret gracieux)`);
      fs.unwatchFile(lockPath, onChange);
      try {
        onSuperseded();
      } catch (e) {
        log('onSuperseded err: ' + e.message);
      }
    }
  };
  fs.watchFile(lockPath, { interval }, onChange);

  return {
    lockPath,
    release() {
      try {
        fs.unwatchFile(lockPath, onChange);
        // NE supprime QUE si le lock est encore le mien : ne jamais effacer la revendication d'un neuf.
        if (fs.readFileSync(lockPath, 'utf8').trim() === myPid) fs.unlinkSync(lockPath);
      } catch {
        /* best-effort */
      }
    },
  };
}
