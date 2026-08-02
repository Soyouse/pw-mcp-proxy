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

export const READY_TIMEOUT_MS = 20000; // budget d'attente qu'un serveur NEUF reponde sur /mcp

export const READY_POLL_MS = 200; // periode de sondage pendant cette attente
// Budget d'UNE sonde HTTP (pas de l'attente entiere). Etait en DUR (`2000`) dans supervisor.js —
// remonte ici le 02/08 : budget.js est la SOURCE UNIQUE, un delai en dur ailleurs derive en silence.
// ⚠️ C'est le temps accorde a UNE requete sur la loopback ; l'attente globale, elle, est bornee par
// READY_TIMEOUT_MS et surtout interrompue par un FAIT (process mort) — cf readiness.js.
export const PROBE_TIMEOUT_MS = 2000;

// Marge au-dela de laquelle une entree `starting` du registre est declaree MORTE-NEE.
// LIEN CAUSAL REEL (c'est pour ca qu'elle DERIVE) : passe le budget de readiness, un serveur qui n'a
// toujours pas ete promu ne le sera JAMAIS — le proxy qui le pollait est mort avant de le promouvoir.
// Le facteur > 1 couvre l'ecart entre le spawn et le debut du poll (jamais un reap d'un demarrage sain).


// ⚠️ Delais RAPATRIES ici par le gate statique  (31/07) : ils vivaient en dur
// dans manager.js et notify.js. Aucun n'etait faux — mais c'est EXACTEMENT la dispersion couche par
// couche qui a coute la connexion MCP du 31/07 (chaque couche son delai, aucune vue d'ensemble).
// Un delai invisible depuis ce fichier est un delai que personne ne pourra arbitrer le jour ou il faudra.

// Periode de scrutation du fichier de config (hot-reload). fs.watchFile POLLE : trop court = reveils
// inutiles a la seconde ; trop long = un changement de profil met des secondes a etre vu. 1 s = compromis
// eprouve. ⚠️ NE PAS descendre : ce timer tourne en permanence, pour un fichier qui change 2x par mois.
export const CONFIG_WATCH_INTERVAL_MS = 1000;

// Borne de l'alerte dead-man (NTFY). ⚠️ COURTE ET OBLIGATOIRE : alerter est best-effort, mais une
// alerte qui PEND retiendrait un arret du proxy. Une alerte perdue est benigne ; un proxy bloque par
// son propre canal d'alerte serait un comble (le remede devenu la panne).
export const ALERT_TIMEOUT_MS = 4000;
