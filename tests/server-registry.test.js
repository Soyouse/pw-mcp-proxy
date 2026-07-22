// Tests du module PUR server-registry.js (decision du superviseur). Unite + property-based (fast-check).
// Invariants scelles : rendez-vous du port (deterministe), non-collision inter-profils, idempotence
// du heartbeat, CONVERGENCE du reap (rejouer = zero action), monotonie de la vie/mort.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  derivePort,
  pickPort,
  emptyRegistry,
  serverEntry,
  withServer,
  withoutServer,
  withClient,
  withoutClient,
  reapDecision,
  PORT_BASE,
  PORT_SPAN,
} from '../src/server-registry.js';

// ---------- derivePort : deterministe + dans la plage ----------
test('derivePort : deterministe (meme profil => meme port) et dans [BASE, BASE+SPAN)', () => {
  for (const p of ['vegeta', 'perso', 'anon', 'a', '']) {
    const a = derivePort(p);
    const b = derivePort(p);
    expect(a, `rendez-vous stable pour "${p}"`).toBe(b);
    expect(a >= PORT_BASE && a < PORT_BASE + PORT_SPAN, `dans la plage pour "${p}"`).toBeTruthy();
  }
});

test('property : derivePort toujours dans la plage, jamais NaN, deterministe', () => {
  fc.assert(
    fc.property(fc.string(), (p) => {
      const a = derivePort(p);
      return Number.isInteger(a) && a >= PORT_BASE && a < PORT_BASE + PORT_SPAN && a === derivePort(p);
    })
  );
});

// ---------- pickPort : rendez-vous si serveur connu, sinon libre ----------
test('pickPort : reutilise le port du serveur existant (rendez-vous)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'vegeta', { port: 9999, pid: 1, spawnedAt: 0 });
  expect(pickPort(r, 'vegeta'), 'reprend le port enregistre, pas le derive').toBe(9999);
});

test('pickPort : evite le port occupe par un AUTRE profil (non-collision)', () => {
  const derived = derivePort('X');
  let r = emptyRegistry();
  // un autre profil squatte deja le port derive de X
  r = withServer(r, 'other', { port: derived, pid: 1, spawnedAt: 0 });
  const p = pickPort(r, 'X');
  expect(p, 'ne rend pas le port deja pris par un autre profil').not.toBe(derived);
  expect(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN).toBeTruthy();
});

test('property : pickPort ne rend jamais un port occupe par un autre profil', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.string({ minLength: 1 }), fc.integer({ min: PORT_BASE, max: PORT_BASE + PORT_SPAN - 1 })), { maxLength: 8 }),
      fc.string({ minLength: 1 }),
      (entries, target) => {
        let r = emptyRegistry();
        for (const [name, port] of entries) if (name !== target) r = withServer(r, name, { port, pid: 1, spawnedAt: 0 });
        const chosen = pickPort(r, target);
        // si le registre a une entree pour target on la reutilise ; sinon le port choisi est libre
        if (serverEntry(r, target)) return true;
        const usedByOthers = new Set(Object.entries(r.servers).filter(([n]) => n !== target).map(([, s]) => s.port));
        // tolere la saturation (fallback documente) : seulement quand toute la plage est prise
        return !usedByOthers.has(chosen) || usedByOthers.size >= PORT_SPAN;
      }
    )
  );
});

// ---------- heartbeat : idempotent, ajout/retrait ----------
test('withClient : idempotent (meme clientId => maj lastSeen, pas de doublon)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 100);
  r = withClient(r, 'v', 'c1', 200);
  const s = serverEntry(r, 'v');
  expect(Object.keys(s.clients), 'un seul client').toEqual(['c1']);
  expect(s.clients.c1, 'lastSeen mis a jour').toBe(200);
});

test('withClient : no-op si aucun serveur pour le profil (pas de serveur fantome)', () => {
  const r = emptyRegistry();
  const r2 = withClient(r, 'v', 'c1', 100);
  expect(serverEntry(r2, 'v')).toBe(null);
});

