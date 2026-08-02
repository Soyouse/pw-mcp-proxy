#!/usr/bin/env node
// I/O — LE GARDIEN : rend l'ORPHELIN IMPOSSIBLE PAR CONSTRUCTION.
//
// 🛑 LE PROBLEME QU'IL RESOUT. Le daemon est le parent des serveurs `@playwright/mcp`. S'il meurt
// BRUTALEMENT (`kill -9`, OOM killer, coupure), ses enfants SURVIVENT et plus personne ne les
// connait : ils tiennent leur `--user-data-dir` a vie => « browser is already in use », et le
// profil devient inutilisable jusqu'a une intervention humaine.
//
// 🛑 LA SOLUTION, ET POURQUOI CELLE-LA. On refuse la reponse « au demarrage, balayer ce qui a l'air
// orphelin » : c'est un JUGEMENT sur des process existants, avec un `kill` derriere. La question
// « ce serveur a-t-il encore un parent ? » a une reponse EXACTE si on la pose au NOYAU :
//     le daemon nous parle par un TUYAU (notre stdin).
//     Il meurt, QUELLE QUE SOIT la cause => le noyau ferme le tuyau => on recoit EOF.
// L'EOF n'est pas un indice, c'est l'evenement. Zero horloge, zero heartbeat, zero TTL — la MEME
// primitive que le refcount du daemon, appliquee un etage plus bas.
//
// ⚠️ POURQUOI PAS L'IPC NODE (`stdio:'ipc'` + evenement `disconnect`) — alternative la plus
// souvent citee, VERIFIEE A LA SOURCE le 02/08/2026 (nodejs.org/api/child_process.html) :
// la doc officielle decrit `'disconnect'` comme emis « after calling subprocess.disconnect() in
// parent process or process.disconnect() in child process » — donc sur un APPEL EXPLICITE. Elle
// ne dit RIEN de la mort du parent. S'y fier serait bâtir sur du NON CONTRACTUEL, qui peut changer
// sans préavis. L'EOF sur un tuyau, lui, est garanti par l'OS : POSIX (`read()` rend 0 quand
// toutes les extremites d'ecriture sont fermees) et Win32 (`ERROR_BROKEN_PIPE`). On depend du
// noyau, pas d'un detail d'implementation de Node — c'est le contrat le plus stable disponible.
//
// 🛑 LA CONDITION DE VALIDITE, ET ELLE EST ABSOLUE : l'EOF n'arrive QUE si PERSONNE d'autre ne
// detient l'extremite d'ECRITURE de notre stdin. Un descripteur qui fuit vers un autre process =
// EOF qui n'arrive JAMAIS = orphelin silencieux, indiagnosticable.
// ⚠️ C'est pourquoi notre enfant est lance en `stdio:'ignore'` : il ne doit HERITER de rien.
// NE JAMAIS lui passer 'inherit' ni un 'pipe' : on romprait le lien de vie sans aucun signal.
// Scelle par `tests/child-guard.test.js` (DEUX serveurs tues par UNE mort de parent).
//
// ⚠️ POURQUOI PAS LE MECANISME NATIF DE L'OS : `prctl(PR_SET_PDEATHSIG)` (Linux) et les Job Objects
// `KILL_ON_JOB_CLOSE` (Windows — ce qu'utilisent Chrome, VS Code, Docker Desktop) font exactement
// ca dans le noyau, mais AUCUN n'est joignable depuis Node sans module natif. Le dépôt est a ZERO
// dependance runtime (repo public, `npx` sans droits admin) => ce gardien est l'equivalent portable.
// C'est le pattern des supervision trees (Erlang), du channel Mojo de Chrome, du ptyHost de VS Code.
//
// ⚠️ COUT ASSUME : un process Node (~10 Mo) par serveur, en face d'un Chrome qui en pese des
// centaines. NE PAS « optimiser » en le retirant : on rachèterait la classe de pannes ci-dessus.
//
// USAGE (jamais a la main) : node child-guard.js <commande> [args...]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { treeKill } from './prockill.js';
import { resolveShellSpawn } from './spawn-cmd.js';
import { describeError } from './error-detail.js';
import { initLogger, log } from './logger.js';

