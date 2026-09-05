// identity-store.js — I/O du coffre d'identités. EXÉCUTE ce que `identity-store-pure.js` DÉCIDE.
//
// ⚠️ Ce fichier ne décide RIEN : estExclu/nomIdentiteValide/verdictSnapshot/planEviction viennent
// du module pur, mutation-testé. Ici : cpSync, statSync, renameSync, rmSync — l'exécution.
//
// 🛑 DEFENSE-IN-DEPTH SUR LES NOMS : le protocole (daemon-protocol.js) valide déjà `identite` et
// `instanceId` en amont, mais CE module écrit sur disque à partir de ces chaînes — un appelant
// futur (test, script, 2e implémentation du contrat) pourrait sauter cette validation. Un nom
// invalide (`../x`) transformé en chemin sortirait du coffre : on revalide ICI, à la frontière I/O.
//
// ⚠️ ZÉRO appel temporel (pas de setTimeout/setInterval) : toute opération est LOCALE (disque),
// le noyau répond en FAIT (succès/erreur), jamais en délai. `Date.now()` est autorisé UNE fois
// (horodatage de DONNÉE dans le fichier `.pw-mcp-identite.json`, pas une attente).

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { describeError } from './error-detail.js';
import { estExclu, nomIdentiteValide, verdictSnapshot, tenantsDuDossier } from './identity-store-pure.js';
import { listProcesses, isPidAlive } from './prockill.js';
// ⚠️ SOURCE UNIQUE des delais (budget.js) — cf `attendreLibre`, le SEUL appel temporel de ce fichier.
import { LIBERATION_BUDGET_MS, LIBERATION_POLL_MS } from './budget.js';

const META_FILE = '.pw-mcp-identite.json';

/**
 * Refus NOMMÉ si `nom` n'est pas un nom d'identité/instance valide. Defense-in-depth : ce module
 * écrit sur disque, il ne fait JAMAIS confiance à un appelant pour avoir déjà validé.
 * @param {string} nom
 * @param {string} label pour le message d'erreur (« identité » ou « instance »)
 */
function exigerNomValide(nom, label) {
  if (!nomIdentiteValide(nom)) {
    throw new Error(`identity-store: ${label} invalide, REFUSÉ (jamais normalisé en silence) : ${JSON.stringify(nom)}`);
  }
}

/**
 * Taille RÉELLE d'un dossier, par parcours + `statSync` — JAMAIS un compteur en mémoire (même
 * raison que `logger.js` : c'est le filesystem qui porte la vérité, pas ce process).
 * Fonction TOTALE côté erreurs de parcours : un fichier disparu entre `readdirSync` et `statSync`
 * (course avec une autre écriture) ne fait pas planter la mesure, il compte pour 0.
 * @param {string} dir
 * @returns {number} octets
 */
function tailleReelle(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // dossier absent ou disparu entre-temps : rien à mesurer, pas une erreur
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += tailleReelle(p);
    } else {
      try {
        total += fs.statSync(p).size;
      } catch { /* SILENCE: fichier disparu entre readdirSync et statSync (course bénigne) — la mesure continue sans lui */ }
    }
  }
  return total;
}

/**
 * Copie filtrée récursive : tout SAUF ce que `estExclu` rejette (caches + verrous Chrome).
 * `fs.cpSync` avec `filter` reçoit des chemins ABSOLUS ; on les relativise à `racine` pour
 * interroger la décision pure sur un chemin de segments, comme ses tests l'attendent.
 * @param {string} depuis dossier source (doit exister)
 * @param {string} vers dossier destination (créé par cpSync)
 */
function copierFiltre(depuis, vers) {
  const racine = depuis;
  fs.cpSync(depuis, vers, {
    recursive: true,
    filter: (src) => !estExclu(path.relative(racine, src)),
  });
}

/**
 * Matérialise une INSTANCE jetable à partir d'une IDENTITÉ durable du coffre.
 *
 * `snapshot` : copie filtrée du coffre vers l'instance (identité absente du coffre ⇒ dossier
 * d'instance VIDE — Chrome créera un profil neuf, l'identité NAÎT à la prochaine `snapshotRetour`).
 * `inplace` : le dossier du coffre EST l'instance, rendu TEL QUEL (aucune copie) ; créé s'il manque.
 *
 * 🛑 REFUS NOMMÉ si le dossier d'instance existe déjà : on n'écrase JAMAIS une instance vivante
 * (ce serait mélanger deux clients sur un seul `user-data-dir`, contrat rompu ailleurs dans le
 * projet). C'est un throw, pas une réutilisation silencieuse.
 *
 * @param {{identite:string, strategie:'snapshot'|'inplace', storeDir:string, instancesDir:string, instanceId:string}} params
 * @returns {Promise<string>} chemin du dossier à passer en `--user-data-dir`
 */