test('withoutClient : retire le client sans toucher au serveur', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 100);
  r = withClient(r, 'v', 'c2', 100);
  r = withoutClient(r, 'v', 'c1');
  const s = serverEntry(r, 'v');
  expect(Object.keys(s.clients)).toEqual(['c2']);
});

// ---------- immutabilite : aucune mutation en place ----------
test('immutabilite : withServer/withClient ne mutent pas l entree source', () => {
  const r0 = emptyRegistry();
  const r1 = withServer(r0, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  const r2 = withClient(r1, 'v', 'c1', 100);
  expect(r0, 'r0 intact').toEqual({ servers: {} });
  expect(serverEntry(r1, 'v').clients, 'r1 intact (aucun client injecte a posteriori)').toEqual({});
  expect(serverEntry(r2, 'v').clients.c1).toBe(100);
});

// ---------- reapDecision : mort, idle, grace, CONVERGENCE ----------
test('reapDecision : reape un serveur au pid MORT', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 1000 });
  r = withClient(r, 'v', 'c1', 1000);
  const { reap, kept } = reapDecision(r, [], 1000, 5000); // pid 42 absent des vivants
  expect(reap.length).toBe(1);
  expect(reap[0].reason).toBe('dead');
  expect(serverEntry(kept, 'v')).toBe(null);
});

test('reapDecision : reape un serveur IDLE (dernier heartbeat hors ttl)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 0);
  const { reap } = reapDecision(r, [42], 10000, 5000); // vivant mais heartbeat = 0, now-0 > ttl
  expect(reap.length).toBe(1);
  expect(reap[0].reason).toBe('idle');
});

test('reapDecision : GARDE un serveur avec heartbeat frais', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 9000);
  const { reap, kept } = reapDecision(r, [42], 10000, 5000); // now-9000=1000 <= ttl
  expect(reap.length).toBe(0);
  expect(serverEntry(kept, 'v')).toBeTruthy();
});

test('reapDecision : grace de boot (serveur neuf sans client encore) est GARDE', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 9000 }); // spawne il y a 1000
  const { reap } = reapDecision(r, [42], 10000, 5000);
  expect(reap.length, 'fenetre de grace : le proxy lanceur n a pas encore battu le coeur').toBe(0);
});

test('reapDecision : serveur neuf HORS grace (sans client) est reape idle', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  const { reap } = reapDecision(r, [42], 10000, 5000);
  expect(reap.length).toBe(1);
  expect(reap[0].reason).toBe('idle');
});

test('property : reapDecision CONVERGE (rejouer sur kept => zero reap)', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          profile: fc.string({ minLength: 1 }),
          pid: fc.integer({ min: 1, max: 50 }),
          spawnedAt: fc.integer({ min: 0, max: 10000 }),
          heartbeats: fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 4 }),
        }),
        { maxLength: 6 }
      ),
      fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 10 }),
      fc.integer({ min: 0, max: 20000 }),
      fc.integer({ min: 1, max: 5000 }),
      (specs, alive, now, ttl) => {
        let r = emptyRegistry();
        specs.forEach((s, i) => {
          const prof = s.profile + i; // profils uniques
          r = withServer(r, prof, { port: PORT_BASE + i, pid: s.pid, spawnedAt: s.spawnedAt });
          s.heartbeats.forEach((h, j) => (r = withClient(r, prof, 'c' + j, h)));
        });
        const first = reapDecision(r, alive, now, ttl);
        const second = reapDecision(first.kept, alive, now, ttl);
        // convergence : apres avoir retire les reapes, plus rien a reaper aux memes conditions
        return second.reap.length === 0;
      }
    )
  );
});

