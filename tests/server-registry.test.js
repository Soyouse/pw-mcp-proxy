// Tests du module PUR server-registry.js (decision du superviseur). Unite + property-based (fast-check).
// Invariants scelles : rendez-vous du port (deterministe), non-collision inter-profils, idempotence
// du heartbeat, CONVERGENCE du reap (rejouer = zero action), monotonie de la vie/mort.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  pickPort,
  emptyRegistry,
  serverEntry,
  withServer,
  withoutServer,
  withClient,
  withoutClient,
  reapDecision,
  promoteServer,
  serverState,
  STATE_STARTING,
  STATE_READY,
} from '../src/server-registry.js';

// ---------- pickPort : LE RENDEZ-VOUS des agents (registre), port neuf sinon ----------
// ⚠️ Ces tests scellent la refonte du 2026-07-31 : le port n'est PLUS calcule a partir du nom de profil.
// L'ancien schema (hash deterministe) rendait un profil DEFINITIVEMENT inutilisable des qu'un seul
// numero devenait injoignable sur la machine (incident du 31/07, port 9639 redirige par un driver).
// Ce qui compte — et que ces tests protegent — c'est que le rendez-vous entre agents passe par le
// REGISTRE : un agent qui arrive doit tomber sur le serveur des autres, jamais en lancer un second.
test('pickPort : reutilise le port du serveur existant — C EST le rendez-vous multi-agent', () => {
  let r = emptyRegistry();
  r = withServer(r, 'vegeta', { port: 9999, pid: 1, spawnedAt: 0 });
  // ⚠️ Tueur de mutant : le port frais est VOLONTAIREMENT different. Si pickPort le prefererait a
  // l'entree du registre, chaque agent lancerait SON serveur => SingletonLock viole => « browser is
  // already in use » sur profil persistant. C'est la regression la plus grave possible ici.
  expect(pickPort(r, 'vegeta', 4242), 'l entree du registre PRIME sur tout port neuf').toBe(9999);
});

test('pickPort : aucune entree => le port ALLOUE PAR L OS, tel quel (zero calcul)', () => {
  expect(pickPort(emptyRegistry(), 'vegeta', 51234), 'rend le port fourni, sans le transformer').toBe(51234);
});

test('property : sans entree, pickPort rend EXACTEMENT le port alloue (fonction totale)', () => {
  fc.assert(
    fc.property(fc.string(), fc.integer({ min: 1, max: 65535 }), (profile, fresh) => {
      // Aucune arithmetique cachee, aucune plage imposee : le port vient de l'OS, on ne le corrige pas.
      // ⚠️ Toute "amelioration" qui deciderait du port ici (sonde, offset, plage) reintroduirait la
      // panne du 31/07 — le proxy ne doit JAMAIS choisir un numero.
      return pickPort(emptyRegistry(), profile, fresh) === fresh;
    })
  );
});

test('property : une entree existante gagne TOUJOURS, quel que soit le port propose', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.integer({ min: 1, max: 65535 }),
      fc.integer({ min: 1, max: 65535 }),
      (profile, enregistre, fresh) => {
        const r = withServer(emptyRegistry(), profile, { port: enregistre, pid: 1, spawnedAt: 0 });
        return pickPort(r, profile, fresh) === enregistre;
      }
    )
  );
});

test('pickPort : entree du profil au port NON-numerique => retombe sur le port alloue', () => {
  // Entree corrompue/partielle (registre ecrit par une version cassee, disque abime) : on ne propage
  // JAMAIS un port invalide dans un spawn — on repart d'un port neuf, valide par construction.
  const reg = { servers: { v: { port: null, pid: 1, spawnedAt: 0, clients: {} } } };
  expect(pickPort(reg, 'v', 55555)).toBe(55555);
});