export async function materialiser({ identite, strategie, storeDir, instancesDir, instanceId }) {
  exigerNomValide(identite, 'identité');
  const identiteDir = path.join(path.resolve(storeDir), identite);

  if (strategie === 'inplace') {
    fs.mkdirSync(identiteDir, { recursive: true });
    log(`identity-store: inplace — instance = coffre directement : ${identiteDir}`);
    return identiteDir;
  }

  // strategie === 'snapshot' (seule autre valeur de la liste FERMÉE, validée en amont par le
  // protocole ; un appelant qui passerait autre chose tombe dans ce chemin par défaut plutôt que
  // de planter — mais REFUSE explicitement pour ne jamais matérialiser sur une hypothèse fausse).
  if (strategie !== 'snapshot') {
    throw new Error(`identity-store: stratégie inconnue, REFUSÉ : ${JSON.stringify(strategie)}`);
  }
  exigerNomValide(instanceId, 'instance');
  const instanceDir = path.join(path.resolve(instancesDir), instanceId);
  if (fs.existsSync(instanceDir)) {
    throw new Error(`identity-store: dossier d'instance existe déjà, JAMAIS écrasé : ${instanceDir}`);
  }
  fs.mkdirSync(path.dirname(instanceDir), { recursive: true });

  if (!fs.existsSync(identiteDir)) {
    // Identité qui NAÎT : pas de snapshot à copier, dossier neuf vide.
    fs.mkdirSync(instanceDir, { recursive: true });
    log(`identity-store: identité "${identite}" absente du coffre — instance vierge créée : ${instanceDir}`);
    return instanceDir;
  }

  copierFiltre(identiteDir, instanceDir);
  log(`identity-store: snapshot "${identite}" matérialisé → ${instanceDir}`);
  return instanceDir;
}

/**
 * Rend le snapshot d'une instance AU coffre, ATOMIQUEMENT.
 *
 * ⚠️ ATOMICITÉ PAR RENAME, JAMAIS D'ÉCRITURE EN PLACE : on copie vers `<identite>.tmp-<pid>`,
 * on MESURE la taille RÉELLE de cette copie (jamais un compteur), on demande le VERDICT à la
 * décision pure, puis :
 *   - refus (plafond dépassé) ⇒ le `.tmp` est supprimé, l'ANCIEN snapshot reste INTACT, on rend
 *     le refus NOMMÉ (jamais une troncature silencieuse) ;
 *   - accepté ⇒ si un ancien snapshot existe, il est renommé en `.old-<pid>` (jamais écrasé
 *     directement — Windows `renameSync` échoue si la cible existe), le `.tmp` prend la place de
 *     `<identite>`, puis le `.old` est supprimé.
 * Un crash ENTRE deux renames laisse soit l'ANCIEN (rename du tmp pas encore fait), soit le
 * NOUVEAU (rename du tmp fait, suppression du .old pas encore faite) — jamais un état intermédiaire
 * illisible : à aucun moment `<identite>` n'a pointé vers un dossier partiellement écrit.
 *
 * @param {{identite:string, storeDir:string, instanceDir:string, plafonds:object}} params
 * @returns {Promise<{ok:true, octets:number}|{ok:false, raison:string}>}
 */
export async function snapshotRetour({ identite, storeDir, instanceDir, plafonds }) {
  exigerNomValide(identite, 'identité');
  const racine = path.resolve(storeDir);
  fs.mkdirSync(racine, { recursive: true });
  const identiteDir = path.join(racine, identite);
  const tmpDir = path.join(racine, `${identite}.tmp-${process.pid}`);
  const oldDir = path.join(racine, `${identite}.old-${process.pid}`);

  // Le `.tmp` d'un run précédent qui a crashé avant nettoyage ne doit jamais fausser la mesure.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  copierFiltre(instanceDir, tmpDir);

  const octets = tailleReelle(tmpDir);
  const verdict = verdictSnapshot(octets, plafonds);
  if ('raison' in verdict) { // = refus (le succès n'a pas de motif) — narrowing par `in`, lisible par tsc
    fs.rmSync(tmpDir, { recursive: true, force: true }); // REFUS : rien ne touche l'ancien snapshot
    log(`identity-store: snapshotRetour "${identite}" REFUSÉ — ${verdict.raison}`);
    return { ok: false, raison: verdict.raison };
  }

  if (fs.existsSync(identiteDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true }); // .old d'un crash précédent : purge avant usage
    fs.renameSync(identiteDir, oldDir);
  }
  fs.renameSync(tmpDir, identiteDir);
  fs.rmSync(oldDir, { recursive: true, force: true });

  try {
    fs.writeFileSync(
      path.join(identiteDir, META_FILE),
      JSON.stringify({ dernierUsageMs: Date.now(), octets }),
    );
  } catch (e) {
    // SILENCE: métadonnée best-effort — son absence dégrade `mesurer()` (fails-closed, cf pure)
    // mais le snapshot lui-même est déjà atomiquement en place ; on ne le fait pas échouer pour ça.
    log(`identity-store: écriture ${META_FILE} échouée pour "${identite}" — ${describeError(e)}`);
  }

  log(`identity-store: snapshotRetour "${identite}" OK — ${octets} octets`);
  return { ok: true, octets };
}

