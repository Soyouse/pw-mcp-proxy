// server-registry.js — PUR : toute la DECISION du superviseur de serveurs @playwright/mcp HTTP
// partages (quel port, qui est vivant, qui reaper). Isolee de l'I/O (spawn/kill/fetch/fichier vivent
// dans supervisor.js) => passe au crible Stryker + property-based (fast-check).
//
// MODELE : plusieurs proxys (= plusieurs agents Claude) partagent UN serveur @playwright/mcp par
// profil (le persistant = SingletonLock => 1 navigateur, mais N clients HTTP legitimes). Le registre
// (fichier JSON partage) porte l'etat :
//   { servers: { <profil>: { port, pid, spawnedAt, state, clients } } }
// ou clients = { <clientId>: lastSeenMs } (heartbeat). Un serveur est GARDE tant qu'un client bat le
// coeur < ttl ; sinon il est REAPE (tree-kill + retrait). Tout est fonction pure de (registre, faits).
//
// ⚠️ `state` = 'starting' | 'ready' — WRITE-AHEAD (incident 2026-07-31). Un serveur DETACHE existe des
// le spawn : s'il n'est inscrit qu'APRES son poll de readiness (~20-40 s plus tard), toute mort du proxy
// dans cet intervalle laisse un process VIVANT que PERSONNE ne connait — il tient le port ET le lock
// --user-data-dir, fait echouer le spawn suivant, qui met le boot hors budget client, qui tue le proxy,
// qui laisse un nouvel orphelin : panne METASTABLE (le remede fabrique la cause suivante). Le remede est
// la regle universelle du provisioning : ON INSCRIT L'INTENTION AVANT L'ACTION. `starting` est cette
// intention ; `promoteServer` la confirme. Une `starting` jamais promue est reapee (cf reapDecision).
// ⚠️ RETRO-COMPATIBILITE (expand/contract) : `state` ABSENT vaut 'ready'. Un registre ecrit par la
// version precedente reste donc lu correctement pendant la bascule — jamais de fenetre de casse.
//
// ⚠️ RENDEZ-VOUS DES AGENTS = LE REGISTRE, JAMAIS UN CALCUL (refonte 2026-07-31).
// AVANT : le port etait DERIVE du nom de profil par un hash (deux proxys calculaient le meme nombre et
// se retrouvaient dessus, sans se parler). Malin — et cause RACINE de l'incident du 31/07 : ce schema
// PRESUPPOSE que le numero obtenu sera libre ET joignable sur la machine. Quand le port 9639 est devenu
// injoignable (redirection par un driver reseau), le profil est devenu DEFINITIVEMENT inutilisable :
// chaque tentative recalculait le MEME port mort. Un defaut permanent, invisible, non contournable.
// MAINTENANT : le port vient de l'OS (`port-alloc.js`, contrat POSIX+Winsock) et est PUBLIE dans ce
// registre, que tous les agents lisent deja. C'est la pratique de l'industrie (Chrome publie son port
// dans DevToolsActivePort, Jupyter dans son fichier de connexion) : ALLOUER puis PUBLIER, jamais deviner.
// ⚠️ NE JAMAIS reintroduire un port calcule/fixe « pour simplifier le rendez-vous » : le registre le fait
// deja, et le calcul rendrait a nouveau une machine entiere non fonctionnelle sur un seul port occupe.

// Port a viser pour un profil :
//   - si le registre a DEJA une entree pour ce profil => on reutilise SON port : c'est LE rendez-vous
//     (un agent qui arrive trouve le serveur des autres). Ce chemin est INCHANGE depuis toujours.
//   - sinon => `freshPort`, alloue par l'OS par l'appelant (donc reellement libre, ici et maintenant).
// PUR : aucune I/O, aucune allocation ici — l'allocation est un fait mesure, injecte en parametre.
// ⚠️ Aucune deduplication de port entre profils n'est necessaire (contrairement a l'ancien schema, ou
// deux profils pouvaient hasher au MEME nombre) : l'OS ne rend jamais un port deja pris. La classe de
// collision a disparu avec le calcul — on ne la reintroduit pas en re-sondant le registre.
export function pickPort(registry, profile, freshPort) {
  const existing = registry.servers?.[profile];
  if (existing && typeof existing.port === 'number') return existing.port;
  return freshPort;
}

