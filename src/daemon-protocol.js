// PUR — SÉMANTIQUE des messages échangés entre un proxy et le daemon, sur le canal nommé.
//
// ⚠️ CE MODULE NE FAIT **PAS** LE FRAMING. Le découpage en lignes est celui de `jsonrpc.js`
// (`NdjsonReader` / `writeMessage`), réutilisé TEL QUEL sur la socket du canal. Deux raisons, et
// aucune n'est esthétique :
//   1. ZÉRO DOUBLON — un second framing ndjson dans le dépôt, c'est deux vérités qui divergent le
//      jour où l'une est corrigée et pas l'autre.
//   2. C'est ce que la SPEC demande. MCP `2026-07-28`, §Custom Transports : « Custom transports
//      that run over a reliable bidirectional byte stream (e.g., Unix domain sockets or TCP)
//      SHOULD reuse the stdio framing rather than defining a new one ». Notre canal nommé EST un
//      byte stream fiable bidirectionnel : on est exactement dans ce cas.
//
// ── LE CONTRAT ────────────────────────────────────────────────────────────────────────────────
// Le proxy ouvre UNE connexion par profil qu'il utilise, et la GARDE OUVERTE tant qu'il s'en sert.
// ⚠️ **LA CONNEXION EST LE REF-COUNT.** Ce n'est pas une métaphore : le nombre de sockets ouvertes
// sur le canal EST le nombre de clients, tenu par le NOYAU, exact, et libéré même si le proxy
// meurt d'un `kill -9`. C'est ce qui remplace heartbeat + TTL + reaper — et c'est pour ça qu'il
// n'existe AUCUN message « je suis toujours là » ni « je m'en vais » dans ce protocole :
// les inventer, ce serait réintroduire l'inférence qu'on supprime.
//
//   proxy → daemon   { op: 'acquire', profile, spec, instance? }   UNE fois, à l'ouverture
//   daemon → proxy   { ok: true,  url, instanceId }                le serveur est PRÊT (fait, pas promesse)
//   daemon → proxy   { ok: false, erreur }                         échec NOMMÉ (jamais un silence)
//   fermeture socket                                               = « je n'utilise plus cette instance »
//
// ── DEPUIS LE 05/09/2026 : UNE INSTANCE PAR CLIENT, PLUS DE SERVEUR PARTAGÉ ───────────────────
// `instance` (optionnel) décrit une IDENTITÉ à matérialiser : le daemon copie son snapshot dans
// un dossier NEUF, y lance UN serveur pour CE client, et rend l'`instanceId`. Deux clients de la
// même identité obtiennent DEUX instances (mesuré 04/09 : un serveur partagé = les agents
// s'écrasent la page). Sans `instance` (profil v1 `userDataDir` ou `--isolated`), la spec porte
// déjà tout ce qu'il faut et le daemon lance le serveur tel quel — toujours un par client.
// ⚠️ Un daemon ANCIEN répondrait `{ok:true,url}` sans `instanceId` : `lireReponse` le REFUSE
// (fails-closed, motif nommé) — un proxy neuf ne s'accroche jamais à un daemon qui partagerait.
//
// Fonctions TOTALES : elles ne throw JAMAIS. Un message malformé rend un refus explicite, jamais
// une exception — le daemon sert N clients, l'un d'eux ne doit pas pouvoir le faire tomber.

import { STRATEGIES, nomIdentiteValide } from './identity-store-pure.js';
import { verdictConfiguration } from './spec.js';

/** Opérations acceptées. Une seule aujourd'hui : le protocole minimal qui suffit. */
export const OPS = Object.freeze(['acquire']);

/**
 * Construit la requête d'un proxy. `spec` est la ligne de commande du serveur (cf `spec.js`) :
 * c'est le proxy qui la calcule, le daemon ne fait que l'exécuter — il n'a AUCUNE connaissance
 * de `profiles.json`, donc rien à recharger, rien à synchroniser.
 * `instance` (optionnel) = `{identite, strategie, persist, storeDir, instancesDir, plafonds?}` :
 * tout ce que le daemon doit savoir pour matérialiser l'identité, PASSÉ par le proxy (même règle :
 * le daemon ne lit aucune config).
 */
