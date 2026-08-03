// budget.js — PUR : SOURCE UNIQUE des budgets de temps du proxy.
//
// ⚠️ RAISON D'ETRE (incident 2026-07-31) : la connexion MCP a ete PERDUE parce que chaque couche avait
// choisi son delai DANS SON COIN (poll-ready 20s, attente de verrou 30s, peremption 60s) sans qu'aucune
// ne connaisse le SEUL delai qui decide de tout : celui au bout duquel le CLIENT raccroche. Ce delai
// n'existait NULLE PART dans le code = couplage implicite pur. Il vit ICI, et tout le reste en DERIVE.
//
// ⚠️ NE JAMAIS redeclarer un delai ailleurs (supervisor.js, router.js, backend.js...) : le recopier
// recree EXACTEMENT le defaut qu'on repare. Toute nouvelle temporisation DOIT venir d'ici.
//
// ⚠️ ON NE DERIVE QUE CE QUI A UN LIEN CAUSAL REEL. Le temps de demarrage d'un serveur @playwright/mcp
// est une propriete du BACKEND, pas du client : le lier au budget client serait un FAUX couplage (aussi
// trompeur que l'absence de source unique). Deux familles distinctes ci-dessous, volontairement separees.
//
// SOURCES (doc OFFICIELLE Claude Code, verifiee le 2026-07-31 — code.claude.com/docs/en/mcp) :
//   - `MCP_TIMEOUT` = timeout de DEMARRAGE d'un serveur MCP, en ms (exemple documente : MCP_TIMEOUT=10000
//     pour 10 s). On le LIT dans l'environnement => le budget n'est pas DEVINE, il est HERITE du client.
//   - Valeur par DEFAUT non publiee par la doc => MESUREE : Claude Code a rendu
//     « connection timed out after 30000ms » (incident du 2026-07-31). Fait mesure, pas documente :
//     si un jour la doc publie le defaut, c'est ELLE qui gagne (doc-first).
//   - ⚠️ Un serveur STDIO (NOTRE cas) n'est PAS reconnecte automatiquement : la doc reserve le retry et
//     le backoff exponentiel aux transports `http`/`sse`. Depasser ce budget = session MORTE jusqu'a une
//     action HUMAINE (`/mcp` -> reconnect). C'est pour ca que le handshake DOIT repondre dans le budget,
//     TOUJOURS, meme degrade : il n'y a pas de deuxieme chance.

// ---------- famille 1 : le CLIENT (ce qui doit repondre avant qu'il raccroche) ----------

// Defaut MESURE (cf SOURCES). Sert uniquement quand MCP_TIMEOUT n'est pas dans l'environnement.
export const DEFAULT_CLIENT_BUDGET_MS = 30000;

// Fraction du budget client qu'une reponse de handshake s'autorise a attendre avant de repondre DEGRADE.
// ⚠️ DEGRADER LE PLUS TARD POSSIBLE, jamais "par prudence" : la reponse degradee est un FILET DE
// SECURITE, pas un mode de fonctionnement. Un ratio trop bas (0.4 = 12 s, valeur initiale ERRONEE)
// declencherait le degrade sur un demarrage LENT MAIS SAIN — typiquement le tout premier `npx` qui
// telecharge le package — et Claude verrait alors une liste d'outils AMPUTEE (nos 3 tools maison
// seulement) le temps du rattrapage : un CHANGEMENT DE COMPORTEMENT observable, donc une regression.
// A 0.8, la borne ne se declenche QUE au-dela de 24 s sur un mur client de 30 s, c'est-a-dire
// uniquement dans les cas ou la version precedente PERDAIT la connexion de toute facon.
// ⇒ identique partout, sauf la ou c'etait deja mort. NE PAS baisser sans refaire ce raisonnement.
export const HANDSHAKE_RATIO = 0.8;

// Marge de surete du gate : aucune reponse de handshake ne doit approcher le mur du client.
export const SAFETY_RATIO = 0.8;

