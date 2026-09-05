// PUR (Stryker) — LA DÉCISION du rechargement de `profiles.json` (posé 05/09/2026).
//
// 🛑 L'ÉVÉNEMENT DE L'OS NE DIT JAMAIS « LE CONTENU A CHANGÉ ». Doc officielle Node v22 (fs.watch) :
//    - « on some platforms (e.g. Windows), the 'rename' event is sometimes emitted along with a
//      'change' event » (un geste = plusieurs événements) ;
//    - « filename is not always guaranteed to be provided » (⇒ un `null` se VÉRIFIE, jamais ignoré) ;
//    - un antivirus / un indexeur qui TOUCHE le fichier produit un événement sans modification.
//    ⇒ L'OS RÉVEILLE, LE CONTENU DÉCIDE : on hache les octets lus et on compare au hash CHARGÉ.
//    Identique ⇒ rien. Invalide (écriture en deux temps, fichier à moitié écrit) ⇒ rien, l'événement de
//    fin d'écriture rejouera. Ce n'est PAS une inférence : soit le contenu est valide ET différent, soit
//    on ne touche à rien. Le cas « on a chargé du faux » n'existe pas.
// ⚠️ On REFUSE le `awaitWriteFinish` de chokidar (attendre 2 s que la taille se stabilise) : c'est une
//    supposition sur la vitesse d'écriture. Le hash de contenu la rend inutile.
// ⚠️ Zéro I/O ici : le hash est un CALCUL (déterministe), l'I/O vit dans `config-watch.js`.
import { createHash } from 'node:crypto';

/** Empreinte du contenu — SOURCE UNIQUE de « ces octets sont-ils ceux déjà chargés ? ». */
export function empreinte(octets) {
  return createHash('sha256').update(octets).digest('hex');
}

/**
 * L'événement concerne-t-il notre fichier ? `null`/`undefined` ⇒ OUI (doc Node : le nom n'est pas
 * garanti ; vérifier est gratuit, rater un changement ne l'est pas — fails-closed).
 * @param {string|Buffer|null|undefined} nomEvenement
 * @param {string} nomCible basename du fichier surveillé
 */
export function concerne(nomEvenement, nomCible) {
  if (nomEvenement === null || nomEvenement === undefined) return true;
  return String(nomEvenement) === nomCible;
}

/**
 * Verdict sur des octets lus après un réveil.
 * @param {string|null} hashCharge empreinte du contenu actuellement chargé (`null` = rien chargé)
 * @param {Buffer|string} octets contenu lu
 * @param {(texte:string)=>unknown} parse interpréteur (JSON.parse) — throw = invalide
 * @returns {{action:'identique'}|{action:'invalide', raison:string}|{action:'charger', hash:string, texte:string}}
 */
export function verdictLecture(hashCharge, octets, parse) {
  const hash = empreinte(octets);
  if (hash === hashCharge) return { action: 'identique' };
  const texte = Buffer.isBuffer(octets) ? octets.toString('utf8') : String(octets);
  try {
    parse(texte);
  } catch (e) {
    return { action: 'invalide', raison: `contenu illisible (écriture en cours ?) : ${e instanceof Error ? e.message : String(e)}` };
  }
  return { action: 'charger', hash, texte };
}

// Codes d'erreur de LECTURE qui signifient « quelqu'un tient le fichier à cet instant » : antivirus,
// indexeur, éditeur en plein renommage atomique (ENOENT = l'ancien nom est parti, le nouveau pas
// encore lié). Aucune autorité locale ne dit QUAND ça finit ⇒ rejeu au calendrier déclaré (budget.js).
// ⚠️ Liste FERMÉE : tout autre code est une erreur RÉELLE, nommée, jamais rejouée.
const TRANSITOIRES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EAGAIN']);

/**
 * Que faire d'un échec de lecture ?
 * @param {string|undefined} code `err.code`
 * @param {number} essai index de l'essai qui vient d'échouer (0 = premier)
 * @param {readonly number[]} calendrier pauses AVANT chaque rejeu
 * @returns {{action:'rejouer', pauseMs:number}|{action:'abandon'}|{action:'fatal'}}
 */
export function verdictErreurLecture(code, essai, calendrier) {
  if (!TRANSITOIRES.has(String(code))) return { action: 'fatal' };
  if (essai < calendrier.length) return { action: 'rejouer', pauseMs: calendrier[essai] };
  return { action: 'abandon' };
}
