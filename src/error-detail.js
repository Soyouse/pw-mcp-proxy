// PUR — rend une erreur de transport DIAGNOSTICABLE en une seule occurrence.
//
// POURQUOI (incident 31/07→01/08/2026, ~5 h de blocage) : le log disait
// `transport error: POST request:` — message VIDE. La cascade qui a suivi (crash backend →
// respawn → contention du verrou → `registry lock: timeout` en boucle) a ete diagnostiquee,
// mais la CAUSE PREMIERE est restee inconnue faute d'UN champ. Or toute erreur `node:http`
// porte un `code` (`ECONNRESET`/`ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`), et `err.message` peut
// etre vide la ou `err.code` ne l'est JAMAIS.
//
// ⚠️ NE JAMAIS journaliser `err.message` SEUL sur une erreur d'I/O reseau : c'est precisement
//    ce qui a rendu l'incident du 01/08 non diagnosticable. Passer par cette fonction.
// ⚠️ Fonction TOTALE : ne throw JAMAIS, quel que soit l'argument (null, chaine, objet exotique,
//    getter qui explose). Un chemin de LOG qui jette transformerait une panne en DEUXIEME panne,
//    au pire moment — quand tout va deja mal.
// ⚠️ PUR : zero I/O, zero horloge. La decision (quoi ecrire) est ici et mutation-testee ;
//    l'ecriture reste dans logger.js.

// Champs diagnostiques standard de `node:http` / `node:net` / libuv, dans l'ordre d'utilite.
// `code` d'abord : c'est le seul TOUJOURS present et le seul qui tranche la nature de la panne.
const FIELDS = ['code', 'syscall', 'errno', 'address', 'port'];

function safeGet(err, key) {
  try {
    const v = err[key];
    if (v === undefined || v === null || v === '') return null;
    return String(v);
  } catch {
    return null; // getter piege : on ne laisse RIEN casser le chemin de log
  }
}

/**
 * Decrit une erreur pour le log : message + champs diagnostiques.
 *
 * @param {unknown} err
 * @returns {string} description non vide (jamais '' : un log vide est ce qu'on corrige ici)
 */
export function describeError(err) {
  // NOTE Stryker : muter `err === null` en `false` SURVIT — c'est un mutant EQUIVALENT.
  // `null` retomberait dans la branche objet, ou chaque acces est protege par safeGet et
  // rend le meme '<no error>'. Le test explicite est garde pour l'INTENTION, pas pour le score.
  if (err === null || err === undefined) return '<no error>';
  if (typeof err !== 'object') return String(err) || '<no error>';

  const parts = [];
  for (const f of FIELDS) {
    const v = safeGet(err, f);
    if (v !== null) parts.push(`${f}=${v}`);
  }

  const msg = safeGet(err, 'message');
  // ⚠️ `name` n'est repris que s'il est SPECIFIQUE (`AbortError`, `TypeError`…). Le `name`
  // par defaut d'une Error est litteralement 'Error' : l'afficher n'apprendrait RIEN et
  // polluerait chaque ligne de log d'un prefixe vide de sens.
  const name = safeGet(err, 'name');
  const nameUtile = name && name !== 'Error' ? name : null;
  // Le message passe en tete quand il existe ; sinon les champs portent seuls le diagnostic.
  const head = msg || nameUtile || null;

  if (head && parts.length) return `${head} [${parts.join(' ')}]`;
  if (head) return head;
  if (parts.length) return `[${parts.join(' ')}]`;
  return '<no error>'; // objet sans aucun champ exploitable : on le DIT, on ne rend pas ''
}

/**
 * Pile d'appel d'une erreur, SANS JAMAIS supposer que c'en est une.
 *
 * ⚠️ RAISON D'ETRE, trouvee par `tsc --checkJs` le 02/08 : sur `unhandledRejection`, la raison est
 * de type INCONNU — `Promise.reject('boum')` est parfaitement legal. Lire `.stack` dessus rendait
 * `undefined` en SILENCE, donc un log tronque au moment precis ou on en a besoin.
 * Fonction TOTALE : rend toujours une chaine, jamais d'exception.
 * @param {unknown} err
 * @returns {string} la pile, ou '' si l'objet n'en porte pas
 */
export function stackOf(err) {
  const s = err && typeof err === 'object' ? /** @type {{stack?:unknown}} */ (err).stack : null;
  return typeof s === 'string' ? s : '';
}
