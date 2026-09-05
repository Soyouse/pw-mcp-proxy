// identity-store-pure.js — LA DECISION du coffre d'identites (aucune I/O). Pose le 05/09/2026.
//
// ═══ VOCABULAIRE (fige, cf BACKLOG « PLAN DE CHANTIER SWARM » §1) ═══
//   IDENTITE = durable : un SNAPSHOT du `user-data-dir` d'un navigateur SANS ses caches, range dans
//              le coffre (`identityStore.dir/<nom>/`). C'est l'unite de l'industrie (Browserbase
//              « Contexts », Steel « Profiles » : « a snapshot of the browser's User Data Directory »,
//              « Contexts don't include the browser's HTTP cache »). ⚠️ PAS un fichier de cookies :
//              mesure le 05/09/2026, des cookies seuls MEURENT a 10 min (DBSC : le rafraichissement
//              exige la cle TPM que le dossier porte et que le fichier ne porte pas).
//   INSTANCE = jetable : un dossier NEUF materialise depuis le snapshot, un Chrome, un serveur, UN client.
//
// ═══ POURQUOI CE MODULE EST PUR ═══
// Il decide ce qu'on COPIE (filtre), ce qu'on EFFACE (eviction) et ce qu'on REFUSE (plafond).
// Effacer une identite = perdre un compte connecte : c'est une decision destructive, donc une
// REGLE EXACTE, mutee par Stryker, jamais une heuristique. L'I/O (cpSync/rm) vit dans
// `identity-store.js` et ne fait qu'EXECUTER ce qui est decide ici.

import { normPath } from './prockill-pure.js';
// ⚠️ SOURCE UNIQUE des constantes temporelles : `budget.js` (gate no-inference). Un jour en ms
// sert ICI a convertir `retentionJours` (politique, dans la config) — jamais une attente.
import { JOUR_MS } from './budget.js';

/** Strategies de materialisation — liste FERMEE (une valeur hors liste est REFUSEE par le protocole). */
export const STRATEGIES = Object.freeze([
  'snapshot', // copie filtree du coffre vers un dossier neuf ; N instances possibles ; retour = snapshot
  'inplace',  // le dossier du coffre EST l'instance ; 1 vivante max (SingletonLock de Chrome) ; aucune copie
]);

// Segments EXCLUS du snapshot. Deux familles, toutes deux INFALSIFIABLEMENT « pas de l'etat » :
//   - les caches (regenerables, et c'est la quasi-totalite du poids : vegeta 682 Mo → 267 Mo sans eux) ;
//   - les verrous d'instance de Chrome (un verrou copie = un Chrome qui croit un autre vivant).
// ⚠️ Comparaison EXACTE sur un segment de chemin, jamais un `includes` : « Cache » ne doit pas
// exclure « CacheStorage » ailleurs que sous « Service Worker », et rien qui s'appellerait
// « MonCacheDeMots ». Un exclu de trop = un compte qui se deconnecte en silence.
const SEGMENTS_EXCLUS = Object.freeze(new Set([
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
]));
// Le seul exclu a DEUX segments : `Service Worker/CacheStorage` (le cache des service workers ;
// leur ETAT — `Service Worker/Database` — est conserve).
const PAIRE_EXCLUE = Object.freeze(['Service Worker', 'CacheStorage']);

/**
 * Ce chemin (RELATIF a la racine du profil) doit-il etre EXCLU du snapshot ?
 * Fonction TOTALE et deterministe. Un chemin vide ou non-string n'est pas exclu (on ne juge pas
 * ce qu'on ne voit pas) ; c'est l'appelant qui ne copie que ce qui existe.
 * @param {string} cheminRelatif
 * @returns {boolean}
 */
export function estExclu(cheminRelatif) {
  if (typeof cheminRelatif !== 'string' || cheminRelatif.length === 0) return false;
  const segments = normPath(cheminRelatif).split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    if (SEGMENTS_EXCLUS.has(segments[i])) return true;
    if (segments[i] === PAIRE_EXCLUE[0] && segments[i + 1] === PAIRE_EXCLUE[1]) return true;
  }
  return false;
}