export function requeteAcquire(profile, spec, instance = null, token = null) {
  const m = { op: 'acquire', profile, spec };
  if (instance) m.instance = instance;
  // `token` (05/09/2026) : SEULEMENT sur un canal RÉSEAU (nœud distant). Le tuyau local est
  // protégé par l'OS (même utilisateur) ; un canal TCP ne l'est par rien d'autre que ce jeton.
  if (typeof token === 'string' && token.length > 0) m.token = token;
  return m;
}

export function reponseOk(url, instanceId) {
  return { ok: true, url, instanceId };
}

export function reponseErreur(erreur) {
  return { ok: false, erreur: String(erreur ?? 'erreur inconnue') };
}

// Valide la description d'instance. Rend `{ok:true, instance}` (copie STRICTE, rien en contrebande)
// ou `{ok:false, raison}`. ⚠️ Le daemon COPIE et EFFACE des dossiers à partir de ces données :
// `storeDir`/`instancesDir` non-string ou vides, un nom d'identité hors alphabet (`../x`), et on
// écrirait hors du coffre. Chaque garde nomme SON motif.
function validerInstance(inst) {
  if (!inst || typeof inst !== 'object' || Array.isArray(inst)) return { ok: false, raison: 'instance non-objet' };
  if (!nomIdentiteValide(inst.identite)) return { ok: false, raison: `instance.identite invalide: ${String(inst.identite)}` };
  if (!STRATEGIES.includes(inst.strategie)) return { ok: false, raison: `instance.strategie hors liste: ${String(inst.strategie)}` };
  if (typeof inst.persist !== 'boolean') return { ok: false, raison: 'instance.persist doit être un booléen' };
  if (typeof inst.storeDir !== 'string' || inst.storeDir.length === 0) return { ok: false, raison: 'instance.storeDir absent ou vide' };
  if (typeof inst.instancesDir !== 'string' || inst.instancesDir.length === 0) return { ok: false, raison: 'instance.instancesDir absent ou vide' };
  const plafonds = inst.plafonds && typeof inst.plafonds === 'object' && !Array.isArray(inst.plafonds) ? { ...inst.plafonds } : {};
  return {
    ok: true,
    instance: {
      identite: inst.identite,
      strategie: inst.strategie,
      persist: inst.persist,
      storeDir: inst.storeDir,
      instancesDir: inst.instancesDir,
      plafonds,
    },
  };
}

/**
 * Valide une requête reçue par le DAEMON. Rend `{valide:true, profile, spec, instance}` ou
 * `{valide:false, raison}`. `instance` vaut `null` quand la requête n'en porte pas.
 *
 * ⚠️ Le daemon lance des PROCESSUS à partir de ces données : la validation est une frontière de
 * sécurité, pas une politesse. Un `profile` vide ou non-string, une `spec` sans `command`, et on
 * spawnerait n'importe quoi. Refuser explicitement, toujours.
 */
export function validerRequete(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { valide: false, raison: 'message non-objet' };
  if (!OPS.includes(msg.op)) return { valide: false, raison: `op inconnue: ${String(msg.op)}` };
  if (typeof msg.profile !== 'string' || msg.profile.length === 0) return { valide: false, raison: 'profile absent ou vide' };
  const spec = msg.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { valide: false, raison: 'spec absente' };
  if (typeof spec.command !== 'string' || spec.command.length === 0) return { valide: false, raison: 'spec.command absente' };
  if (!Array.isArray(spec.args)) return { valide: false, raison: 'spec.args doit être un tableau' };
  if (!spec.args.every((a) => typeof a === 'string')) return { valide: false, raison: 'spec.args doit ne contenir que des chaînes' };
  let instance = null;
  if (msg.instance !== undefined && msg.instance !== null) {
    const v = validerInstance(msg.instance);
    if (!v.ok) return { valide: false, raison: v.raison };
    instance = v.instance;
  }
  // `configuration` (fichier --config) : REVALIDEE ici — le daemon ECRIT ce contenu sur disque puis le
  // donne a un processus ; une cle reservee glissee par un client serait un port/hote/dossier detourne.
  let configuration = null;
  if (spec.configuration !== undefined && spec.configuration !== null) {
    const v = verdictConfiguration(spec.configuration);
    if ('raison' in v) return { valide: false, raison: v.raison };
    configuration = v.configuration;
  }
  const token = typeof msg.token === 'string' && msg.token.length > 0 ? msg.token : null;
  return { valide: true, profile: msg.profile, spec: { command: spec.command, args: spec.args, configuration }, instance, token };
}

