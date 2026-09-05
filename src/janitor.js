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
import os from 'node:os';
import path from 'node:path';
import { daemonChannelName } from './channel-name.js';
import { listProcesses, treeKill } from './prockill.js';
import { victimesConcierge } from './janitor-pure.js';
import { cheminsCoffre } from './identity-store-pure.js';
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
    const v1 = Object.values(cfg.profiles || {}).map((p) => p?.userDataDir).filter(Boolean);
    // v2 (05/09/2026) : une INSTANCE tourne sous `instances.dir/<id>` (snapshot) ou sous le coffre
    // lui-meme (`inplace`). Les deux PREFIXES sont a nous — meme source unique que le manager.
    const { storeDir, instancesDir } = cheminsCoffre(cfg, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join);
    return [...v1, storeDir, instancesDir];
  } catch (e) {
    log(`[concierge] profiles.json illisible (${describeError(e)}) — aucun user-data-dir ciblé`);
    return [];
  }
}

/**
 * Le dossier des instances, lu dans la config (`null` si illisible : on ne purge pas a l'aveugle).
 */
export function instancesDirDeLaConfig(cheminConfig) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cheminConfig, 'utf8'));
    return cheminsCoffre(cfg, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join).instancesDir;
  } catch (e) {
    log(`[concierge] profiles.json illisible (${describeError(e)}) — aucun dossier d'instances ciblé`);
    return null;
  }
}

/**
 * Supprime les dossiers d'INSTANCES orphelins. A n'appeler QUE daemon MORT (meme garde que les
 * process) : une instance est JETABLE PAR DEFINITION — son client est parti avec le daemon, et
 * son identite a ete rangee (ou perdue, mais un dossier orphelin ne la rendrait pas : Chrome
 * n'y ecrit plus). Idempotent, ne throw jamais, rend les chemins supprimes.
 * ⚠️ JAMAIS le coffre : une identite n'a pas de proprietaire vivant, c'est sa nature.
 */
export function purgerInstancesOrphelines(instancesDir) {
  const supprimes = [];
  if (!instancesDir) return supprimes;
  let entrees;
  try { entrees = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch (e) {
    if (e?.code !== 'ENOENT') log(`[concierge] instances illisibles (${describeError(e)})`);
    return supprimes; // absent = rien a purger, c'est le cas sain
  }
  for (const e of entrees) {
    // Un dossier d'instance, ou le fichier `--config` ecrit a cote de lui (`<id>.config.json`) : rien d'autre.
    if (!e.isDirectory() && !(e.isFile() && e.name.endsWith('.config.json'))) continue;
    const p = path.join(instancesDir, e.name);
    try { fs.rmSync(p, { recursive: true, force: true }); supprimes.push(p); }
    catch (err) { log(`[concierge] instance orpheline non supprimee ${p}: ${describeError(err)}`); }
  }
  return supprimes;
}

/**
 * UNE passe de concierge. Idempotente : rejouer sur une machine propre ne fait RIEN et ne coûte
 * qu'une énumération — condition pour qu'un déclencheur puisse tirer plusieurs fois sans dégât.
 * @param {{cheminConfig:string, env?:object}} opts
 * @returns {Promise<{daemon:boolean, tues:number[], dossiers:string[]}>}
 */
export async function passeConcierge({ cheminConfig, env = {} }) {
  const canal = daemonChannelName(env);
  const vivant = await daemonVivant(canal);
  if (vivant) {
    // ⚠️ CAS NOMINAL, et il est SILENCIEUX : la machine travaille, il n'y a rien à nettoyer.
    // Journaliser ici noierait le signal (le concierge tire à chaque réveil et à chaque boot).
    return { daemon: true, tues: [], dossiers: [] };
  }

  const tues = victimesConcierge({
    daemonVivant: false,
    processus: listProcesses(),
    uddNeedles: uddDeLaConfig(cheminConfig),
    selfPid: process.pid,
  });
  // Process D'ABORD (un Chrome vivant tient ses fichiers), dossiers d'instances orphelins ENSUITE.
  for (const pid of tues) { try { treeKill(pid); } catch (e) { log(`[concierge] kill ${pid}: ${describeError(e)}`); } }
  const dossiers = purgerInstancesOrphelines(instancesDirDeLaConfig(cheminConfig));
  if (!tues.length && !dossiers.length) return { daemon: false, tues: [], dossiers: [] }; // rien à faire : silence, c'est le cas sain

  // 🛑 ON CRIE. Un nettoyage muet ferait de ce fichier une boîte noire : l'utilisateur ne saurait
  // jamais que son système a dérivé, ni à quelle fréquence. Or c'est le compteur qui dira, au bout
  // des deux semaines de mesure, si le contrat tient. Le silence rendrait la mesure impossible.
  alert(`[concierge] AUCUN daemon vivant, ${tues.length} process sans propriétaire supprimé(s) (pid: ${tues.join(', ')}), ${dossiers.length} dossier(s) d'instance orphelin(s) purgé(s)`);
  return { daemon: false, tues, dossiers };
}