// 🛑 LE GARDIEN DOIT LAISSER UNE TRACE — il était TOTALEMENT MUET jusqu'au 03/08/2026.
// C'est le dernier maillon de la chaîne anti-orphelin : quand il tue un serveur parce que le
// daemon a disparu, PERSONNE d'autre ne peut le journaliser — le daemon est mort, justement.
// L'action de sécurité la plus importante du design ne laissait donc AUCUNE trace, et un
// « mon navigateur s'est fermé tout seul » aurait été indiagnosticable.
// ⚠️ ÉCRIRE DANS LE FICHIER, jamais sur stderr : le daemon nous lance en `stdio[1,2]='ignore'`,
// donc tout `stderr.write` part au néant. Le fichier est le SEUL canal qui nous survit.
// ⚠️ MÊME fichier que le proxy et le daemon (variable `PW_MCP_LOG`) : un incident se lit sur UNE
// seule chronologie. La rotation est déjà multi-écrivains (taille lue sur le FS, cf logger.js).
initLogger(process.env.PW_MCP_LOG || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pw-mcp-proxy.log'));

const [brut, ...argsBruts] = process.argv.slice(2);
if (!brut) {
  process.stderr.write('child-guard: aucune commande\n');
  process.exit(2);
}

// ⚠️ LA RESOLUTION SHELL SE FAIT ICI, pas chez l'appelant : si le daemon lancait CE gardien a
// travers un shell, notre stdin serait celui de `cmd.exe` — le tuyau ne serait plus le notre et
// l'EOF n'arriverait jamais au bon process. Le gardien est donc lance NU (chemin absolu de node),
// et c'est lui qui applique `spawn-cmd.js` (source UNIQUE, partagee avec le reste du dépôt).
const { command, args, shell } = resolveShellSpawn(brut, argsBruts);
// ⚠️ `detached:false` : l'enfant reste DANS notre arbre, sinon `treeKill` ne le retrouverait pas.
const enfant = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell });

let fini = false;
/**
 * Tue l'arbre du serveur puis sort. Idempotent : plusieurs signaux peuvent arriver ensemble.
 * @param {number} code
 * @param {string} raison POURQUOI on tue — le SEUL enregistrement de cet événement (cf en-tête).
 */
function partir(code, raison) {
  if (fini) return;
  fini = true;
  // ⚠️ LOGGUER AVANT DE TUER : on sort juste après, une trace écrite ensuite pourrait ne jamais
  // partir. Et c'est le seul endroit du système d'où cet événement est observable.
  log(`[gardien] ${raison} => arret du serveur (pid=${enfant.pid ?? '?'})`);
  if (enfant.pid) { try { treeKill(enfant.pid); } catch { /* deja mort : tant mieux */ } }
  process.exit(code);
}

// 🛑 L'EOF DE STDIN EST LE SIGNAL DE MORT DU PARENT. C'est la raison d'etre entiere de ce fichier.
// ⚠️ NE JAMAIS lire stdin ailleurs, ni le fermer, ni le rediriger : on detruirait le seul lien qui
// rend l'orphelin impossible. Le daemon n'ECRIT JAMAIS dedans — le tuyau ne sert qu'a se rompre.
process.stdin.on('end', () => partir(0, 'EOF sur stdin : le daemon parent a disparu'));
process.stdin.on('close', () => partir(0, 'stdin ferme : le daemon parent a disparu'));
// ⚠️ Une erreur sur le tuyau (parent disparu brutalement) vaut EOF : dans le doute, on ne LAISSE
// PAS un serveur sans parent. Le sens du fail-safe est ici « ne rien laisser derriere ».
process.stdin.on('error', () => partir(0, 'erreur sur le tuyau du parent (vaut EOF)'));
process.stdin.resume(); // sans ça, aucun evenement 'end' n'est emis

// Symetrie : si le SERVEUR meurt, ce gardien n'a plus d'objet. Sa mort devient donc celle du
// serveur, et le daemon (qui surveille NOTRE pid) apprend la verite sans indirection.
enfant.on('exit', (code, sig) => {
  fini = true;
  log(`[gardien] le serveur est mort SEUL (code=${code} sig=${sig}) => le gardien sort (symetrie)`);
  process.exit(code ?? 0);
});
enfant.on('error', (e) => {
  fini = true;
  log(`[gardien] spawn du serveur IMPOSSIBLE : ${describeError(e)}`);
  process.exit(1);
});

process.on('SIGTERM', () => partir(0, 'SIGTERM recu'));
process.on('SIGINT', () => partir(0, 'SIGINT recu'));