// ---------- tueurs de mutants (Stryker) : valeurs EXACTES + bornes ----------
// Epingle le hash FNV-1a : toute mutation d'une constante/operateur du hash change ces ports => ROUGE.
// (Valeurs scellees ; si PORT_BASE/SPAN change volontairement, ces attendus changent AVEC.)
test('derivePort : valeurs EXACTES scellees (epingle le hash contre les mutations)', () => {
  expect(derivePort('vegeta')).toBe(9639);
  expect(derivePort('perso')).toBe(9698);
  expect(derivePort('anon')).toBe(9507);
  expect(derivePort('a')).toBe(9520);
  expect(derivePort('')).toBe(9561);
});

test('reapDecision : borne <= ttl EXACTE (heartbeat pile a la limite = GARDE, +1 = reape)', () => {
  const mk = (hb) => {
    let r = emptyRegistry();
    r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 0 });
    r = withClient(r, 'v', 'c', hb);
    return r;
  };
  // now=1000, ttl=100 : heartbeat=900 => now-hb=100 == ttl => GARDE (<=)
  expect(reapDecision(mk(900), [7], 1000, 100).reap.length, 'pile a la limite = garde').toBe(0);
  // heartbeat=899 => now-hb=101 > ttl => reape idle
  expect(reapDecision(mk(899), [7], 1000, 100).reap.length, 'un cran au-dela = reape').toBe(1);
});

test('reapDecision : borne de GRACE <= ttl EXACTE (spawnedAt pile a la limite = garde)', () => {
  const mk = (sp) => withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, spawnedAt: sp });
  expect(reapDecision(mk(900), [7], 1000, 100).reap.length, 'grace pile a la limite = garde').toBe(0);
  expect(reapDecision(mk(899), [7], 1000, 100).reap.length, 'grace depassee = reape idle').toBe(1);
});

test('reapDecision : pid MORT l emporte sur un heartbeat frais (raison = dead)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 1000 });
  r = withClient(r, 'v', 'c', 1000); // heartbeat parfaitement frais...
  const { reap } = reapDecision(r, [], 1000, 100); // ...mais pid 7 absent des vivants
  expect(reap.length).toBe(1);
  expect(reap[0].reason, 'dead prioritaire sur idle').toBe('dead');
});

test('pickPort : port non-numerique d un autre profil n est PAS considere occupe', () => {
  // registre brut (bypass withServer) : un autre profil a un port invalide (null)
  const reg = { servers: { other: { port: null, pid: 1, spawnedAt: 0, clients: {} } } };
  expect(pickPort(reg, 'X'), 'port null ignore => X garde son port derive').toBe(derivePort('X'));
});

test('pickPort : sonde lineaire quand le port derive ET les suivants sont pris', () => {
  const d = derivePort('Z');
  let r = emptyRegistry();
  r = withServer(r, 'o1', { port: d, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'o2', { port: d + 1, pid: 1, spawnedAt: 0 });
  expect(pickPort(r, 'Z'), 'saute les 2 ports pris, prend le 3e').toBe(d + 2);
});

test('reapDecision : reason "idle" quand vivant mais sans client (hors grace)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, spawnedAt: 0 });
  const { reap } = reapDecision(r, [7], 100000, 100);
  expect(reap[0].reason).toBe('idle');
});

// chaînage optionnel `registry.servers?.[...]` : sur un registre SANS clef `servers`, ne DOIT pas throw.
test('robustesse : registre sans clef servers ne throw pas (pickPort/serverEntry/withClient/withoutClient)', () => {
  expect(pickPort({}, 'x'), 'pickPort tolere l absence de servers').toBe(derivePort('x'));
  expect(serverEntry({}, 'x')).toBe(null);
  expect(withClient({}, 'x', 'c', 1), 'withClient no-op (aucun serveur)').toEqual({});
  expect(withoutClient({}, 'x', 'c'), 'withoutClient no-op (aucun serveur)').toEqual({});
});

