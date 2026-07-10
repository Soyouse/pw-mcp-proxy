// prockill.js — enumeration + kill d'ARBRE de process, cross-plateforme, ZERO dependance.
// Raison d'etre = neutraliser le leak P0 : un backend @playwright/mcp lance
// npx -> node cli.js -> chrome.exe. `child.kill()` n'envoie SIGTERM qu'au parent direct :
// Chrome (petit-enfant) survit et GARDE le lock SingletonLock du --user-data-dir,
// ce qui fait echouer tout backend suivant ("Browser is already in use").
// => il faut tuer l'ARBRE, et pouvoir balayer les orphelins d'un proxy deja mort.
//
// ⚠️ SECURITE : le balayage se fait par sous-chaine `--user-data-dir` (ex `.pw-profiles/vegeta`).
//   Ces dossiers sont UNIQUES a nos profils isoles. Le Chrome PERSO de l'utilisateur tourne
//   sur `AppData\...\User Data` => il n'est JAMAIS matche. NE JAMAIS elargir a `chrome.exe`
//   nu ni a un needle generique : ce serait fermer le navigateur perso (danger acte, BACKLOG P1).

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { selectVictims } from './prockill-pure.js';

const onWin = process.platform === 'win32';

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // existe mais pas les droits => vivant
  }
}

// Tue le process ET tout son arbre (petits-enfants Chrome inclus).
// ⚠️ NE PAS remplacer par child.kill() : il ne tue que le parent direct (cf en-tete).
export function treeKill(pid) {
  if (!pid) return;
  try {
    if (onWin) {
      // /T = arbre, /F = force. Idempotent : un PID deja mort renvoie juste une erreur ignoree.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      // Backends spawnes en `detached` => group leader (pgid = pid) : -pid tue tout le groupe.
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  } catch {
    /* best-effort : jamais throw au shutdown */
  }
}

// Enumere [{pid, cmd}] de tous les process avec leur ligne de commande complete.
// spawnSync bloquant : reserve au boot / restart_profile (rare), jamais dans le chemin chaud.
export function listProcesses() {
  try {
    if (onWin) {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
      );
      return (out.stdout || '')
        .split(/\r?\n/)
        .map((l) => {
          const i = l.indexOf('\t');
          if (i < 0) return null;
          const pid = Number(l.slice(0, i));
          const cmd = l.slice(i + 1);
          return pid && cmd ? { pid, cmd } : null;
        })
        .filter(Boolean);
    }
    const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return (out.stdout || '')
      .split(/\n/)
      .map((l) => {
        const m = l.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), cmd: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Tue (arbre) tout process HORS self dont la cmdline contient un des needles. Retourne les PIDs
// tues. needles vide => no-op SANS enumeration (garde-fou : jamais de sweep large accidentel).
// La DECISION (quels PID) = selectVictims (pur, mutation-teste) ; ici on ne fait que l'I/O.
export function sweepByCmd(needles, selfPid = process.pid) {
  const wanted = (needles || []).filter(Boolean);
  if (!wanted.length) return [];
  const victims = selectVictims(listProcesses(), needles, selfPid);
  for (const pid of victims) treeKill(pid);
  return victims;
}
