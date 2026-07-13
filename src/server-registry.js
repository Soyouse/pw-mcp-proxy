// server-registry.js — PUR : toute la DECISION du superviseur de serveurs @playwright/mcp HTTP
// partages (quel port, qui est vivant, qui reaper). Isolee de l'I/O (spawn/kill/fetch/fichier vivent
// dans supervisor.js) => passe au crible Stryker + property-based (fast-check).
//
// MODELE : plusieurs proxys (= plusieurs agents Claude) partagent UN serveur @playwright/mcp par
// profil (le persistant = SingletonLock => 1 navigateur, mais N clients HTTP legitimes). Le registre
// (fichier JSON partage) porte l'etat : { servers: { <profil>: { port, pid, spawnedAt, clients } } }
// ou clients = { <clientId>: lastSeenMs } (heartbeat). Un serveur est GARDE tant qu'un client bat le
// coeur < ttl ; sinon il est REAPE (tree-kill + retrait). Tout est fonction pure de (registre, faits).
//
// ⚠️ DETERMINISME du port = RENDEZ-VOUS : deux proxys qui calculent le port du MEME profil DOIVENT
// tomber sur le meme => derivePort est une fonction pure stable du nom de profil. NE PAS y injecter
// d'aleatoire/horodatage (casserait le rendez-vous => 2 serveurs concurrents = SingletonLock viole).

// Plage de ports "utilisateur" volontaire (evite <1024 privilegies et l'ephemere haut). STABLE.
export const PORT_BASE = 9300;
export const PORT_SPAN = 400; // 9300..9699

// Hash FNV-1a 32 bits (deterministe, bonne dispersion, zero dep). Sert UNIQUEMENT au choix de port.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Port DERIVE (point de depart) d'un profil. Deterministe et stable.
export function derivePort(profile, base = PORT_BASE, span = PORT_SPAN) {
  return base + (fnv1a(String(profile)) % span);
}

// Ports actuellement occupes dans le registre (pour eviter les collisions de derivation : 2 profils
// differents peuvent hasher au meme port). Appele UNIQUEMENT quand le profil cible n'a PAS d'entree
// (cf pickPort : court-circuit sur `existing`) => pas besoin d'exclure le profil cible ici.
function portsInUse(registry) {
  const used = new Set();
  for (const s of Object.values(registry.servers || {})) {
    if (s && typeof s.port === 'number') used.add(s.port);
  }
  return used;
}

// Port a viser pour un profil :
//   - si le registre a DEJA une entree pour ce profil => on reutilise SON port (rendez-vous stable) ;
//   - sinon on part du port derive et on sonde lineairement le prochain libre (non pris par un AUTRE
//     profil) => deux profils distincts n'entrent jamais en collision de port.
// PUR : fonction seule de (registry, profile). NE consulte PAS le reseau (le "libre" ici = libre au
// sens du registre ; la contention reseau reelle est geree par supervisor.js via adoption).
export function pickPort(registry, profile, base = PORT_BASE, span = PORT_SPAN) {
  const existing = registry.servers?.[profile];
  if (existing && typeof existing.port === 'number') return existing.port;
  const used = portsInUse(registry);
  let port = derivePort(profile, base, span);
  // sonde bornee a span pour rester dans la plage ; wrap dans [base, base+span).
  for (let i = 0; i < span; i++) {
    if (!used.has(port)) return port;
    port = base + ((port - base + 1) % span);
  }
  return port; // plage saturee (irrealiste) : on rend le derive, supervisor tranchera par adoption.
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

// Enregistre/replace le serveur d'un profil (nouveau spawn). Repart d'un jeu de clients vide.
// IMMUTABLE : renvoie un nouveau registre (jamais de mutation en place => pas d'alias traitre).
export function withServer(registry, profile, { port, pid, spawnedAt }) {
  return {
    ...registry,
    servers: {
      ...registry.servers,
      [profile]: { port, pid, spawnedAt, clients: {} },
    },
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

// DECISION de reap : quels profils dont le serveur doit etre tue/retire.
// Un serveur est reape si son pid est MORT (fait I/O passe via alivePids) OU s'il n'est plus utile
// (aucun client vivant + hors grace de boot). PUR : (registry, alivePids[], now, ttl) => {reap, kept}.
// alivePids = liste des pids REELLEMENT vivants (mesuree par supervisor.js).
export function reapDecision(registry, alivePids, now, ttl) {
  const alive = new Set(alivePids);
  const reap = [];
  let kept = registry;
  for (const [profile, s] of Object.entries(registry.servers || {})) {
    const dead = !alive.has(s.pid);
    const useless = !serverUseful(s, now, ttl);
    if (dead || useless) {
      reap.push({ profile, port: s.port, pid: s.pid, reason: dead ? 'dead' : 'idle' });
      kept = withoutServer(kept, profile);
    }
  }
  return { reap, kept };
}
