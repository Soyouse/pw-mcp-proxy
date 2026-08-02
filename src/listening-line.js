// PUR — lecture de l'ANNONCE DE DISPONIBILITE que le serveur @playwright/mcp ecrit sur sa sortie
// standard au demarrage :
//     Listening on http://localhost:14013
//
// ⚠️ POURQUOI CE FICHIER EXISTE (refonte du 02/08/2026) : le superviseur SONDAIT le port en boucle
// (`_pollReady`) pour deviner « le serveur est-il pret ? ». C'etait une INFERENCE — et un delai.
// Or le serveur REPOND lui-meme a la question : cette ligne est un FAIT, emis par l'autorite
// concernee, au moment exact ou c'est vrai. On n'interroge que ce qui SAIT.
// Consequence : zero poll, zero setTimeout, zero « pas pret apres 20000ms ».
//
// ⚠️ TOLERANCE AU WORDING VOLONTAIRE — ne PAS resserrer en matchant la phrase exacte : le libelle
// appartient a Microsoft et peut changer sans preavis. On ne cherche qu'une URL http(s) portant LE
// port qu'on a nous-meme impose via --port. Le port est notre ancre (on le connait deja) ; la
// phrase autour n'est que du decor. Si un jour la ligne disparait completement, l'echec est
// BRUYANT (le daemon n'annonce jamais, le client le voit a la fermeture du pipe) — jamais un silence.
//
// Fonction TOTALE : ne throw JAMAIS, rend null quand il n'y a rien a lire.

/**
 * Cherche, dans un fragment de sortie, l'URL annoncee pour le port attendu.
 *
 * @param {string} chunk  texte brut (peut contenir 0, 1 ou N lignes, coupees n'importe ou)
 * @param {number} port   le port QUE NOUS avons impose au serveur (--port)
 * @returns {string|null} l'URL annoncee, ou null si absente de ce fragment
 */
export function findListeningUrl(chunk, port) {
  if (typeof chunk !== 'string' || !Number.isInteger(port) || port <= 0) return null;
  // `\b` apres le port : sans lui, le port 1401 matcherait une annonce sur 14013.
  const rx = new RegExp(`https?://[^\\s"']*:${port}\\b[^\\s"']*`);
  const m = rx.exec(chunk);
  return m ? m[0] : null;
}

/**
 * Accumulateur INCREMENTAL : la sortie d'un process arrive en fragments coupes n'importe ou,
 * l'URL peut donc etre a cheval sur deux `data`. On garde le texte non encore exploite.
 *
 * ⚠️ Le tampon est BORNE (MAX_PENDING) : un serveur bavard qui n'annoncerait jamais ne doit pas
 * faire enfler la memoire du daemon indefiniment. On conserve la FIN du flux (l'annonce, si elle
 * vient, sera dans les derniers octets, jamais dans les premiers).
 *
 * @returns {{pending:string, url:string|null}}
 */
export const MAX_PENDING = 8192;

export function feedListening(pending, chunk, port) {
  const text = (typeof pending === 'string' ? pending : '') + (typeof chunk === 'string' ? chunk : '');

  // ⚠️ ON NE PARSE QUE DES LIGNES COMPLETES (terminees par \n) — NE PAS analyser le reliquat.
  // BUG TROUVE PAR PROPERTY-TEST le 02/08 : en analysant le texte partiel, un fragment coupe en
  // plein milieu de l'URL (« ...:14013/m ») rendait une URL TRONQUEE, et le proxy se serait
  // branche sur une adresse invalide. Une annonce est une LIGNE : tant que le \n n'est pas la,
  // l'annonce n'est pas finie, donc il n'y a RIEN a lire. Ne jamais « deviner » une URL partielle.
  let rest = text;
  let nl;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const ligne = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    const url = findListeningUrl(ligne, port);
    if (url) return { pending: '', url };
  }
  // Reliquat sans \n : conserve pour le prochain fragment, borne par la FIN (l'annonce, si elle
  // vient, sera dans les derniers octets — jamais dans les premiers).
  return { pending: rest.length > MAX_PENDING ? rest.slice(-MAX_PENDING) : rest, url: null };
}