test('robustesse : registre sans clef servers ne throw pas (pickPort/serverEntry)', () => {
  expect(pickPort({}, 'x', 6001), 'pickPort tolere l absence de servers').toBe(6001);
  expect(serverEntry({}, 'x')).toBeNull();
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
          r = withServer(r, prof, { port: 9300 + i, pid: s.pid, spawnedAt: s.spawnedAt });
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

test('reapDecision : reason "idle" quand vivant mais sans client (hors grace)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, spawnedAt: 0 });
  const { reap } = reapDecision(r, [7], 100000, 100);
  expect(reap[0].reason).toBe('idle');
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

// ---------- WRITE-AHEAD : etat 'starting' (incident 2026-07-31) ----------
// ⚠️ AJOUTE PAR /stack-audit : les property existantes ne creaient QUE des entrees 'ready'
// (withServer par defaut) => le nouvel etat n'etait visite par AUCUNE property. Un mutant sur
// `startStalled` ou sur la priorite des verdicts aurait donc SURVECU en silence.

test('serverState : absent/inconnu = READY (retro-compat), seul "starting" fait STARTING', () => {
  expect(serverState({}), 'champ absent = registre de la version precedente').toBe(STATE_READY);
  expect(serverState(null)).toBe(STATE_READY);
  expect(serverState({ state: 'nimportequoi' })).toBe(STATE_READY);
  expect(serverState({ state: STATE_STARTING })).toBe(STATE_STARTING);
});

test('promoteServer : pose spawnedAt A LA PROMOTION et PRESERVE startedAt/clients', () => {
  let r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, startedAt: 100, state: STATE_STARTING });
  r = withClient(r, 'v', 'c', 150);
  const p = promoteServer(r, 'v', 500);
  const s = serverEntry(p, 'v');
  expect(serverState(s)).toBe(STATE_READY);
  expect(s.spawnedAt, 'spawnedAt = instant de la PROMOTION (grace de boot inchangee)').toBe(500);
  expect(s.startedAt, 'startedAt PRESERVE').toBe(100);
  expect(s.clients.c, 'clients preserves').toBe(150);
  expect(promoteServer(emptyRegistry(), 'absent', 1), 'no-op si aucune entree').toEqual(emptyRegistry());
});

test('reapDecision : "starting" DANS le budget est GARDEE (demarrage en cours legitime)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, startedAt: 900, state: STATE_STARTING });
  expect(reapDecision(r, [7], 1000, 100, 100).reap.length, 'pile a la limite = gardee').toBe(0);
});

test('reapDecision : "starting" HORS budget => stuck-starting (JAMAIS dead ni idle)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, startedAt: 899, state: STATE_STARTING });
  const { reap } = reapDecision(r, [7], 1000, 100, 100);
  expect(reap.length).toBe(1);
  expect(reap[0].reason, 'n a jamais demarre != a crashe').toBe('stuck-starting');
});

test('reapDecision : pid MORT prime sur stuck-starting (le fait I/O gagne toujours)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, startedAt: 0, state: STATE_STARTING });
  expect(reapDecision(r, [], 100000, 100, 100).reap[0].reason).toBe('dead');
});

test('reapDecision : "starting" sans startedAt NUMERIQUE = morte-nee (jamais gardee a vie)', () => {
  const reg = { servers: { v: { port: 9300, pid: 7, startedAt: null, state: STATE_STARTING, clients: {} } } };
  expect(reapDecision(reg, [7], 50, 100000, 100000).reap[0].reason).toBe('stuck-starting');
});

test('property : reapDecision CONVERGE aussi avec des entrees "starting" melangees', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          pid: fc.integer({ min: 1, max: 30 }),
          startedAt: fc.integer({ min: 0, max: 10000 }),
          spawnedAt: fc.integer({ min: 0, max: 10000 }),
          starting: fc.boolean(),
          heartbeats: fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 3 }),
        }),
        { maxLength: 6 }
      ),
      fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 10 }),
      fc.integer({ min: 0, max: 20000 }),
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 1, max: 5000 }),
      (specs, alive, now, ttl, startStale) => {
        let r = emptyRegistry();
        specs.forEach((s, i) => {
          const prof = 'p' + i;
          r = withServer(r, prof, {
            port: 9300 + i, pid: s.pid, spawnedAt: s.spawnedAt, startedAt: s.startedAt,
            state: s.starting ? STATE_STARTING : STATE_READY,
          });
          s.heartbeats.forEach((h, j) => (r = withClient(r, prof, 'c' + j, h)));
        });
        const first = reapDecision(r, alive, now, ttl, startStale);
        const second = reapDecision(first.kept, alive, now, ttl, startStale);
        return second.reap.length === 0; // convergence : rejouer ne reape plus rien
      }
    )
  );
});

test('property : une entree GARDEE est soit ready-utile, soit starting-dans-le-budget — jamais autre', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }), fc.integer({ min: 0, max: 10000 }), fc.boolean(),
      fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 8 }),
      fc.integer({ min: 0, max: 20000 }), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }),
      (pid, t, starting, alive, now, ttl, startStale) => {
        let r = withServer(emptyRegistry(), 'v', {
          port: 9300, pid, spawnedAt: t, startedAt: t, state: starting ? STATE_STARTING : STATE_READY,
        });
        const { kept } = reapDecision(r, alive, now, ttl, startStale);
        if (!serverEntry(kept, 'v')) return true; // reapee : rien a prouver
        if (!new Set(alive).has(pid)) return false; // un pid mort ne DOIT jamais etre garde
        return starting ? now - t <= startStale : now - t <= ttl;
      }
    )
  );
});