// Un nom d'identite devient un NOM DE DOSSIER (coffre + instances) : alphabet FERME, sinon un nom
// comme `../perso` sortirait du coffre. Refus NOMME cote protocole, jamais une normalisation
// silencieuse (deux noms normalises identiques = deux comptes dans le meme dossier).
const NOM_IDENTITE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Le nom est-il un nom d'identite acceptable ? (chaine, alphabet ferme, 1..64) */
export function nomIdentiteValide(nom) {
  return typeof nom === 'string' && NOM_IDENTITE.test(nom);
}

/**
 * Identifiant d'une instance : `<identite>-<n>`. `n` est un compteur MONO-THREAD du daemon, jamais
 * persiste (un daemon neuf repart a 1 : ses dossiers d'instance sont neufs aussi, le concierge a
 * purge ceux de l'ancien). Injectif pour tout nom valide (le separateur `-` est dans l'alphabet du
 * nom, mais `n` est un entier sans `-` et se lit depuis la FIN : `a-1-2` ⇒ identite `a-1`, n=2).
 * @param {string} identite nom VALIDE (cf nomIdentiteValide)
 * @param {number} n entier >= 1
 */
export function instanceId(identite, n) {
  return `${identite}-${n}`;
}

/**
 * Chemins du coffre et des instances — SOURCE UNIQUE des defauts, consommee par le manager (qui
 * les transmet au daemon) ET par le concierge (qui doit savoir quels dossiers sont les notres).
 * Deux lecteurs de la config avec deux defauts = un concierge qui nettoie a cote ou chez autrui.
 * @param {object} cfg profiles.json (peut etre partiel)
 * @param {{homedir:string, tmpdir:string}} os injecte (jamais lu ici : module PUR)
 * @param {(...p:string[]) => string} join `path.join` injecte
 */
export function cheminsCoffre(cfg, os, join) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const store = c.identityStore && typeof c.identityStore === 'object' ? c.identityStore : {};
  const inst = c.instances && typeof c.instances === 'object' ? c.instances : {};
  return {
    storeDir: typeof store.dir === 'string' && store.dir.length > 0 ? store.dir : join(os.homedir, '.pw-identities'),
    instancesDir: typeof inst.dir === 'string' && inst.dir.length > 0 ? inst.dir : join(os.tmpdir, 'pw-mcp-instances'),
  };
}

const MIB = 1024 * 1024;

/**
 * Lit les plafonds du coffre depuis la config. Fonction TOTALE.
 * 🛑 FAILS-CLOSED SUR LE COFFRE : un plafond ABSENT ou absurde vaut… ce qui est declare ici, jamais
 * « illimite ». « L'espace se declare » : un ecrivain disque sans plafond N'EXISTE PAS. Les valeurs
 * par defaut sont celles de l'industrie (Steel : 300 Mo par profil, 30 jours sans usage ⇒ supprime).
 * @returns {{maxParIdentiteMo:number, maxTotalMo:number, retentionJours:number}}
 */
export function lirePlafonds(cfg) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const entierPositif = (v, defaut) => (Number.isInteger(v) && v > 0 ? v : defaut);
  return {
    maxParIdentiteMo: entierPositif(c.maxParIdentiteMo, 300),
    maxTotalMo: entierPositif(c.maxTotalMo, 6000),
    retentionJours: entierPositif(c.retentionJours, 30),
  };
}

/**
 * Un snapshot de `octets` peut-il entrer dans le coffre ?
 * ⚠️ REFUS, jamais une troncature : un profil tronque est un compte qui se deconnecte a la
 * prochaine lecture, en silence. L'appelant garde l'ANCIEN snapshot intact et crie.
 * @returns {{ok:true}|{ok:false, raison:string}}
 */