test('pickPort : sans entree pour le profil => port derive exact', () => {
  expect(pickPort(emptyRegistry(), 'vegeta'), 'pas d entree => derive, pas undefined.port').toBe(9639);
});

test('withServer : PRESERVE les autres profils (pas un objet vide)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'a', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'b', { port: 9301, pid: 2, spawnedAt: 0 });
  expect(serverEntry(r, 'a'), 'a conserve apres ajout de b').toBeTruthy();
  expect(serverEntry(r, 'b'), 'b present').toBeTruthy();
  expect(serverEntry(r, 'a').port).toBe(9300);
});

test('withoutClient : sur un profil SANS serveur => registre inchange (garde !s)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  const r2 = withoutClient(r, 'absent', 'c'); // profil 'absent' n a pas de serveur
  expect(r2, 'no-op exact').toEqual(r);
});

test('portsInUse : entree null d un autre profil ne throw pas et n occupe rien', () => {
  const reg = { servers: { dead: null } }; // entree corrompue (null)
  expect(pickPort(reg, 'x'), 'null ignore, pas de throw').toBe(derivePort('x'));
});

test('pickPort : entree du profil avec port NON-numerique => retombe sur le port derive (numerique)', () => {
  const reg = { servers: { v: { port: 'oops', pid: 1, spawnedAt: 0, clients: {} } } };
  const p = pickPort(reg, 'v');
  expect(typeof p, 'port non-numerique ignore : on derive un vrai port').toBe('number');
  expect(p).toBe(derivePort('v'));
});

test('withoutServer : PRESERVE les autres profils (retire seulement la cible)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'a', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'b', { port: 9301, pid: 2, spawnedAt: 0 });
  const r2 = withoutServer(r, 'a');
  expect(serverEntry(r2, 'a'), 'a retire').toBe(null);
  expect(serverEntry(r2, 'b'), 'b conserve').toBeTruthy();
});

test('serverUseful : grace exige spawnedAt NUMERIQUE (spawnedAt null => reape meme si now<=ttl)', () => {
  const reg = { servers: { v: { port: 9300, pid: 7, spawnedAt: null, clients: {} } } };
  const { reap } = reapDecision(reg, [7], 50, 100); // now=50 <= ttl=100, mais spawnedAt null => pas de grace
  expect(reap.length, 'spawnedAt non-numerique => aucune grace => reape idle').toBe(1);
  expect(reap[0].reason).toBe('idle');
});

test('serverUseful : some (PAS every) — un client frais suffit meme si un autre est perime', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 0 });
  r = withClient(r, 'v', 'stale', 0); // perime
  r = withClient(r, 'v', 'fresh', 9999); // frais
  const { reap } = reapDecision(r, [7], 10000, 100); // now=10000, ttl=100 : fresh a 1 <= ttl
  expect(reap.length, 'un seul client frais garde le serveur (some, pas every)').toBe(0);
});

test('property : un serveur garde est TOUJOURS soit vivant-de-pid soit en grace/heartbeat frais', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 0, max: 10000 }),
      fc.array(fc.integer({ min: 0, max: 20000 }), { maxLength: 3 }),
      fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 8 }),
      fc.integer({ min: 0, max: 20000 }),
      fc.integer({ min: 1, max: 5000 }),
      (pid, spawnedAt, heartbeats, alive, now, ttl) => {
        let r = emptyRegistry();
        r = withServer(r, 'v', { port: 9300, pid, spawnedAt });
        heartbeats.forEach((h, j) => (r = withClient(r, 'v', 'c' + j, h)));
        const { kept } = reapDecision(r, alive, now, ttl);
        if (!serverEntry(kept, 'v')) return true; // reape : rien a prouver
        const aliveSet = new Set(alive);
        const fresh = heartbeats.some((h) => now - h <= ttl);
        const grace = heartbeats.length === 0 && now - spawnedAt <= ttl;
        return aliveSet.has(pid) && (fresh || grace);
      }
    )
  );
});