/**
 * Attend que le dossier d'une instance soit LIBRE (plus aucun process ne le tient) et rend son
 * NOUVEAU chemin (`<dir>.fini`), ou `null` si le budget est épuisé (crié par l'appelant, rien touché).
 *
 * 🛑 POURQUOI UN DÉLAI ICI, ET POURQUOI IL EST RECEVABLE (motif `distant`, budget no-inference) :
 * l'`exit` que reçoit le daemon est celui du GARDIEN, son enfant. Chrome est un PETIT-ENFANT : sa
 * mort ne nous est délivrée par AUCUN événement (doc Node : les petits-enfants ne sont ni tués ni
 * notifiés avec leur parent). Aucune autorité n'ÉMET ce fait ⇒ on l'INTERROGE : le noyau répond
 * exactement, PID par PID (`kill(pid, 0)`), pour chaque process dont la ligne de commande nomme ce
 * dossier (`tenantsDuDossier`, PUR). Tant qu'un tenant vit, on ne touche à rien.
 * 🔴 MESURÉ sur Linux le 05/09/2026 (nightly rouge, reproduit sur le VPS) : Playwright lance Chrome
 * dans SON PROPRE groupe ⇒ le SIGKILL du groupe du gardien ne l'atteint pas ; il survit ~0,5 s, se
 * ferme proprement et RÉÉCRIT dans son `--user-data-dir` ⇒ un rename immédiat (POSIX ne verrouille
 * pas) rangeait un snapshot AVANT le dernier flush et laissait un dossier d'instance FANTÔME recréé
 * après le rm. Windows masquait le défaut : ses verrous faisaient échouer le rename jusqu'à la mort
 * effective de Chrome. Le rename reste le 2e fait (verrous Windows) ET ce qui garantit qu'aucun
 * nouveau process ne retrouvera ce dossier sous son nom d'instance pendant qu'on le range.
 * ⚠️ UN SEUL appel temporel (la pause), UNE SEULE comparaison de budget : cliquet no-inference.
 * @param {string} instanceDir
 * @param {{budgetMs?:number, pasMs?:number, enumerer?:()=>Array<{pid:number,cmd:string}>, vivant?:(pid:number)=>boolean, selfPid?:number}} [opts]
 * @returns {Promise<string|null>} le chemin RENDU (`<dir>.fini`), ou `null` si le dossier reste tenu
 */
