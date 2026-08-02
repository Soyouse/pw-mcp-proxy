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
    if (out.status === 0) return out.stdout;
    // ⚠️ DIAGNOSTIC OBLIGATOIRE : sans lui, un echec de lecture est indiscernable d'un PID recycle,
    // et le reap cesse de nettoyer SANS QUE PERSONNE NE SACHE POURQUOI (macOS, CI du 2026-08-02 :
    // deux hypotheses successives fausses faute de cette ligne). Meme lecon que le `err.code`
    // non journalise du 01/08 — on ne diagnostique pas ce qu'on n'imprime pas.
    log(
      `proc-identity: ${cmd} status=${out.status} signal=${out.signal || '-'} ` +
        `stdout=${JSON.stringify((out.stdout || '').slice(0, 120))} ` +
        `stderr=${JSON.stringify((out.stderr || '').slice(0, 200))}`
    );
    return null;
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
  //
  // ⚠️ `-x` OBLIGATOIRE, et ce n'est PAS un detail de confort : sur BSD/macOS, `ps` ne liste par
  //    defaut que les process RATTACHES A UN TERMINAL. Or nos serveurs sont spawnes `detached`
  //    (donc sans TTY) ⇒ sans `-x` ils sont INVISIBLES, `ps` sort en status 1, l'identite est
  //    illisible, le verdict devient `unknown` et **le reap cesse de nettoyer quoi que ce soit
  //    sur macOS** — fuite de serveurs silencieuse. Bug REEL, revele par le 1er run CI macOS du
  //    2026-08-02 (2 tests de reap rouges) ; Windows et Linux ne pouvaient pas l'exhiber :
  //    Linux lit /proc, Windows passe par CIM. NE JAMAIS retirer `-x`.
  const out = runSync('ps', ['-x', '-p', String(pid), '-o', 'lstart=']);
  return out ? parseLstart(out) : null;
}
