// port-alloc.js — I/O MINIMAL : obtenir de l'OS un port TCP reellement libre sur la loopback.
//
// ⚠️ POURQUOI CE MODULE EXISTE (incident 2026-07-31, 3 h d'enquete + MCP browser mort) : le port etait
// auparavant CALCULE a partir du nom de profil (hash deterministe). Ce choix supposait « ce numero sera
// libre ET joignable sur cette machine » — hypothese INDEFENDABLE : un port peut etre pris par une autre
// application, redirige par un driver reseau (antivirus, VPN, capture), ou filtre. Le 31/07 le port 9639
// est devenu injoignable EN SILENCE : le serveur demarrait, personne ne pouvait l'atteindre, et le
// diagnostic accusait le serveur. Une hypothese fausse mais vraie 99 fois sur 100 = la pire categorie de
// defaut : invisible jusqu'au jour ou elle coute une journee.
//
// ⚠️ LA REGLE, desormais : LE PROXY NE CHOISIT JAMAIS UN NUMERO DE PORT. Il le DEMANDE a l'OS, qui ne
// rend que des ports reellement libres. C'est la pratique de l'industrie pour un serveur local (Chrome
// avec --remote-debugging-port=0 + DevToolsActivePort, Jupyter avec son fichier de connexion) : le port
// est ALLOUE puis PUBLIE, jamais devine. Ici la publication se fait dans le registre partage, que tous
// les agents lisent deja — d'ou un changement minuscule pour une immunite totale a cette classe de panne.
//
// ⚠️ « port 0 » = contrat POSIX **et** Windows (Winsock : « the service provider assigns a unique port
// from the dynamic client port range »). Surface DOCUMENTEE et identique sur les 3 OS de la matrice CI :
// aucune retro-ingenierie, rien qui puisse changer a une mise a jour d'un tiers.
//
// ⚠️ FENETRE DE COURSE ASSUMEE ET TRAITEE (TOCTOU) : entre notre close() et le bind du serveur, un autre
// process peut theoriquement rafler le port. C'est une propriete CONNUE de cette technique (des libs
// existent pour la reduire), pas un defaut de notre code. Elle se traite par REESSAI : l'appelant
// redemande un port a l'OS et relance. Comme l'OS rend un port DIFFERENT a chaque fois, deux echecs
// d'affilee sont deja improbables. ⚠️ NE JAMAIS « corriger » ca en revenant a un port fixe/calcule :
// on echangerait une course de quelques millisecondes contre une panne PERMANENTE (l'incident du 31/07).

import net from 'node:net';

// ⚠️ On alloue sur 127.0.0.1 UNIQUEMENT, jamais 0.0.0.0 : un port libre sur toutes les interfaces ne
// prouve PAS qu'il est libre sur la loopback (et inversement). Le serveur @playwright/mcp bind
// `localhost` (defaut documente) => on doit interroger l'OS sur CETTE MEME interface, sinon on lui
// donnerait un port valide « ailleurs » et le bind echouerait. MEME interface des deux cotes, toujours.
const LOOPBACK = '127.0.0.1';

/**
 * Demande a l'OS un port TCP libre sur la loopback, puis rend la main.
 * Le socket est ferme AVANT de resoudre : le port est libre pour le serveur qu'on va lancer.
 * @returns {Promise<number>} numero de port (jamais 0, jamais devine)
 */
export function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // ⚠️ Handler d'erreur AVANT listen : un EADDRINUSE/EACCES non capture sur un serveur net = throw
    // asynchrone non rattrapable => proxy mort. Fails-closed : on rejette, l'appelant decide.
    srv.on('error', reject);
    srv.listen(0, LOOPBACK, () => {
      const addr = srv.address();
      // `address()` rend un objet {port} pour un socket TCP. Defensif : si l'OS rendait autre chose
      // (cas non documente), on refuse plutot que de propager un port invalide dans le registre.
      const port = addr && typeof addr === 'object' ? addr.port : null;
      srv.close(() => {
        if (typeof port === 'number' && port > 0) resolve(port);
        else reject(new Error('allocation de port : adresse inattendue de l OS'));
      });
    });
  });
}