export async function attendreLibre(instanceDir, { budgetMs = LIBERATION_BUDGET_MS, pasMs = LIBERATION_POLL_MS, enumerer = listProcesses, vivant = isPidAlive, selfPid = process.pid } = {}) {
  const cible = `${instanceDir}.fini`;
  // Énumération UNE fois (spawn bloquant) : les tenants sont ceux qui existaient au moment du kill ;
  // ensuite on n'interroge plus que le noyau sur ces PID (bon marché, exact).
  const tenants = tenantsDuDossier(enumerer(), instanceDir, selfPid);
  const t0 = Date.now();
  for (;;) {
    const encore = tenants.filter((pid) => vivant(pid));
    /** @type {unknown} */
    let erreur = null;
    if (encore.length === 0) {
      try {
        fs.renameSync(instanceDir, cible);
        return cible;
      } catch (e) {
        // ENOENT = deja disparu (rien a ranger) : on rend la cible absente, l'appelant verra un dossier vide.
        if (/** @type {{code?:string}} */ (e)?.code === 'ENOENT') { try { fs.mkdirSync(cible, { recursive: true }); } catch { /* SILENCE: la cible existe deja (course benigne avec un rangement precedent) — un dossier present est exactement ce qu'on voulait */ } return cible; }
        erreur = e;
      }
    }
    if (Date.now() - t0 > budgetMs) {
      log(`identity-store: ${instanceDir} toujours tenu après ${budgetMs} ms — ${encore.length ? `process vivants : ${encore.join(', ')}` : describeError(erreur)}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, pasMs));
  }
}

/**
 * Ecrit le fichier `--config` d'une instance (contenu = `playwrightConfig` du profil, deja valide).
 * A COTE du dossier d'instance (`<dir>.config.json`), jamais DEDANS : le dedans est le profil Chrome
 * (il serait copie dans le snapshot). Ecrivain disque declare : un petit fichier par instance, supprime
 * avec elle (`supprimerConfigInstance`), et purge par le concierge s'il est orphelin.
 * @param {string} chemin
 * @param {object} configuration
 */
export function ecrireConfigInstance(chemin, configuration) {
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, JSON.stringify(configuration, null, 2));
  return chemin;
}

/** Supprime le fichier de config d'une instance. Idempotent, ne throw jamais (fin de vie). */
export function supprimerConfigInstance(chemin) {
  if (!chemin) return;
  try { fs.rmSync(chemin, { force: true }); }
  catch (e) { log(`identity-store: suppression config instance échouée — ${chemin} — ${describeError(e)}`); }
}

/**
 * Supprime un dossier d'instance. Idempotent (dossier déjà absent = succès silencieux), ne
 * throw JAMAIS : c'est un nettoyage de fin de vie, une panne ici ne doit pas empêcher le reste
 * du cycle de vie (le daemon a d'autres choses à finir).
 * @param {string} instanceDir
 */
export function supprimerInstance(instanceDir) {
  try {
    fs.rmSync(instanceDir, { recursive: true, force: true });
  } catch (e) {
    log(`identity-store: suppression instance échouée — ${instanceDir} — ${describeError(e)}`);
  }
}

/**
 * Une entrée par sous-dossier du coffre — ignore les résidus transitoires (`.tmp-*`/`.old-*`)
 * d'un `snapshotRetour` interrompu : ce ne sont pas des identités, ce sont des artefacts
 * atomiques en cours ou orphelins d'un crash.
 * @param {string} storeDir
 * @returns {Array<{identite:string, octets:number, dernierUsageMs:number|undefined}>}
 */
export function mesurer(storeDir) {
  const racine = path.resolve(storeDir);
  let entries;
  try {
    entries = fs.readdirSync(racine, { withFileTypes: true });
  } catch {
    return []; // coffre absent = zéro identité, pas une erreur
  }
  const resultat = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Regex et non `String.includes` DANS la boucle : le gate de complexité (AST) ne distingue pas
    // `includes` d'une chaîne de celui d'un tableau — il verrait un O(N²) qui n'existe pas.
    if (/\.(tmp|old)-\d+$/.test(entry.name)) continue;
    const dir = path.join(racine, entry.name);
    let dernierUsageMs;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
      if (Number.isFinite(meta.dernierUsageMs)) dernierUsageMs = meta.dernierUsageMs;
    } catch { /* SILENCE: métadonnée absente ou illisible — la décision pure traite ça fails-closed (utilisé à l'instant) */ }
    resultat.push({ identite: entry.name, octets: tailleReelle(dir), dernierUsageMs });
  }
  return resultat;
}

/**
 * Applique un plan d'éviction (produit par `planEviction`, décision pure) : supprime chaque
 * dossier listé, log motif à motif. Rend la liste des identités EFFECTIVEMENT supprimées (une
 * suppression qui échoue n'apparaît pas dedans — le caller sait ce qui reste réellement).
 * @param {string} storeDir
 * @param {{evincer:Array<{identite:string, motif:string}>}} plan
 * @returns {string[]} identités effectivement supprimées
 */
export function evincer(storeDir, plan) {
  const racine = path.resolve(storeDir);
  const supprimees = [];
  for (const { identite, motif } of Array.isArray(plan?.evincer) ? plan.evincer : []) {
    if (!nomIdentiteValide(identite)) {
      log(`identity-store: évinction refusée — nom invalide ${JSON.stringify(identite)}`);
      continue;
    }
    const dir = path.join(racine, identite);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`identity-store: identité "${identite}" ÉVINCÉE — motif=${motif}`);
      supprimees.push(identite);
    } catch (e) {
      log(`identity-store: évinction "${identite}" échouée — ${describeError(e)}`);
    }
  }
  return supprimees;
}
