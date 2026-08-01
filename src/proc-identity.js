// I/O — lit l'IDENTITE d'un process (pid + instant de demarrage) aupres du SYSTEME.
// La decision (parsing, comparaison) vit dans proc-identity-pure.js (mutation-teste).
//
// ⚠️ COUT MESURE le 2026-08-01 sur cette machine : **653 ms** pour un appel PowerShell/CIM.
//    C'est cher. CONSEQUENCE DE CONCEPTION, non negociable : l'identite se lit UNIQUEMENT
//    juste avant une action DESTRUCTIVE (`treeKill`), JAMAIS dans le chemin chaud.
//    Pour « ce serveur repond-il ? », la preuve reste la SONDE HTTP — elle est plus rapide ET
//    plus probante (une reponse MCP sur ce port prouve que c'est bien notre serveur).
// ⚠️ Linux est le seul chemin GRATUIT (lecture de /proc). Ne pas uniformiser vers un `ps` unique
//    « pour simplifier » : on paierait un spawn la ou le noyau repond en une lecture de fichier.
// ⚠️ FAILS-CLOSED PARTOUT : toute erreur rend `null`, et `null` ne matche jamais (cf pur).
//    Ne PAS transformer un echec de lecture en « probablement le meme process » : ce serait
//    remettre une inference exactement la ou se trouve l'action irreversible.

import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { parseLinuxStat, parseWindowsCreationDate, parseLstart } from './proc-identity-pure.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';

// ⚠️ spawnSync assume : cet appel n'a lieu qu'avant un kill (rare, hors chemin chaud) et le
// process est mort au retour ⇒ aucune fuite possible. Meme exception que le gate ast-grep.
function runSync(cmd, args) {
  try {
    const out = spawnSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return out.status === 0 ? out.stdout : null;
  } catch (e) {
    log(`proc-identity: ${cmd} — ${describeError(e)}`);
    return null;
  }
}

/**
 * Identite du process `pid`, ou null s'il n'existe pas / est illisible.
 *
 * @param {number} pid
 * @param {{platform?: string}} [env] injecte pour les tests
 * @returns {string|null} token OPAQUE — a comparer par EGALITE uniquement, jamais interprete
 */
export function processIdentity(pid, env = {}) {
  const platform = env.platform || process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (platform === 'linux') {
    // Chemin GRATUIT : une lecture de fichier, pas de spawn. starttime = ticks depuis le boot,
    // donc immunise aux sauts d'horloge par construction.
    try {
      return parseLinuxStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return null; // process disparu entre-temps : absence de preuve = pas de kill
    }
  }

  if (platform === 'win32') {
    // `Get-CimInstance` (API moderne) — `wmic` est DEPRECIE et retire de Windows 11 : ne pas y revenir.
    const out = runSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
        `ForEach-Object { $_.CreationDate.ToString('o') }`,
    ]);
    return out ? parseWindowsCreationDate(out) : null;
  }

  // macOS/BSD — `lstart` donne l'instant de demarrage absolu (`etime` donnerait une DUREE, qui
  // change a chaque lecture : inutilisable comme identite).
  const out = runSync('ps', ['-p', String(pid), '-o', 'lstart=']);
  return out ? parseLstart(out) : null;
}