// Budget client EFFECTIF, HERITE de l'environnement (MCP_TIMEOUT) ou defaut mesure.
// PUR : l'environnement est un PARAMETRE (jamais lu depuis process.env ici) => testable/mutable.
// Une valeur non numerique, nulle ou negative est ignoree (on retombe sur le defaut) : un
// MCP_TIMEOUT casse ne doit JAMAIS produire un budget absurde (0 => tout repondrait degrade).
export function clientBudgetMs(env = {}) {
  const raw = Number(env.MCP_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLIENT_BUDGET_MS;
}

// Budget d'UNE reponse de handshake (initialize / tools/list). Au-dela, on repond DEGRADE plutot que
// de laisser le client raccrocher : une reponse degradee est rattrapable (tools/list_changed), une
// connexion perdue ne l'est PAS (stdio = aucun retry automatique, cf SOURCES).
export function handshakeBudgetMs(clientBudget = DEFAULT_CLIENT_BUDGET_MS) {
  return Math.floor(clientBudget * HANDSHAKE_RATIO);
}

// GATE (invariant central, appele par le test statique) : une reponse de handshake arrive-t-elle
// TOUJOURS avant le mur du client, avec marge ? Repondre false = ROUGE au push.
// ⚠️ C'est CE predicat qui tue la CLASSE d'erreur : ajouter demain une attente dans le handshake sans
// toucher au budget rendra le mur ROUGE, au lieu de casser silencieusement la connexion d'un humain.
export function handshakeFitsBudget(clientBudget = DEFAULT_CLIENT_BUDGET_MS) {
  return handshakeBudgetMs(clientBudget) <= clientBudget * SAFETY_RATIO;
}

// ---------- famille 2 : le BACKEND (proprietes du serveur, INDEPENDANTES du client) ----------
// ⚠️ Ces delais ne derivent PAS du budget client : depuis que le handshake est borne (cf router.js),
// le demarrage d'un serveur se poursuit EN ARRIERE-PLAN sans tenir la connexion en otage. Les lier
// serait un faux couplage. Ils vivent ici uniquement pour la SOURCE UNIQUE.

// 🛑 FILET, JAMAIS COUPERET — et volontairement GENEREUX.
// ⚠️ 20000 etait un chiffre ARBITRAIRE, et il coupait des demarrages SAINS : mesure du 02/08 sur
// une machine a ~93 process node (cas NORMAL chez l'utilisateur — « la charge ne nous regarde
// pas »), la chaine gardien + serveur depasse parfois 20 s => serveur sain declare « muet ».
// ⚠️ ALLONGER NE COUTE RIEN AU CAS D'ECHEC : la MORT du process est un FAIT detecte
// immediatement (`isPidAlive`, cf readiness.js) et coupe l'attente sans consommer le budget. Ce
// budget ne s'applique donc QU'AU seul cas reellement indecidable — vivant mais pas encore pret.
// ⚠️ ET IL NE FAIT PENDRE PERSONNE : le handshake du router est borne separement (`withDeadline`)
// et rend une reponse DEGRADEE puis rattrape par `tools/list_changed` — la session survit.
// ANCRAGE EXTERNE plutot qu'un reglage maison : `systemd` accorde **90 s** a un service pour
// signaler qu'il est pret (`DefaultTimeoutStartSec`, man systemd-system.conf). On s'aligne sur la
// reference de l'industrie pour exactement la meme question.
export const READY_TIMEOUT_MS = 90000; // budget d'attente qu'un serveur NEUF reponde sur /mcp

export const READY_POLL_MS = 200; // periode de sondage pendant cette attente
// Budget d'UNE sonde HTTP (pas de l'attente entiere). Etait en DUR (`2000`) dans supervisor.js —
// remonte ici le 02/08 : budget.js est la SOURCE UNIQUE, un delai en dur ailleurs derive en silence.
// ⚠️ C'est le temps accorde a UNE requete sur la loopback ; l'attente globale, elle, est bornee par
// READY_TIMEOUT_MS et surtout interrompue par un FAIT (process mort) — cf readiness.js.
export const PROBE_TIMEOUT_MS = 2000;

// ⚠️ Delais RAPATRIES ici par le gate statique (31/07) : ils vivaient en dur dans manager.js et
// notify.js. Aucun n'etait faux — mais c'est EXACTEMENT la dispersion couche par couche qui a coute
// la connexion MCP du 31/07 (chaque couche son delai, aucune vue d'ensemble). Un delai invisible
// depuis ce fichier est un delai que personne ne pourra arbitrer le jour ou il faudra.
//
// 🛑 CONSTANTES SUPPRIMEES LE 02/08 AVEC LE REGISTRE ET LE SUPERVISEUR — ne pas les reintroduire :
// `LOCK_STALE_MS`, `SERVER_TTL_MS`, `HEARTBEAT_MS`, `SPAWN_ATTEMPTS`, `RETRY_READY_TIMEOUT_MS`,
// `startStaleMs`. Elles repondaient toutes a « ce truc distant est-il encore vivant ? », question
// que le refcount du noyau rend SANS OBJET (une socket fermee est un FAIT, pas une estimation).
// ⚠️ En avoir besoin a nouveau = le signal qu'un registre est revenu par la fenetre.

// 🛑 WATCHDOG DE LIVENESS (backend.js) — RAPATRIES ICI LE 03/08. Ils vivaient en LITTERAUX NUS
// (`options.pingIntervalMs ?? 15000`) dans backend.js, c'est-a-dire dans le fichier que l'en-tete
// de CE module nomme EXPLICITEMENT comme interdit. Ils echappaient au gate parce que
// `no-inference-gate` ne reconnait que les CONSTANTES EN MAJUSCULES (`RX_CONST`) : un nombre ecrit
// a la main dans un `??` etait donc un delai HORS SOURCE UNIQUE, et INVISIBLE au cliquet.
// ⚠️ NE JAMAIS re-inliner une de ces valeurs dans backend.js « parce que c'est juste un defaut » :
// c'est exactement la dispersion couche par couche qui a coute la connexion MCP du 31/07.
// Motif du delai : INDECIDABLE (distinguer un backend FIGE d'un backend OCCUPE = probleme de
// l'arret ; aucune observation exacte n'existe). Genereux a dessein : un faux positif tuerait une
// action longue LEGITIME (upload de 12 min), et le ping ne tourne QUE si une requete est en vol.
export const PING_INTERVAL_MS = 15000; // periode entre deux pings tant qu'une requete est en vol
export const PING_TIMEOUT_MS = 10000; // budget de reponse d'UN ping
// ⚠️ Ce n'est PAS une duree mais un COMPTE de pings rates consecutifs. Il vit ici quand meme :
// c'est lui qui fixe le delai REEL avant de declarer un gel (3 x 15 s), et le separer de ses deux
// facteurs rendrait ce delai total illisible — donc non arbitrable le jour ou il faudra.
export const MAX_MISSED_PINGS = 3;

// 🛑 BACKOFF DE REOUVERTURE DU FLUX GET SSE (http-transport.js) — RAPATRIES ICI LE 03/08, meme
// raison que ci-dessus (ils etaient ecrits `_delay(500)` / `_delay(300)` en dur, invisibles au gate).
// Motif : DISTANT (le pair est hors de portee du noyau local, aucune autorite a interroger).
// ⚠️ Ces pauses ne bornent RIEN : elles evitent seulement de marteler un serveur qui refuse. La
// borne de la boucle elle-meme est un DEFAUT CONNU et se traite en amont (cf doc transports).
export const GET_RETRY_MS = 500; // apres un echec de connexion / une reponse inattendue
export const GET_REOPEN_MS = 300; // apres une cloture NORMALE du flux par le serveur

// Periode de scrutation du fichier de config (hot-reload). fs.watchFile POLLE : trop court = reveils
// inutiles a la seconde ; trop long = un changement de profil met des secondes a etre vu. 1 s = compromis
// eprouve. ⚠️ NE PAS descendre : ce timer tourne en permanence, pour un fichier qui change 2x par mois.
export const CONFIG_WATCH_INTERVAL_MS = 1000;

// Borne de l'alerte dead-man (NTFY). ⚠️ COURTE ET OBLIGATOIRE : alerter est best-effort, mais une
// alerte qui PEND retiendrait un arret du proxy. Une alerte perdue est benigne ; un proxy bloque par
// son propre canal d'alerte serait un comble (le remede devenu la panne).
export const ALERT_TIMEOUT_MS = 4000;
