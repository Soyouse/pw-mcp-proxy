// handshake-cache-pure.js — LA DECISION du souvenir de handshake. PUR => testable + mutable.
//
// 🛑 POURQUOI CE SOUVENIR EXISTE (17/10/2026). Le handshake MCP (`initialize` + `tools/list`) arrive
// a l'OUVERTURE de chaque session, pour CHAQUE entree `browser*`. Le servir en direct exigeait un
// backend vivant : un @playwright/mcp (+ npx + gardien) allume par entree et par session, qu'on s'en
// serve ou non. Mesure du 17/10/2026 : 4 sessions x 6 entrees => 20 serveurs Playwright tenus, ~6,5 Go
// de memoire privee, pour 11 Chrome reellement ouverts.
// ⇒ Le proxy rend la reponse que le backend a DEJA donnee pour la MEME commande (meme paquet epingle,
// memes args, meme fichier --config, meme version de protocole), et n'allume le backend qu'au premier
// VRAI appel. Le PASSTHROUGH reste entier : le souvenir est la sortie du backend, mot pour mot, jamais
// une liste ecrite a la main.
//
// ⚠️ LE SOUVENIR NE FAIT JAMAIS FOI SEUL : au premier allumage reel, le routeur relit la liste VIVANTE,
// la compare a celle qu'il a servie et, si elle differe, reecrit le souvenir ET emet
// `tools/list_changed` (le client re-tire la liste). Un souvenir faux se corrige donc seul, au premier
// usage, sans humain.
//
// ⚠️ CLE = TOUT ce qui peut changer la reponse du backend, rien d'autre. Ne JAMAIS y ajouter le nom du
// profil : des profils qui partagent la meme commande partagent la meme reponse (une entree, pas N).
// Ne JAMAIS en retirer `protocolVersion` : la reponse a `initialize` depend de la version demandee.
//
// ⚠️ L'ESPACE SE DECLARE : au plus `max` entrees (defaut MAX_ENTREES_DEFAUT), eviction de la plus
// ANCIENNEMENT ecrite. Une entree ≈ la liste d'outils de @playwright/mcp (quelques dizaines de Ko) ⇒
// le fichier est borne a ~1 Mo a vie, quel que soit le nombre de sessions.

/** Plafond d'entrees du souvenir (une par commande backend distincte). */
export const MAX_ENTREES_DEFAUT = 16;
/** Version du format du fichier : un format inconnu est IGNORE (lu comme vide), jamais interprete. */
export const VERSION_FORMAT = 1;

/**
 * Cle du souvenir. Fonction TOTALE.
 * @param {{command?:unknown, args?:unknown, configuration?:unknown}|null|undefined} spec
 * @param {unknown} protocolVersion
 * @returns {string}
 */
export function cleHandshake(spec, protocolVersion) {
  const s = spec || {};
  return JSON.stringify([s.command ?? null, s.args ?? null, s.configuration ?? null, protocolVersion ?? null]);
}

/**
 * Entrees valides d'un document lu sur disque. Tout ce qui n'a pas la forme attendue est ECARTE
 * (fichier tronque, ecrit par une autre version, edite a la main) : un souvenir douteux = pas de
 * souvenir, donc le chemin vivant d'avant — jamais une reponse inventee.
 * @param {unknown} doc
 * @returns {Array<{cle:string, init?:object, tools?:object[]}>}
 */
export function entreesValides(doc) {
  const d = /** @type {{version?:unknown, entrees?:unknown}} */ (doc);
  // `!d` suffit devant `d.version` : une valeur primitive n'a pas de `version` (=> refus ci-dessous).
  if (!d || d.version !== VERSION_FORMAT || !Array.isArray(d.entrees)) return [];
  return d.entrees.filter(
    (e) =>
      !!e &&
      typeof e.cle === 'string' &&
      (e.init === undefined || (!!e.init && typeof e.init === 'object' && !Array.isArray(e.init))) &&
      (e.tools === undefined || Array.isArray(e.tools))
  );
}

/**
 * Souvenir d'une cle, ou `null`.
 * @param {unknown} doc
 * @param {string} cle
 * @returns {{cle:string, init?:object, tools?:object[]}|null}
 */
export function lireEntree(doc, cle) {
  return entreesValides(doc).find((e) => e.cle === cle) || null;
}

/**
 * Nouveau document apres ecriture de `patch` sous `cle` (fusion avec l'existant), l'entree passant en
 * DERNIERE position (la plus recente) ; au-dela de `max`, les plus anciennes sont evincees.
 * @param {unknown} doc
 * @param {string} cle
 * @param {{init?:object, tools?:object[]}} patch
 * @param {number} [max]
 * @returns {{version:number, entrees:Array<{cle:string, init?:object, tools?:object[]}>}}
 */
export function ecrireEntree(doc, cle, patch, max = MAX_ENTREES_DEFAUT) {
  const borne = Number.isInteger(max) && max > 0 ? max : MAX_ENTREES_DEFAUT;
  const entrees = entreesValides(doc);
  const ancienne = entrees.find((e) => e.cle === cle);
  const autres = entrees.filter((e) => e.cle !== cle);
  const nouvelle = { ...(ancienne || {}), ...patch, cle };
  return { version: VERSION_FORMAT, entrees: [...autres, nouvelle].slice(-borne) };
}

/**
 * Deux listes d'outils sont-elles IDENTIQUES (ordre compris : c'est la reponse telle que servie) ?
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function memesOutils(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
