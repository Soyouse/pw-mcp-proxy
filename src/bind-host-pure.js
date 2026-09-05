// bind-host-pure.js — LA DECISION « sur quelle adresse les serveurs ont le droit d'ECOUTER ». Pose le 05/09/2026.
//
// ═══ POURQUOI CE MODULE EXISTE ═══
// `@playwright/mcp` n'a AUCUNE authentification : un serveur qui ecoute sur une adresse ROUTABLE est
// un navigateur connecte (cookies, comptes) offert a tout le reseau. Le defaut `localhost` est sur ;
// mais sous Windows libuv desactive la retransmission SYN vers 127.x/::1 (`uv__is_loopback`), et
// un micro-hoquet transforme un `connect()` en ETIMEDOUT (mesure en live le 05/09 pendant le
// lancement de deux Chrome). La sortie = ecouter sur une adresse HORS loopback mais INJOIGNABLE
// (carte virtuelle « branchee sur rien », ou lien-local). Ce module TRANCHE ce qui est admis :
//   - `localhost`, 127.0.0.0/8, ::1          ⇒ loopback (defaut, sur, classe libuv presente)
//   - 169.254.0.0/16 (lien-local, jamais route) ⇒ admis tel quel
//   - 10/8, 172.16/12, 192.168/16 (prive)     ⇒ admis UNIQUEMENT si l'operateur DECLARE la carte
//     (`bindHostInterface`) ET que l'adresse est MESUREE sur cette carte (`os.networkInterfaces`)
//   - tout le reste (public, Tailscale 100.64/10, IPv6 global) ⇒ REFUSE, nomme
// ⚠️ Le noeud DISTANT (VPS, bind Tailscale + jeton) est une exception NOMMEE geree AILLEURS, jamais ici.
// ⚠️ PUR : les interfaces sont INJECTEES (jamais lues ici) — mutation-teste.

const RX_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Classe d'une adresse IPv4 (chaine). `null` si ce n'est pas une IPv4 valide. */
export function classeAdresse(hote) {
  // Pas de garde `typeof` : un non-string ne matche jamais RX_V4 (coercion en texte) ⇒ `null`. Une garde
  // ici serait un mutant EQUIVALENT (prouve par Stryker le 05/09), donc supprimee a la source.
  if (hote === 'localhost' || hote === '::1') return 'loopback';
  const m = RX_V4.exec(hote);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  if (o[0] === 127) return 'loopback';
  if (o[0] === 169 && o[1] === 254) return 'lien-local';
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) return 'prive';
  return 'routable';
}

/**
 * Verdict sur un `bindHost` de configuration.
 * @param {unknown} hote valeur de `bindHost` (absent = loopback par defaut)
 * @param {{interfaceDeclaree?:unknown, interfaces?:Record<string, Array<{address:string}>>}} [ctx]
 *   `interfaces` = forme de `os.networkInterfaces()`, INJECTEE.
 * @returns {{ok:true, classe:'loopback'|'lien-local'|'isole'}|{ok:false, raison:string}}
 */
export function verdictBindHost(hote, ctx = {}) {
  if (hote === undefined || hote === null || hote === '') return { ok: true, classe: 'loopback' };
  if (typeof hote !== 'string') return { ok: false, raison: `bindHost doit être une chaîne, reçu ${typeof hote}` };
  const classe = classeAdresse(hote);
  if (classe === null) return { ok: false, raison: `bindHost "${hote}" n'est ni localhost, ni une adresse IPv4 valide` };
  if (classe === 'loopback') return { ok: true, classe: 'loopback' };
  if (classe === 'lien-local') return { ok: true, classe: 'lien-local' };
  if (classe === 'routable') return { ok: false, raison: `bindHost "${hote}" est ROUTABLE — le serveur n'a aucune authentification, il serait offert au réseau. Admis : localhost, 127/8, 169.254/16, ou un réseau privé sur une carte DÉCLARÉE (bindHostInterface)` };
  // prive : exige la carte declaree ET l'adresse mesuree dessus
  const carte = ctx.interfaceDeclaree;
  if (typeof carte !== 'string' || carte.length === 0) return { ok: false, raison: `bindHost "${hote}" est une adresse PRIVÉE : déclarer la carte dédiée qui la porte (bindHostInterface), sinon rien ne distingue une carte isolée d'un vrai LAN` };
  const adresses = ctx.interfaces ? ctx.interfaces[carte] : null;
  if (!Array.isArray(adresses)) return { ok: false, raison: `bindHostInterface "${carte}" : aucune carte de ce nom sur cette machine` };
  if (!adresses.some((a) => a && a.address === hote)) return { ok: false, raison: `bindHost "${hote}" n'est PAS une adresse de la carte "${carte}" (mesuré sur les interfaces) — la config ne correspond pas à la machine` };
  return { ok: true, classe: 'isole' };
}
