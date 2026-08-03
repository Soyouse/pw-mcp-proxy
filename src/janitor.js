// janitor.js — I/O DU CONCIERGE : observer le noyau, appliquer la décision, CRIER. Posé le 03/08/2026.
//
// 🛑 CE QU'IL FERME, ET POURQUOI C'EST *LA* TÂCHE QUI LIBÈRE L'UTILISATEUR. Le gardien
// (`child-guard.js`) rend l'orphelin impossible TANT QUE LE SYSTÈME TOURNE : le daemon meurt, le
// noyau ferme le tuyau, le serveur tombe. Mais il existe deux moments où plus AUCUN de nos codes
// n'a la main — la **mise en veille** et l'**extinction/redémarrage brutal** — et ce sont
// exactement les deux moments que l'utilisateur a nommés comme ceux qui cassent. Au réveil, il
// pouvait rester des serveurs tenant un `--user-data-dir` sans plus aucun daemon pour les
// connaître : profil mort, « browser is already in use », et UN GESTE HUMAIN pour s'en sortir.
// Ce fichier est ce qui remplace ce geste. Sans lui, le contrat « zéro intervention » est faux.
//
// ⚠️ LA DÉCISION N'EST PAS ICI (`janitor-pure.js`, mutation-testée). Ici : uniquement observer,
// exécuter, journaliser. Ne JAMAIS remonter une règle de décision dans ce fichier — c'est ce qui
// la ferait sortir du crible de la mutation, donc de toute preuve.
// ⚠️ IL NE DEMANDE RIEN À PERSONNE et n'a AUCUNE option « confirmer » : un concierge qui attend un
// humain ne sert à rien, puisque son seul but est de le remplacer.

import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import { daemonChannelName } from './channel-name.js';
import { listProcesses, treeKill } from './prockill.js';
import { victimesConcierge } from './janitor-pure.js';
import { log } from './logger.js';
import { alert } from './notify.js';
import { describeError } from './error-detail.js';

/**
 * LE DAEMON EST-IL VIVANT ? On pose la question AU NOYAU, en tentant de se connecter au canal.
 *
 * 🛑 C'est le point qui rend tout le reste légitime. On n'interroge NI un fichier de registre, NI
 * un horodatage, NI un pid mémorisé — rien qui puisse mentir. Une connexion qui ABOUTIT prouve
 * qu'un process écoute À CET INSTANT ; un `ECONNREFUSED`/`ENOENT` prouve que personne n'écoute.
 * ⚠️ Sur POSIX, le FICHIER de socket survit à un crash : c'est précisément pour ça qu'on tente un
 * `connect` au lieu de tester l'existence du fichier — un fichier présent ne prouve RIEN.
 * ⚠️ Toute autre erreur ⇒ on répond VIVANT (fails-closed) : dans le doute, le concierge ne tue pas.
 * @returns {Promise<boolean>}
 */
export function daemonVivant(canal) {
  return new Promise((resolve) => {
    const sock = net.connect(canal);
    const finir = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => finir(true));
    sock.once('error', (/** @type {Error & {code?:string}} */ e) => {
      // ⚠️ `code` n'est PAS dans le type `Error` standard — il vient de `libuv` (documenté par Node
      // pour les erreurs système). On l'ANNOTE plutôt que de caster en `any` : le typage reste vrai.
      const code = e?.code || '';
      // Personne n'écoute : c'est un FAIT du noyau, pas une supposition.
      if (code === 'ECONNREFUSED' || code === 'ENOENT') return finir(false);
      log(`[concierge] canal illisible (${code}) — on suppose le daemon VIVANT et on ne touche à rien`);
      finir(true); // ⚠️ FAILS-CLOSED : une erreur inattendue ne doit JAMAIS autoriser un kill
    });
  });
}

/**
 * Les `--user-data-dir` de NOS profils, lus dans la config.
 * ⚠️ C'est la SEULE chose qui sépare « nettoyer nos serveurs » de « fermer le Chrome personnel de
 * l'utilisateur ». Config illisible ⇒ liste VIDE ⇒ le concierge ne visera QUE ses propres gardiens.
 * Jamais de repli sur un motif générique : mieux vaut nettoyer moins que nettoyer chez autrui.
 */
export function uddDeLaConfig(cheminConfig) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cheminConfig, 'utf8'));
    return Object.values(cfg.profiles || {}).map((p) => p?.userDataDir).filter(Boolean);
  } catch (e) {
    log(`[concierge] profiles.json illisible (${describeError(e)}) — aucun user-data-dir ciblé`);
    return [];
  }
}

/**
 * UNE passe de concierge. Idempotente : rejouer sur une machine propre ne fait RIEN et ne coûte
 * qu'une énumération — condition pour qu'un déclencheur puisse tirer plusieurs fois sans dégât.
 * @param {{cheminConfig:string, env?:object}} opts
 * @returns {Promise<{daemon:boolean, tues:number[]}>}
 */
export async function passeConcierge({ cheminConfig, env = {} }) {
  const canal = daemonChannelName(env);
  const vivant = await daemonVivant(canal);
  if (vivant) {
    // ⚠️ CAS NOMINAL, et il est SILENCIEUX : la machine travaille, il n'y a rien à nettoyer.
    // Journaliser ici noierait le signal (le concierge tire à chaque réveil et à chaque boot).
    return { daemon: true, tues: [] };
  }

  const tues = victimesConcierge({
    daemonVivant: false,
    processus: listProcesses(),
    uddNeedles: uddDeLaConfig(cheminConfig),
    selfPid: process.pid,
  });
  if (!tues.length) return { daemon: false, tues: [] }; // rien à faire : silence, c'est le cas sain

  // 🛑 ON CRIE. Un nettoyage muet ferait de ce fichier une boîte noire : l'utilisateur ne saurait
  // jamais que son système a dérivé, ni à quelle fréquence. Or c'est le compteur qui dira, au bout
  // des deux semaines de mesure, si le contrat tient. Le silence rendrait la mesure impossible.
  for (const pid of tues) { try { treeKill(pid); } catch (e) { log(`[concierge] kill ${pid}: ${describeError(e)}`); } }
  alert(`[concierge] AUCUN daemon vivant, ${tues.length} process sans propriétaire supprimé(s) (pid: ${tues.join(', ')})`);
  return { daemon: false, tues };
}