/**
 * Lit une réponse reçue par le PROXY. Rend `{ok:true, url, instanceId}` ou `{ok:false, erreur}`.
 *
 * ⚠️ Une réponse `ok` SANS url est traitée comme une ERREUR, pas comme un succès vide : le proxy
 * s'en servirait pour construire `http://undefined/...`. Fails-closed.
 * ⚠️ Une réponse `ok` SANS instanceId vient d'un daemon ANCIEN (serveur PARTAGÉ) : REFUSÉE avec
 * le geste à faire — jamais acceptée « pour compatibilité », ce serait rejouer la collision du 03/09.
 */
export function lireReponse(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reponseErreur('réponse non-objet');
  if (msg.ok === true) {
    if (typeof msg.url !== 'string' || msg.url.length === 0) return reponseErreur('réponse ok mais url absente');
    if (typeof msg.instanceId !== 'string' || msg.instanceId.length === 0) {
      return reponseErreur('réponse ok mais instanceId absent : daemon PÉRIMÉ (serveur partagé) — arrêtez l\'ancien daemon, le prochain acquire en relance un neuf');
    }
    return { ok: true, url: msg.url, instanceId: msg.instanceId };
  }
  return reponseErreur(msg.erreur ?? 'réponse sans succès ni motif');
}

/**
 * Lit la limite OPTIONNELLE de navigateurs simultanés (`maxBrowsers` de profiles.json).
 *
 * 🛑 ABSENTE PAR DÉFAUT = AUCUNE LIMITE, et c'est le bon défaut : depuis le refcount du noyau, un
 * navigateur vivant est un navigateur qu'un agent TIENT en ce moment. Leur nombre est donc du
 * travail DEMANDÉ, jamais du gaspillage. Une machine costaude en supporte des centaines ; ce n'est
 * pas à ce code d'en décider à sa place.
 * ⚠️ Fonction TOTALE : toute valeur absurde (0, -1, "beaucoup", null, 2.5) rend `null` = pas de
 * limite. Fails-OPEN ASSUMÉ ici, et c'est délibéré : une limite mal saisie ne doit pas priver
 * l'utilisateur de son navigateur. La limite est un garde-fou qu'on CHOISIT, jamais un défaut subi.
 * @returns {number|null} entier > 0, ou `null` pour « illimité »
 */
export function lireLimite(valeur) {
  // ⚠️ BOOLÉENS REJETÉS EXPLICITEMENT : `Number(true) === 1`, donc un `"maxBrowsers": true` dans
  // profiles.json donnerait une limite de UN SEUL navigateur — l'inverse exact de ce que
  // l'utilisateur voulait dire, et un blocage total dès le 2e profil. Trouvé par le test.
  if (typeof valeur === 'boolean') return null;
  const n = typeof valeur === 'number' ? valeur : Number(valeur);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Reste-t-il de la place pour une INSTANCE supplémentaire ?
 * Depuis le 05/09/2026 chaque client a son instance (un Chrome chacun) : la limite compte des
 * instances vivantes, c'est-à-dire des navigateurs — exactement ce que `maxBrowsers` promet.
 */
export function placeDisponible(nbInstancesActives, limite) {
  return limite === null || nbInstancesActives < limite;
}
