// I/O — SURVEILLANCE de `profiles.json` : l'OS RÉVEILLE, le CONTENU DÉCIDE (posé 05/09/2026).
//
// AVANT : `fs.watchFile` = un `stat` par seconde À VIE, dans CHAQUE proxy, pour un fichier qui change
// deux fois par mois — et la doc Node précise qu'il tire « each time the file is accessed » (un
// antivirus qui LIT déclenchait une réconciliation pour rien). À cent agents : cent réveils/seconde.
// APRÈS : `fs.watch` = événement du noyau (inotify · kqueue · ReadDirectoryChangesW), zéro réveil au repos.
//
// 🛑 POSÉ SUR LE DOSSIER PARENT, JAMAIS SUR LE FICHIER. Doc Node v22 (Caveats/Inodes) : « On Linux and
//    macOS, fs.watch() resolves the path to an inode and watches the inode. If the watched path is
//    deleted and recreated, it is assigned a new inode. […] Events for the new inode will not be
//    emitted. » Tout éditeur qui sauve par renommage atomique (VS Code, vim, sed -i) recrée l'inode :
//    une surveillance posée sur le FICHIER se tait pour toujours, en silence. Le dossier, lui, reste.
// 🛑 REPLI AU SONDAGE, CRIÉ : doc Node — « watching files or directories can be unreliable, and in some
//    cases impossible, on network file systems (NFS, SMB, etc.), so it is strongly recommended to use
//    fs.watchFile() as a more reliable alternative ». `fs.watch` peut THROW à la création ou émettre
//    `error` plus tard ⇒ dans les deux cas on bascule sur `fs.watchFile` et on le dit dans le log.
// ⚠️ UN SEUL DÉLAI ICI, déclaré au gate (`no-inference-gate`, motif `distant`) : le rejeu de LECTURE
//    quand un antivirus tient le fichier (EBUSY/EPERM sous Windows). Personne ne peut interroger
//    l'antivirus ; le calendrier vit dans budget.js, borné, et l'épuisement ALERTE.
// ⚠️ `persistent: false` partout : la surveillance ne maintient JAMAIS le process en vie (le proxy vit
//    par son stdio, le daemon par ses sockets — pas par un watcher oublié).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_WATCH_INTERVAL_MS, CONFIG_READ_RETRY_SCHEDULE_MS } from './budget.js';
import { concerne, verdictLecture, verdictErreurLecture } from './config-watch-pure.js';
import { describeError } from './error-detail.js';

/**
 * @param {string} chemin fichier à surveiller
 * @param {{
 *   hashInitial: string|null,
 *   onContenu: (texte:string)=>void,   // applique la config ; THROW = contenu refusé (hash NON avancé)
 *   log: (msg:string)=>void,
 *   alerter: (msg:string)=>void,
 *   parse?: (texte:string)=>unknown,
 *   fsImpl?: typeof fs,
 *   delai?: (ms:number)=>Promise<void>,
 * }} opts
 * @returns {{ fermer: () => void, verifier: () => Promise<void>, mode: () => 'evenement'|'sondage' }}
 */
export function surveillerConfig(chemin, opts) {
  const { hashInitial, onContenu, log, alerter } = opts;
  const parse = opts.parse || JSON.parse;
  const fsImpl = opts.fsImpl || fs;
  // ⚠️ Le SEUL appel temporel du module (déclaré). Injectable pour les tests (zéro attente réelle).
  const delai = opts.delai || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const dossier = path.dirname(chemin);
  const nom = path.basename(chemin);
  let hashCharge = hashInitial;
  let ferme = false;
  let enCours = false;
  let relance = false;
  /** @type {import('node:fs').FSWatcher|null} */
  let watcher = null;
  let sondage = false;

  async function lireAvecRejeu() {
    for (let essai = 0; ; essai++) {
      try {
        return await fsImpl.promises.readFile(chemin);
      } catch (e) {
        const v = verdictErreurLecture(/** @type {{code?:string}} */ (e)?.code, essai, CONFIG_READ_RETRY_SCHEDULE_MS);
        if (v.action === 'rejouer') { log(`config: lecture tenue par un autre process (${describeError(e)}) — rejeu dans ${v.pauseMs} ms`); await delai(v.pauseMs); continue; }
        if (v.action === 'abandon') { alerter(`config: ${chemin} illisible après ${essai + 1} essais (${describeError(e)}) — changement PEUT-ÊTRE PERDU, relancer une sauvegarde`); return null; }
        log(`config: lecture impossible (${describeError(e)}) — ancienne config conservée`);
        return null;
      }
    }
  }

  // Coalescence : N réveils pendant une vérification = UNE vérification de plus, jamais N en parallèle
  // (deux lectures concurrentes pourraient appliquer une config PLUS ANCIENNE après la plus récente).
  async function verifier() {
    if (ferme) return;
    if (enCours) { relance = true; return; }
    enCours = true;
    try {
      do {
        relance = false;
        const octets = await lireAvecRejeu();
        if (octets === null || ferme) continue;
        const v = verdictLecture(hashCharge, octets, parse);
        if (v.action === 'identique') continue;
        if (v.action === 'invalide') { log(`config: ${v.raison} — ancienne config conservée`); continue; }
        try {
          onContenu(v.texte);
          hashCharge = v.hash; // avancé SEULEMENT si la config est acceptée : un refus se rejoue au prochain réveil
        } catch (e) {
          log('config reload IGNOREE (invalide) : ' + describeError(e)); // on garde l'ancienne config valide
        }
      } while (relance && !ferme);
    } finally {
      enCours = false;
    }
  }

  function basculerSondage(cause) {
    if (sondage || ferme) return;
    sondage = true;
    if (watcher) { try { watcher.close(); } catch { /* SILENCE: fermer un watcher deja mort (erreur OS) est le resultat voulu */ } watcher = null; }
    log(`config: surveillance par ÉVÉNEMENT indisponible (${cause}) — REPLI sur sondage toutes les ${CONFIG_WATCH_INTERVAL_MS} ms (doc Node : NFS/SMB)`);
    fsImpl.watchFile(chemin, { interval: CONFIG_WATCH_INTERVAL_MS, persistent: false }, () => { void verifier(); });
  }

  try {
    watcher = fsImpl.watch(dossier, { persistent: false }, (_ev, nomEvenement) => {
      if (concerne(nomEvenement, nom)) void verifier();
    });
    watcher.on('error', (e) => basculerSondage(describeError(e)));
  } catch (e) {
    basculerSondage(describeError(e));
  }

  return {
    verifier,
    mode: () => (sondage ? 'sondage' : 'evenement'),
    fermer() {
      ferme = true;
      if (watcher) { try { watcher.close(); } catch { /* SILENCE: fermer un watcher deja mort (erreur OS) est le resultat voulu */ } watcher = null; }
      if (sondage) { try { fsImpl.unwatchFile(chemin); } catch { /* SILENCE: rien a retirer si le sondage n a jamais pris (fermeture idempotente) */ } }
    },
  };
}