// Registre vide canonique.
export function emptyRegistry() {
  return { servers: {} };
}

// Entree serveur vivante pour un profil, si le registre en a une (sinon null). NE juge PAS la vie
// du pid (c'est un fait I/O) : renvoie l'entree telle quelle, l'appelant croise avec isAlive.
export function serverEntry(registry, profile) {
  return registry.servers?.[profile] || null;
}

// Etats du cycle de vie d'une entree serveur. SOURCE UNIQUE des deux litteraux : les comparer en dur
// ailleurs ferait deriver une copie (le defaut meme qu'on repare). Importer ces constantes, toujours.
export const STATE_STARTING = 'starting'; // spawne, PAS encore prouve pret (intention inscrite)
export const STATE_READY = 'ready'; // a repondu sur /mcp : utilisable par les clients

// Etat effectif d'une entree. ⚠️ `state` ABSENT vaut READY : c'est la brique de retro-compatibilite
// (registre ecrit par la version d'avant le write-ahead). NE PAS la retirer avant que plus aucun
// registre ancien ne puisse exister sur disque (contract, cf en-tete).
export function serverState(entry) {
  return entry && entry.state === STATE_STARTING ? STATE_STARTING : STATE_READY;
}

// Enregistre/replace le serveur d'un profil (nouveau spawn). Repart d'un jeu de clients vide.
// IMMUTABLE : renvoie un nouveau registre (jamais de mutation en place => pas d'alias traitre).
// ⚠️ `state` vaut READY par DEFAUT (et non STARTING) : ce defaut preserve le sens de tous les appels
// existants. Le write-ahead du superviseur passe STATE_STARTING EXPLICITEMENT — l'intention doit se
// LIRE sur le site d'appel, jamais dependre d'un defaut qu'on pourrait changer par inadvertance.
// ⚠️ DEUX horodatages DISTINCTS, jamais confondus (sinon regression silencieuse) :
//   - `startedAt` = instant du SPAWN (pose par le write-ahead). Sert UNIQUEMENT a decider qu'une
//     entree 'starting' est morte-nee (cf startStalled).
//   - `spawnedAt` = instant de la PROMOTION (serveur prouve pret). Sert UNIQUEMENT a la grace de boot
//     du reaper (cf serverUseful) — MEME SEMANTIQUE ET MEME VALEUR qu'avant le write-ahead.
// Les fusionner raccourcirait la grace de boot de toute la duree du demarrage : un CHANGEMENT de
// comportement, donc interdit. NE JAMAIS faire lire `startedAt` a serverUseful, ni l'inverse.
export function withServer(registry, profile, { port, pid, spawnedAt, startedAt, state = STATE_READY }) {
  return {
    ...registry,
    servers: {
      ...registry.servers,
      [profile]: { port, pid, spawnedAt, startedAt, state, clients: {} },
    },
  };
}

// Promeut une entree 'starting' en 'ready' (le serveur a repondu sur /mcp) et pose `spawnedAt` A CET
// INSTANT — exactement ou l'ancienne version l'ecrivait, donc grace de boot INCHANGEE (bit pour bit).
// PRESERVE le reste de l'entree (port, pid, startedAt, clients deja poses). No-op si aucune entree.
// IDEMPOTENT sur l'etat ; `now` est un PARAMETRE (aucune horloge lue ici : le module reste PUR).
export function promoteServer(registry, profile, now) {
  const s = registry.servers?.[profile];
  if (!s) return registry;
  return {
    ...registry,
    servers: { ...registry.servers, [profile]: { ...s, spawnedAt: now, state: STATE_READY } },
  };
}

// Retire le serveur d'un profil (apres reap ou arret propre).
export function withoutServer(registry, profile) {
  const servers = { ...registry.servers };
  delete servers[profile];
  return { ...registry, servers };
}

// Pose/rafraichit le heartbeat d'un client sur le serveur d'un profil. No-op si aucun serveur connu
// pour ce profil (on ne cree pas de serveur fantome sans pid). IDEMPOTENT : re-appeler avec le meme
// clientId ne cree pas de doublon, il met juste a jour lastSeen.
export function withClient(registry, profile, clientId, now) {
  const s = registry.servers?.[profile];
  if (!s) return registry;
  return {
    ...registry,
    servers: {
      ...registry.servers,
      [profile]: { ...s, clients: { ...s.clients, [clientId]: now } },
    },
  };
}

