// Tests du module PUR server-registry.js (decision du superviseur). Unite + property-based (fast-check).
// Invariants scelles : rendez-vous du port (deterministe), non-collision inter-profils, idempotence
// du heartbeat, CONVERGENCE du reap (rejouer = zero action), monotonie de la vie/mort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(a, b, `rendez-vous stable pour "${p}"`);
    assert.ok(a >= PORT_BASE && a < PORT_BASE + PORT_SPAN, `dans la plage pour "${p}"`);
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
  assert.equal(pickPort(r, 'vegeta'), 9999, 'reprend le port enregistre, pas le derive');
});

test('pickPort : evite le port occupe par un AUTRE profil (non-collision)', () => {
  const derived = derivePort('X');
  let r = emptyRegistry();
  // un autre profil squatte deja le port derive de X
  r = withServer(r, 'other', { port: derived, pid: 1, spawnedAt: 0 });
  const p = pickPort(r, 'X');
  assert.notEqual(p, derived, 'ne rend pas le port deja pris par un autre profil');
  assert.ok(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN);
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
  assert.deepEqual(Object.keys(s.clients), ['c1'], 'un seul client');
  assert.equal(s.clients.c1, 200, 'lastSeen mis a jour');
});

test('withClient : no-op si aucun serveur pour le profil (pas de serveur fantome)', () => {
  const r = emptyRegistry();
  const r2 = withClient(r, 'v', 'c1', 100);
  assert.equal(serverEntry(r2, 'v'), null);
});

test('withoutClient : retire le client sans toucher au serveur', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 100);
  r = withClient(r, 'v', 'c2', 100);
  r = withoutClient(r, 'v', 'c1');
  const s = serverEntry(r, 'v');
  assert.deepEqual(Object.keys(s.clients), ['c2']);
});

// ---------- immutabilite : aucune mutation en place ----------
test('immutabilite : withServer/withClient ne mutent pas l entree source', () => {
  const r0 = emptyRegistry();
  const r1 = withServer(r0, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  const r2 = withClient(r1, 'v', 'c1', 100);
  assert.deepEqual(r0, { servers: {} }, 'r0 intact');
  assert.deepEqual(serverEntry(r1, 'v').clients, {}, 'r1 intact (aucun client injecte a posteriori)');
  assert.equal(serverEntry(r2, 'v').clients.c1, 100);
});

// ---------- reapDecision : mort, idle, grace, CONVERGENCE ----------
test('reapDecision : reape un serveur au pid MORT', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 1000 });
  r = withClient(r, 'v', 'c1', 1000);
  const { reap, kept } = reapDecision(r, [], 1000, 5000); // pid 42 absent des vivants
  assert.equal(reap.length, 1);
  assert.equal(reap[0].reason, 'dead');
  assert.equal(serverEntry(kept, 'v'), null);
});

test('reapDecision : reape un serveur IDLE (dernier heartbeat hors ttl)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 0);
  const { reap } = reapDecision(r, [42], 10000, 5000); // vivant mais heartbeat = 0, now-0 > ttl
  assert.equal(reap.length, 1);
  assert.equal(reap[0].reason, 'idle');
});

test('reapDecision : GARDE un serveur avec heartbeat frais', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  r = withClient(r, 'v', 'c1', 9000);
  const { reap, kept } = reapDecision(r, [42], 10000, 5000); // now-9000=1000 <= ttl
  assert.equal(reap.length, 0);
  assert.ok(serverEntry(kept, 'v'));
});

test('reapDecision : grace de boot (serveur neuf sans client encore) est GARDE', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 9000 }); // spawne il y a 1000
  const { reap } = reapDecision(r, [42], 10000, 5000);
  assert.equal(reap.length, 0, 'fenetre de grace : le proxy lanceur n a pas encore battu le coeur');
});

test('reapDecision : serveur neuf HORS grace (sans client) est reape idle', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 42, spawnedAt: 0 });
  const { reap } = reapDecision(r, [42], 10000, 5000);
  assert.equal(reap.length, 1);
  assert.equal(reap[0].reason, 'idle');
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
  assert.equal(derivePort('vegeta'), 9639);
  assert.equal(derivePort('perso'), 9698);
  assert.equal(derivePort('anon'), 9507);
  assert.equal(derivePort('a'), 9520);
  assert.equal(derivePort(''), 9561);
});

test('reapDecision : borne <= ttl EXACTE (heartbeat pile a la limite = GARDE, +1 = reape)', () => {
  const mk = (hb) => {
    let r = emptyRegistry();
    r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 0 });
    r = withClient(r, 'v', 'c', hb);
    return r;
  };
  // now=1000, ttl=100 : heartbeat=900 => now-hb=100 == ttl => GARDE (<=)
  assert.equal(reapDecision(mk(900), [7], 1000, 100).reap.length, 0, 'pile a la limite = garde');
  // heartbeat=899 => now-hb=101 > ttl => reape idle
  assert.equal(reapDecision(mk(899), [7], 1000, 100).reap.length, 1, 'un cran au-dela = reape');
});

test('reapDecision : borne de GRACE <= ttl EXACTE (spawnedAt pile a la limite = garde)', () => {
  const mk = (sp) => withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, spawnedAt: sp });
  assert.equal(reapDecision(mk(900), [7], 1000, 100).reap.length, 0, 'grace pile a la limite = garde');
  assert.equal(reapDecision(mk(899), [7], 1000, 100).reap.length, 1, 'grace depassee = reape idle');
});

