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
//   proxy → daemon   { op: 'acquire', profile, spec }   UNE fois, à l'ouverture
//   daemon → proxy   { ok: true,  url }                 le serveur est PRÊT (fait, pas promesse)
//   daemon → proxy   { ok: false, erreur }              échec NOMMÉ (jamais un silence)
//   fermeture socket                                    = « je n'utilise plus ce profil »
//
// Fonctions TOTALES : elles ne throw JAMAIS. Un message malformé rend un refus explicite, jamais
// une exception — le daemon sert N clients, l'un d'eux ne doit pas pouvoir le faire tomber.

/** Opérations acceptées. Une seule aujourd'hui : le protocole minimal qui suffit. */
export const OPS = Object.freeze(['acquire']);

/**
 * Construit la requête d'un proxy. `spec` est la ligne de commande du serveur (cf `spec.js`) :
 * c'est le proxy qui la calcule, le daemon ne fait que l'exécuter — il n'a AUCUNE connaissance
 * de `profiles.json`, donc rien à recharger, rien à synchroniser.
 */
export function requeteAcquire(profile, spec) {
  return { op: 'acquire', profile, spec };
}

export function reponseOk(url) {
  return { ok: true, url };
}

export function reponseErreur(erreur) {
  return { ok: false, erreur: String(erreur ?? 'erreur inconnue') };
}

/**
 * Valide une requête reçue par le DAEMON. Rend `{valide:true, profile, spec}` ou
 * `{valide:false, raison}`.
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
  return { valide: true, profile: msg.profile, spec: { command: spec.command, args: spec.args } };
}

/**
 * Lit une réponse reçue par le PROXY. Rend `{ok:true, url}` ou `{ok:false, erreur}`.
 *
 * ⚠️ Une réponse `ok` SANS url est traitée comme une ERREUR, pas comme un succès vide : le proxy
 * s'en servirait pour construire `http://undefined/...`. Fails-closed.
 */
export function lireReponse(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reponseErreur('réponse non-objet');
  if (msg.ok === true) {
    if (typeof msg.url !== 'string' || msg.url.length === 0) return reponseErreur('réponse ok mais url absente');
    return { ok: true, url: msg.url };
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
 * Reste-t-il de la place pour un profil SUPPLÉMENTAIRE ?
 * ⚠️ Ne concerne QUE la création d'un nouveau profil : rejoindre un profil déjà servi est toujours
 * autorisé (c'est du PARTAGE, ça ne coûte aucun navigateur de plus).
 */
export function placeDisponible(nbProfilsActifs, limite) {
  return limite === null || nbProfilsActifs < limite;
}
