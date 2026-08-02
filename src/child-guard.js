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
import process from 'node:process';
import { treeKill } from './prockill.js';
import { resolveShellSpawn } from './spawn-cmd.js';

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
/** Tue l'arbre du serveur puis sort. Idempotent : plusieurs signaux peuvent arriver ensemble. */
function partir(code) {
  if (fini) return;
  fini = true;
  if (enfant.pid) { try { treeKill(enfant.pid); } catch { /* deja mort : tant mieux */ } }
  process.exit(code);
}

// 🛑 L'EOF DE STDIN EST LE SIGNAL DE MORT DU PARENT. C'est la raison d'etre entiere de ce fichier.
// ⚠️ NE JAMAIS lire stdin ailleurs, ni le fermer, ni le rediriger : on detruirait le seul lien qui
// rend l'orphelin impossible. Le daemon n'ECRIT JAMAIS dedans — le tuyau ne sert qu'a se rompre.
process.stdin.on('end', () => partir(0));
process.stdin.on('close', () => partir(0));
// ⚠️ Une erreur sur le tuyau (parent disparu brutalement) vaut EOF : dans le doute, on ne LAISSE
// PAS un serveur sans parent. Le sens du fail-safe est ici « ne rien laisser derriere ».
process.stdin.on('error', () => partir(0));
process.stdin.resume(); // sans ça, aucun evenement 'end' n'est emis

// Symetrie : si le SERVEUR meurt, ce gardien n'a plus d'objet. Sa mort devient donc celle du
// serveur, et le daemon (qui surveille NOTRE pid) apprend la verite sans indirection.
enfant.on('exit', (code) => { fini = true; process.exit(code ?? 0); });
enfant.on('error', () => { fini = true; process.exit(1); });

process.on('SIGTERM', () => partir(0));
process.on('SIGINT', () => partir(0));