export function verdictSnapshot(octets, plafonds) {
  const { maxParIdentiteMo } = lirePlafonds(plafonds);
  if (!Number.isFinite(octets) || octets < 0) return { ok: false, raison: `taille de snapshot invalide: ${String(octets)}` };
  if (octets > maxParIdentiteMo * MIB) {
    return { ok: false, raison: `snapshot de ${Math.round(octets / MIB)} Mo > plafond maxParIdentiteMo=${maxParIdentiteMo} Mo — REFUSE, l'ancien snapshot est conserve` };
  }
  return { ok: true };
}

/**
 * QUOI evincer du coffre ? Fonction TOTALE et deterministe (memes entrees ⇒ meme plan).
 *
 * Regles, dans cet ordre, et rien d'autre :
 *   1. RETENTION : une identite non utilisee depuis plus de `retentionJours` est evincee (motif `retention`).
 *   2. PLAFOND TOTAL : si la somme des SURVIVANTES depasse `maxTotalMo`, on evince par AGE
 *      (la moins recemment utilisee d'abord), jusqu'a repasser sous le plafond (motif `plafond-total`).
 *      ⚠️ Par AGE, jamais par taille ni par « importance » : un critere de taille evincerait
 *      toujours le meme gros compte ; l'age est le seul critere qui ne juge pas.
 *   ⚠️ Une identite qui DEPASSE son plafond individuel n'est PAS evincee (elle est deja dans le
 *      coffre ; c'est `verdictSnapshot` qui refuse d'y ECRIRE). Elle est signalee dans `depassent`.
 *
 * 🛑 FAILS-CLOSED : une entree sans `dernierUsageMs` lisible est traitee comme utilisee A L'INSTANT
 * (`now`) — jamais evincee par retention, derniere candidate au plafond total. Ne pas savoir
 * quand un compte a servi n'est pas une raison de le perdre.
 *
 * @param {Array<{identite:string, octets:number, dernierUsageMs:number}>} entrees
 * @param {object} plafonds cf lirePlafonds
 * @param {number} now horloge INJECTEE (jamais lue ici)
 * @returns {{evincer:Array<{identite:string, motif:'retention'|'plafond-total'}>, depassent:string[]}}
 */
export function planEviction(entrees, plafonds, now) {
  const { maxParIdentiteMo, maxTotalMo, retentionJours } = lirePlafonds(plafonds);
  const horloge = Number.isFinite(now) ? now : 0;
  const lignes = [];
  for (const e of Array.isArray(entrees) ? entrees : []) {
    if (!e || typeof e.identite !== 'string' || e.identite.length === 0) continue;
    const octets = Number.isFinite(e.octets) && e.octets > 0 ? e.octets : 0;
    const usage = Number.isFinite(e.dernierUsageMs) ? e.dernierUsageMs : horloge;
    lignes.push({ identite: e.identite, octets, usage });
  }
  /** @type {Array<{identite:string, motif:'retention'|'plafond-total'}>} */
  const evincer = [];
  /** @type {string[]} */
  const depassent = [];
  const survivantes = [];
  for (const l of lignes) {
    if (l.octets > maxParIdentiteMo * MIB) depassent.push(l.identite);
    if (horloge - l.usage > retentionJours * JOUR_MS) evincer.push({ identite: l.identite, motif: 'retention' });
    else survivantes.push(l);
  }
  // Tri UNIQUE (O(N log N)) puis UN parcours : l'eviction par plafond total ne compare jamais
  // deux entrees entre elles apres ce tri (« la complexite se declare »).
  survivantes.sort((a, b) => a.usage - b.usage || (a.identite < b.identite ? -1 : a.identite > b.identite ? 1 : 0));
  let total = 0;
  for (const l of survivantes) total += l.octets;
  const plafondOctets = maxTotalMo * MIB;
  for (let i = 0; i < survivantes.length && total > plafondOctets; i++) {
    total -= survivantes[i].octets;
    evincer.push({ identite: survivantes[i].identite, motif: 'plafond-total' });
  }
  return { evincer, depassent };
}
