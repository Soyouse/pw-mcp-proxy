// handshake-cache.js — I/O du souvenir de handshake. EXECUTE la decision de handshake-cache-pure.js.
//
// ⚠️ ECRIVAIN DISQUE DECLARE : UN fichier (`PW_MCP_HANDSHAKE_CACHE` || <racine>/handshake-cache.json),
// borne par le plafond d'entrees de la decision pure (~1 Mo a vie), eviction a l'ecriture. Rien
// d'autre n'est ecrit (le temporaire est renomme ou supprime dans le meme geste).
//
// ⚠️ N PROXIES LISENT ET ECRIVENT LE MEME FICHIER (un par entree MCP et par session) : l'ecriture est
// ATOMIQUE (temporaire propre au pid, puis `rename`) — un lecteur voit l'ancien OU le nouveau, jamais
// un fichier a moitie ecrit. Deux ecrivains simultanes : le dernier gagne, et c'est sans danger, la
// valeur d'une cle est la meme pour tous (meme commande => meme reponse).
//
// 🛑 BEST-EFFORT STRICT, JAMAIS BLOQUANT : une lecture ratee rend `null` (=> le chemin vivant d'avant,
// backend allume), une ecriture ratee se loggue. Le souvenir accelere ; il ne doit JAMAIS devenir une
// panne. Ne JAMAIS throw d'ici.

import fs from 'node:fs';
import process from 'node:process';
import { log } from './logger.js';
import { describeError } from './error-detail.js';
import { lireEntree, ecrireEntree, cleHandshake, memesOutils, MAX_ENTREES_DEFAUT } from './handshake-cache-pure.js';

/**
 * Le souvenir tel que le ROUTEUR s'en sert. Contrat attendu du manager : `demarre()`, `specActive()`,
 * `clientInfo.protocolVersion` (cf manager.js — `specActive` passe par `_spec`, source unique).
 * 🛑 Il ne sert QUE si aucun backend du profil actif n'existe : un backend vivant prime TOUJOURS.
 */
export class SouvenirHandshake {
  /**
   * @param {{lire:(cle:string)=>({init?:object, tools?:object[]}|null), completer:(cle:string, patch:object)=>void}} cache
   * @param {{demarre:()=>boolean, specActive:()=>object, clientInfo?:{protocolVersion?:string}}} manager
   */
  constructor(cache, manager) {
    this._cache = cache;
    this._manager = manager;
    /** @type {object[]|null} liste servie DE MEMOIRE, a confronter au vivant au premier allumage */
    this._servis = null;
    this._verifies = new WeakSet();
  }

  _cle() {
    return cleHandshake(this._manager.specActive(), this._manager.clientInfo?.protocolVersion);
  }

  /** Vrai tant qu'aucun backend du profil actif n'existe (le souvenir peut servir). */
  froid() {
    return !this._manager.demarre();
  }

  /** @returns {object|null} l'initResult memorise, si servable */
  init() {
    return this.froid() ? this._cache.lire(this._cle())?.init || null : null;
  }

  /** @returns {object[]|null} COPIE de la liste memorisee, si servable (retenue pour la confrontation) */
  outils() {
    const t = this.froid() ? this._cache.lire(this._cle())?.tools : null;
    if (!t) return null;
    this._servis = t;
    return structuredClone(t);
  }

  /** Inscrit ce que le backend VIVANT du profil actif vient de repondre. */
  memoriser(patch) {
    this._cache.completer(this._cle(), patch);
  }

  /**
   * 🛑 LE SOUVENIR NE FAIT JAMAIS FOI SEUL. Au premier allumage reel apres une liste servie de
   * memoire : relire la liste VIVANTE, la memoriser, et si elle differe appeler `perime` (le routeur
   * emet `tools/list_changed` ; le client re-tire la liste, vivante cette fois). Sans cette
   * confrontation, un paquet mis a jour servirait une liste perimee POUR TOUJOURS.
   * Ne throw jamais (appel non attendu par le routeur).
   * @param {object} backend
   * @param {()=>Promise<object[]>} collecter
   * @param {()=>void} perime
   */
  async confronter(backend, collecter, perime) {
    if (!this._servis || this._verifies.has(backend)) return;
    this._verifies.add(backend);
    const servis = this._servis;
    this._servis = null;
    try {
      const vivants = await collecter();
      this.memoriser({ init: /** @type {{initResult?:object}} */ (backend).initResult, tools: vivants });
      if (!memesOutils(vivants, servis)) {
        log('[souvenir] liste vivante DIFFERENTE de la liste servie => souvenir reecrit + tools/list_changed');
        perime();
      }
    } catch (e) {
      log('[souvenir] confrontation au vivant : ' + describeError(e));
    }
  }
}

/**
 * @param {string} fichier
 * @param {{max?:number}} [opts]
 * @returns {{lire:(cle:string)=>({init?:object, tools?:object[]}|null), completer:(cle:string, patch:{init?:object, tools?:object[]})=>void}}
 */
export function ouvrirCache(fichier, opts = {}) {
  const max = opts.max ?? MAX_ENTREES_DEFAUT;

  /** @returns {unknown} le document sur disque, `null` s'il est absent ou illisible */
  function lireDoc() {
    try {
      return JSON.parse(fs.readFileSync(fichier, 'utf8'));
    } catch (e) {
      // Absent = cas NORMAL (premier usage) : pas une panne, rien a dire.
      if (/** @type {{code?:string}} */ (e)?.code !== 'ENOENT') log(`[souvenir] lecture ${fichier} : ${describeError(e)} (ignore, chemin vivant)`);
      return null;
    }
  }

  return {
    lire(cle) {
      return lireEntree(lireDoc(), cle);
    },
    completer(cle, patch) {
      const avant = lireDoc();
      const apres = ecrireEntree(avant, cle, patch, max);
      const texte = JSON.stringify(apres);
      // Rien de neuf => aucune ecriture (le chemin vivant appelle ceci a chaque tools/list).
      if (avant && JSON.stringify(avant) === texte) return;
      const tmp = `${fichier}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, texte);
        fs.renameSync(tmp, fichier);
      } catch (e) {
        log(`[souvenir] ecriture ${fichier} : ${describeError(e)} (ignore, le prochain handshake allumera le backend)`);
        try { fs.rmSync(tmp, { force: true }); } catch { /* SILENCE: nettoyage best-effort d'un temporaire deja signale ci-dessus */ }
      }
    },
  };
}
