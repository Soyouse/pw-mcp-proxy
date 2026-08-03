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
// detient l'extremite d'ECRITURE de NOTRE STDIN (fd 0). Un descripteur qui fuit vers un autre
// process = EOF qui n'arrive JAMAIS = orphelin silencieux, indiagnosticable.
// 🛑 C'est pourquoi l'enfant recoit **`stdio[0] = 'ignore'`** : il ne doit heriter d'AUCUNE
// extremite de notre tuyau. NE JAMAIS lui passer 'inherit' ni 'pipe' EN POSITION 0.
// ⚠️ CETTE CONDITION NE PORTE QUE SUR fd 0. Jusqu'au 03/08/2026 l'enfant etait lance en
// `stdio:'ignore'` GLOBAL — par confusion, la regle sur fd 0 avait ete etendue a fd 1 et 2, ou
// elle n'a AUCUN fondement (ce sont des extremites d'ECRITURE que NOUS creons, elles ne peuvent
// pas retenir l'EOF de notre propre stdin). Cf le bloc « ON LIT SA SORTIE » plus bas.
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
import { log } from './logger.js';
import { bootLogger } from './log-boot.js';

// 🛑 LE GARDIEN DOIT LAISSER UNE TRACE — il était TOTALEMENT MUET jusqu'au 03/08/2026.
// C'est le dernier maillon de la chaîne anti-orphelin : quand il tue un serveur parce que le
// daemon a disparu, PERSONNE d'autre ne peut le journaliser — le daemon est mort, justement.
// L'action de sécurité la plus importante du design ne laissait donc AUCUNE trace, et un
// « mon navigateur s'est fermé tout seul » aurait été indiagnosticable.
// ⚠️ ÉCRIRE DANS LE FICHIER, jamais sur stderr : le daemon nous lance en `stdio[1,2]='ignore'`,
// donc tout `stderr.write` part au néant. Le fichier est le SEUL canal qui nous survit.
// ⚠️ MÊME fichier que le proxy et le daemon (variable `PW_MCP_LOG`) : un incident se lit sur UNE
// seule chronologie. La rotation est déjà multi-écrivains (taille lue sur le FS, cf logger.js).
bootLogger(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

// Borne d'UNE ligne relayee depuis le serveur. Ce n'est PAS un delai (rien a voir avec `budget.js`,
// source unique des DUREES) : c'est un cap de taille, de la meme famille que `maxBytes` du logger.
// ⚠️ Raison d'etre : un serveur qui deverse une ligne de plusieurs Mo consommerait a lui seul toute
// une generation de journal et effacerait le reste de la chronologie.
const MAX_LIGNE = 2000;

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

// 🛑 ON LIT LA SORTIE DU SERVEUR — le trou qui AVEUGLAIT LA PRODUCTION jusqu'au 03/08/2026.
// L'enfant est `@playwright/mcp`. Quand Chrome se vautre, qu'un `--user-data-dir` est verrouille,
// qu'une veille casse la session ou qu'une update change un flag, **la cause EXACTE est ecrite par
// LUI, sur ses flux**. Ils partaient au neant (`stdio:'ignore'` global) : le seul temoignage etait
// « serveur MORT (code=1) », c'est-a-dire RIEN. C'est exactement la panne muette que ce projet
// s'interdit ; toute autre observabilite est vaine tant que ce canal est jete.
// ⚠️ POURQUOI C'ETAIT INVISIBLE : en mode **stdio** (`stdio-transport.js`), stderr EST capture.
// Seul le mode **HTTP — LA PRODUCTION** le perdait, et les tests empruntent le chemin qui voit.
//
// 🛑 fd 0 RESTE 'ignore' — LE LIEN DE VIE EST INTACT. Seuls fd 1 et 2 deviennent des tuyaux, dont
// NOUS tenons l'extremite de LECTURE : ils ne peuvent structurellement pas retenir l'EOF de notre
// PROPRE stdin. NE JAMAIS toucher a la position 0 (cf en-tete). Gate : `child-guard.test.js`.
//
// ⚠️ POURQUOI DES TUYAUX RELAYES ET NON UN DESCRIPTEUR DE FICHIER (`openSync(log,'a')`) — qui
// paraissait plus simple : (1) un fd ouvert en permanence sur le journal EMPECHE le `renameSync`
// de la rotation sous Windows (EPERM/EBUSY), on casserait la borne disque pour gagner l'observabilite ;
// (2) la sortie brute arriverait SANS horodatage ni prefixe, melangee aux lignes du proxy et du
// daemon — illisible en incident, alors que l'unique chronologie est justement le but.
// Passer par `log()` garde la rotation SOUS CONTROLE et rend chaque ligne attribuable.
const enfant = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell });

/**
 * Relaie un flux du serveur vers le journal, LIGNE PAR LIGNE.
 * ⚠️ Decoupage par ligne OBLIGATOIRE : un chunk peut couper au milieu d'un message, et `log()`
 * horodate ce qu'on lui donne — sans regroupement, une trace d'erreur devient illisible.
 * ⚠️ Chaque ligne est BORNEE : un serveur qui deverse une ligne de plusieurs Mo (dump, boucle)
 * ne doit pas faire tourner la rotation a lui seul. La borne disque reste celle de `logger.js`.
 * @param {import('node:stream').Readable|null} flux
 * @param {string} canal
 */
function relayer(flux, canal) {
  if (!flux) return;
  let reste = '';
  flux.setEncoding('utf8');
  flux.on('data', (bout) => {
    const lignes = (reste + bout).split(/\r?\n/);
    reste = lignes.pop() ?? '';
    if (reste.length > MAX_LIGNE) { lignes.push(reste); reste = ''; } // ligne sans fin : on coupe
    for (const l of lignes) if (l.trim()) log(`[serveur:${canal}] ${l.slice(0, MAX_LIGNE)}`);
  });
  // Silence DELIBERE : le flux casse quand l'enfant meurt — sa MORT est deja journalisee ci-dessous
  // par 'exit'. Logguer en plus l'erreur du tuyau ajouterait du bruit a chaque arret NORMAL.
  flux.on('error', () => { /* SILENCE: rupture du tuyau = mort de l'enfant, deja tracee par 'exit' */ });
}
relayer(enfant.stdout, 'out');
relayer(enfant.stderr, 'err');

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
  // 🛑 SUR POSIX ON TUE NOTRE GROUPE (`process.pid`), PAS LE PID DE L'ENFANT. Contre-intuitif, et
  // pourtant c'est la seule forme correcte (defaut trouve le 03/08/2026, branche fix/guard-group-kill) :
  //   • le daemon nous lance `detached` ⇒ NOUS sommes chef de groupe (pgid === notre pid) ;
  //   • notre enfant est lance SANS `detached` ⇒ il est DANS notre groupe, sans en etre le chef.
  // Donc `kill(-enfantPid)` ne designe AUCUN groupe ⇒ `treeKill` retombe sur `kill(enfantPid)` ⇒ le
  // serveur meurt mais **CHROME, son petit-enfant, SURVIT** en tenant le `--user-data-dir` : le
  // profil devient inutilisable, c'est-a-dire exactement l'orphelin que ce fichier existe pour
  // interdire. `treeKill(process.pid)` vise le groupe ENTIER — gardien + serveur + Chrome.
  // ⚠️ NE PAS « corriger » en detachant l'enfant : il quitterait notre groupe, et le
  // `treeKill(pidGardien)` du daemon ne l'atteindrait plus — on rouvrirait l'orphelin par l'autre
  // bout. L'enfant DOIT rester dans notre groupe ; c'est NOUS qui devons viser le groupe.
  // ⚠️ WINDOWS EN EST EXCLU, et ce n'est pas un oubli : `taskkill /T /F` descend l'arbre par
  // PARENTE, sans notion de groupe, donc viser l'enfant y est deja exact. Viser `process.pid` nous
  // tuerait NOUS AVANT le `process.exit(code)` ci-dessous ⇒ le daemon lirait une mort par signal au
  // lieu de notre code de sortie, et perdrait l'information la plus utile de l'incident.
  const cible = process.platform === 'win32' ? enfant.pid : process.pid;
  if (cible) { try { treeKill(cible); } catch { /* deja mort : tant mieux */ } }
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
