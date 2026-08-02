// I/O — « ce serveur est-il joignable ? », en interrogeant CE QUI SAIT.
//
// ⚠️ SOURCE UNIQUE de la question « est-il prêt ? ». Extraite le 02/08 AVANT d'écrire le daemon,
// précisément pour ne jamais en avoir deux versions : une logique de readiness dupliquée, c'est la
// garantie qu'on corrigera l'une et pas l'autre — et le bug ne se manifesterait alors que sur un
// seul des deux chemins. Consommateur unique aujourd'hui : `server-daemon.js`.
//
// 🛑 LE BUDGET EST UN FILET, PAS UN COUPERET. Deux des trois issues sont des FAITS EXACTS du
// noyau, obtenus SANS délai ; la troisième seule est indécidable :
//     'pret'  le port accepte une connexion        -> immédiat, quelle que soit la durée écoulée
//     'mort'  le process a disparu                 -> immédiat : inutile d'attendre un mort
//     'muet'  vivant mais silencieux               -> problème de l'arrêt, SEUL usage du budget
//
// ⚠️ LA CHARGE DE LA MACHINE NE NOUS REGARDE PAS. L'utilisateur a le droit d'avoir 900 process :
// un démarrage LENT n'est pas une panne. C'est le modèle `systemd Type=notify` — le service
// SIGNALE sa disponibilité, `TimeoutStartSec` n'est qu'un dernier recours. NE JAMAIS revenir à
// une boucle bornée par le seul temps : elle transforme une machine occupée en panne, et son
// message accuse alors le réseau à tort (vécu le 02/08, 7 tests rouges sans aucun défaut de code).

import http from 'node:http';
import { isPidAlive } from './prockill.js';
import { READY_POLL_MS, PROBE_TIMEOUT_MS, READY_TIMEOUT_MS } from './budget.js';

/**
 * Le serveur répond-il MAINTENANT sur `/mcp` ? Une seule tentative, sans interprétation.
 *
 * ⚠️ Se connecter sur `localhost`, JAMAIS `127.0.0.1` : le serveur valide l'en-tête `Host`
 * (anti DNS-rebinding) et renvoie 403 sinon. Toute réponse HTTP prouve qu'il écoute — même un
 * 4xx : on teste la PRÉSENCE d'un serveur, pas la validité de la requête.
 */
export function sonder(port, host = 'localhost', budgetMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), budgetMs);
    t.unref?.();
    const fin = (v) => { clearTimeout(t); resolve(v); };
    const req = http.request(
      { hostname: host, port, path: '/mcp', method: 'GET', signal: ac.signal },
      (res) => { res.resume(); fin(true); }
    );
    req.on('error', () => fin(false));
    req.end();
  });
}

/**
 * Attend qu'un serveur devienne joignable.
 *
 * @param {number} port
 * @param {{budgetMs?:number, pid?:number|null, host?:string, delai?:(ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<'pret'|'mort'|'muet'>}
 */
export async function attendreReady(port, { budgetMs = READY_TIMEOUT_MS, pid = null, host = 'localhost', delai } = {}) {
  const pause = delai || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (await sonder(port, host)) return 'pret';
    // FAIT EXACT : le noyau dit que ce process n'existe plus. Continuer à sonder un mort serait
    // une inférence pure — et ferait attendre le budget entier pour rien.
    if (pid != null && !isPidAlive(pid)) return 'mort';
    await pause(READY_POLL_MS);
  }
  return 'muet';
}
