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

// 🛑 ON ALLOUE SUR **EXACTEMENT LA MEME CHAINE D'HOTE** QUE CELLE QUE LE SERVEUR VA BINDER, jamais
// 0.0.0.0 : un port libre sur une interface ne prouve RIEN sur une autre.
//
// ⚠️ BUG MESURE LE 02/08 — `'localhost'` N'EST PAS `'127.0.0.1'`. Sur une machine a double pile,
// `localhost` resout d'abord en **`::1`** (verifie : `dns.lookup('localhost',{all:true})` rend
// `[::1, 127.0.0.1]` et `listen(0,'localhost')` bind `::1`). On allouait donc le port sur l'IPv4
// pendant que le serveur bindait l'IPv6 : port declare libre la ou le serveur n'ira JAMAIS, et
// potentiellement DEJA PRIS la ou il va. Symptome : « serveur VIVANT mais silencieux apres
// 20000ms » — le process tourne, mais son `listen` a echoue ou vise une autre pile. Longtemps
// impute a tort a « la loopback tombe sous charge » : ce n'etait pas la charge, c'etait la pile.
// ⚠️ NE JAMAIS remettre un littéral d'adresse ici : c'est le NOM que le serveur recoit en `--host`
// qui fait foi, et lui seul. Un jour ou le defaut de `@playwright/mcp` changerait, ce parametre
// suit tout seul.
const HOTE_PAR_DEFAUT = 'localhost'; // = BIND_HOST du daemon (defaut documente @playwright/mcp)

/**
 * Demande a l'OS un port TCP libre SUR L'HOTE OU LE SERVEUR VA BINDER, puis rend la main.
 * Le socket est ferme AVANT de resoudre : le port est libre pour le serveur qu'on va lancer.
 * @param {string} [hote] la MEME chaine que le `--host` du serveur — ne pas la « normaliser »
 * @returns {Promise<number>} numero de port (jamais 0, jamais devine)
 */
export function allocateEphemeralPort(hote = HOTE_PAR_DEFAUT) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // ⚠️ Handler d'erreur AVANT listen : un EADDRINUSE/EACCES non capture sur un serveur net = throw
    // asynchrone non rattrapable => proxy mort. Fails-closed : on rejette, l'appelant decide.
    srv.on('error', reject);
    srv.listen(0, hote, () => {
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