test('reapDecision : pid MORT l emporte sur un heartbeat frais (raison = dead)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 1000 });
  r = withClient(r, 'v', 'c', 1000); // heartbeat parfaitement frais...
  const { reap } = reapDecision(r, [], 1000, 100); // ...mais pid 7 absent des vivants
  assert.equal(reap.length, 1);
  assert.equal(reap[0].reason, 'dead', 'dead prioritaire sur idle');
});

test('pickPort : port non-numerique d un autre profil n est PAS considere occupe', () => {
  // registre brut (bypass withServer) : un autre profil a un port invalide (null)
  const reg = { servers: { other: { port: null, pid: 1, spawnedAt: 0, clients: {} } } };
  assert.equal(pickPort(reg, 'X'), derivePort('X'), 'port null ignore => X garde son port derive');
});

test('pickPort : sonde lineaire quand le port derive ET les suivants sont pris', () => {
  const d = derivePort('Z');
  let r = emptyRegistry();
  r = withServer(r, 'o1', { port: d, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'o2', { port: d + 1, pid: 1, spawnedAt: 0 });
  assert.equal(pickPort(r, 'Z'), d + 2, 'saute les 2 ports pris, prend le 3e');
});

test('reapDecision : reason "idle" quand vivant mais sans client (hors grace)', () => {
  const r = withServer(emptyRegistry(), 'v', { port: 9300, pid: 7, spawnedAt: 0 });
  const { reap } = reapDecision(r, [7], 100000, 100);
  assert.equal(reap[0].reason, 'idle');
});

// chaînage optionnel `registry.servers?.[...]` : sur un registre SANS clef `servers`, ne DOIT pas throw.
test('robustesse : registre sans clef servers ne throw pas (pickPort/serverEntry/withClient/withoutClient)', () => {
  assert.equal(pickPort({}, 'x'), derivePort('x'), 'pickPort tolere l absence de servers');
  assert.equal(serverEntry({}, 'x'), null);
  assert.deepEqual(withClient({}, 'x', 'c', 1), {}, 'withClient no-op (aucun serveur)');
  assert.deepEqual(withoutClient({}, 'x', 'c'), {}, 'withoutClient no-op (aucun serveur)');
});

test('pickPort : sans entree pour le profil => port derive exact', () => {
  assert.equal(pickPort(emptyRegistry(), 'vegeta'), 9639, 'pas d entree => derive, pas undefined.port');
});

test('withServer : PRESERVE les autres profils (pas un objet vide)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'a', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'b', { port: 9301, pid: 2, spawnedAt: 0 });
  assert.ok(serverEntry(r, 'a'), 'a conserve apres ajout de b');
  assert.ok(serverEntry(r, 'b'), 'b present');
  assert.equal(serverEntry(r, 'a').port, 9300);
});

test('withoutClient : sur un profil SANS serveur => registre inchange (garde !s)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 1, spawnedAt: 0 });
  const r2 = withoutClient(r, 'absent', 'c'); // profil 'absent' n a pas de serveur
  assert.deepEqual(r2, r, 'no-op exact');
});

test('portsInUse : entree null d un autre profil ne throw pas et n occupe rien', () => {
  const reg = { servers: { dead: null } }; // entree corrompue (null)
  assert.equal(pickPort(reg, 'x'), derivePort('x'), 'null ignore, pas de throw');
});

test('pickPort : entree du profil avec port NON-numerique => retombe sur le port derive (numerique)', () => {
  const reg = { servers: { v: { port: 'oops', pid: 1, spawnedAt: 0, clients: {} } } };
  const p = pickPort(reg, 'v');
  assert.equal(typeof p, 'number', 'port non-numerique ignore : on derive un vrai port');
  assert.equal(p, derivePort('v'));
});

test('withoutServer : PRESERVE les autres profils (retire seulement la cible)', () => {
  let r = emptyRegistry();
  r = withServer(r, 'a', { port: 9300, pid: 1, spawnedAt: 0 });
  r = withServer(r, 'b', { port: 9301, pid: 2, spawnedAt: 0 });
  const r2 = withoutServer(r, 'a');
  assert.equal(serverEntry(r2, 'a'), null, 'a retire');
  assert.ok(serverEntry(r2, 'b'), 'b conserve');
});

test('serverUseful : grace exige spawnedAt NUMERIQUE (spawnedAt null => reape meme si now<=ttl)', () => {
  const reg = { servers: { v: { port: 9300, pid: 7, spawnedAt: null, clients: {} } } };
  const { reap } = reapDecision(reg, [7], 50, 100); // now=50 <= ttl=100, mais spawnedAt null => pas de grace
  assert.equal(reap.length, 1, 'spawnedAt non-numerique => aucune grace => reape idle');
  assert.equal(reap[0].reason, 'idle');
});

test('serverUseful : some (PAS every) — un client frais suffit meme si un autre est perime', () => {
  let r = emptyRegistry();
  r = withServer(r, 'v', { port: 9300, pid: 7, spawnedAt: 0 });
  r = withClient(r, 'v', 'stale', 0); // perime
  r = withClient(r, 'v', 'fresh', 9999); // frais
  const { reap } = reapDecision(r, [7], 10000, 100); // now=10000, ttl=100 : fresh a 1 <= ttl
  assert.equal(reap.length, 0, 'un seul client frais garde le serveur (some, pas every)');
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