// Retire un client (proxy qui s'arrete). No-op si serveur/inconnu.
export function withoutClient(registry, profile, clientId) {
  const s = registry.servers?.[profile];
  if (!s) return registry;
  const clients = { ...s.clients };
  delete clients[clientId];
  return {
    ...registry,
    servers: { ...registry.servers, [profile]: { ...s, clients } },
  };
}

// Un serveur est-il encore UTILE ? OUI si au moins un client a battu le coeur dans la fenetre ttl.
// Grace au demarrage : un serveur sans AUCUN client mais spawne il y a moins de ttl est garde
// (fenetre pour que le proxy qui l'a lance s'enregistre) => pas de reap d'un serveur tout neuf.
function serverUseful(s, now, ttl) {
  const stamps = Object.values(s.clients || {});
  if (stamps.length) return stamps.some((t) => now - t <= ttl);
  return typeof s.spawnedAt === 'number' && now - s.spawnedAt <= ttl; // grace de boot
}

// Une entree 'starting' est-elle MORTE-NEE ? OUI passe le budget de readiness : le proxy qui la pollait
// est mort avant de la promouvoir, donc plus personne ne la promouvra JAMAIS (le poll vit en memoire du
// proxy, pas dans le registre). ⚠️ Lit `startedAt` (instant du SPAWN), JAMAIS `spawnedAt` (instant de la
// PROMOTION, reserve a la grace de boot) — les confondre changerait le comportement du reaper.
// `startedAt` non numerique => morte-nee d'office : sans date on ne peut pas prouver qu'elle est jeune,
// et une entree impossible a dater ne doit pas etre gardee pour toujours.
function startStalled(s, now, startStale) {
  return !(typeof s.startedAt === 'number' && now - s.startedAt <= startStale);
}

// DECISION de reap : quels profils dont le serveur doit etre tue/retire.
// PUR : (registry, alivePids[], now, ttl, startStale) => {reap, kept}.
// alivePids = liste des pids REELLEMENT vivants (mesuree par supervisor.js).
// Trois raisons, dans cet ORDRE DE PRIORITE (le premier verdict gagne) :
//   1. 'dead'           — pid mort : prime sur tout le reste, meme un heartbeat frais (le fait I/O
//                         l'emporte toujours sur ce que le registre croit).
//   2. 'stuck-starting' — inscrite au write-ahead mais JAMAIS promue passe le budget : c'est
//                         l'ORPHELIN de l'incident 2026-07-31, desormais visible donc tuable.
//                         ⚠️ Verdict distinct de 'dead' A DESSEIN : un serveur qui n'a jamais demarre
//                         n'est PAS un serveur qui a crashe. Les confondre ferait crier le dead-man
//                         « MORT inopinement » a chaque fermeture de fenetre pendant un boot => bruit,
//                         puis alertes ignorees, puis vraie panne invisible.
//   3. 'idle'           — plus aucun client vivant (hors grace de boot).
// ⚠️ Une 'starting' DANS son budget est GARDEE inconditionnellement (demarrage en cours legitime) :
// la reaper reviendrait a tuer le serveur qu'un autre proxy est en train d'attendre.
// `startStale` par defaut = `ttl` : jamais de garde infinie si un appelant oublie le parametre.
export function reapDecision(registry, alivePids, now, ttl, startStale = ttl) {
  const alive = new Set(alivePids);
  const reap = [];
  let kept = registry;
  for (const [profile, s] of Object.entries(registry.servers || {})) {
    const reason = reapReason(s, alive, now, ttl, startStale);
    if (reason) {
      reap.push({ profile, port: s.port, pid: s.pid, reason });
      kept = withoutServer(kept, profile);
    }
  }
  return { reap, kept };
}

// Verdict pour UNE entree : la raison de la reaper, ou null si elle est gardee.
// Extrait de reapDecision pour que la PRIORITE des raisons soit lisible d'un seul regard.
function reapReason(s, alive, now, ttl, startStale) {
  if (!alive.has(s.pid)) return 'dead';
  if (serverState(s) === STATE_STARTING) return startStalled(s, now, startStale) ? 'stuck-starting' : null;
  return serverUseful(s, now, ttl) ? null : 'idle';
}
