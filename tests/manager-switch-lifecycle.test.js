// CYCLE DE VIE DU POOL AU `switch_profile` — contrat de frontiere router <-> manager <-> transport.
//
// ⚠️ NE PAS SUPPRIMER : ce fichier est ne de l'incident LIVE du 2026-08-02 07:15 (boucle de spawn,
// un serveur @playwright/mcp + son Chrome relances toutes les ~15 s jusqu'a saturation machine).
//
// CHAINE DE LA PANNE (mesuree dans pw-mcp-proxy.log) :
//   switch A->B  =>  supervisor.unregisterClient(A)  =>  reap du serveur A « idle » (LEGITIME :
//   plus aucun client)  MAIS le backend A reste dans le pool avec son transport HTTP VIVANT
//   =>  ce transport tape dans le vide (ECONNREFUSED)  =>  backend A exited
//   =>  « purge du cadavre + respawn »  =>  nouveau serveur pour un profil INACTIF  =>  boucle.
//
// POURQUOI 327 TESTS N'ONT RIEN VU : les 5 tests de `switch_profile` existants verifient tous
// l'EFFET VOULU (le nouveau profil repond, tools/list est a jour) ; AUCUN ne demandait ce que
// devient l'ANCIEN. Biais systematique — on testait ce qu'on veut voir arriver, jamais l'effet de bord.
//
// ⚠️ L'invariant du bas est N-INDEPENDANT et teste jusqu'a 30 profils : le nombre d'identites est
// DYNAMIQUE et NON BORNE (projet open source, config de l'utilisateur inconnue). Un test ecrit a
// 2 profils ne prouve RIEN sur la machine d'un utilisateur qui en declare 20.
//
// Transport factice en memoire : AUCUN process reel, pas de harness requis, deterministe.

import { test, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/manager.js';

// Transport factice : repond a initialize, retient s'il a ete ferme. `open` = ce que le vrai
// HttpTransport maintient reellement (session HTTP + flux GET SSE persistant vers le serveur).
class FakeTransport extends EventEmitter {
  constructor(profile) {
    super();
    this.profile = profile;
    this.spec = { command: 'x', args: [] };
    this.closed = false;
  }
  async start() {}
  get open() { return !this.closed; }
  send(msg) {
    if (this.closed) return;
    if (msg.method === 'initialize') {
      queueMicrotask(() =>
        this.emit('message', {
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } },
        })
      );
    }
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}

// Config a N profils : reproduit le cas open source (l'utilisateur en declare autant qu'il veut).
function tmpCfgPath(n) {
  const profiles = {};
  for (let i = 0; i < n; i++) profiles[`p${i}`] = { label: `P${i}` };
  const p = path.join(
    os.tmpdir(),
    `pw-mcp-switch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(p, JSON.stringify({ defaultProfile: 'p0', profiles }));
  return p;
}

// Monte un Manager dont les transports sont factices et tracables.
function newManager(n) {
  const cfgPath = tmpCfgPath(n);
  const transports = new Map(); // profil -> [transports crees, du plus ancien au plus recent]
  const manager = new Manager(cfgPath, { watchdog: { pingIntervalMs: 0 } }); // watchdog OFF : on teste le pool
  manager._makeTransport = async (profile) => {
    const t = new FakeTransport(profile);
    if (!transports.has(profile)) transports.set(profile, []);
    transports.get(profile).push(t);
    return t;
  };
  return { manager, transports, cfgPath };
}

// Le SEUL chemin de bascule legitime — celui qu'emprunte router._handleSwitch.
// ⚠️ NE PAS remplacer par `get(t)` + `manager.activeProfile = t` : c'est precisement l'ancien
// chemin bugge (aucune liberation de l'ancien profil). Le gate `no-direct-active-profile-gate`
// interdit desormais cette forme dans src/ ; ici on teste le contrat, pas sa contrefacon.
async function doSwitch(manager, target) {
  await manager.setActiveProfile(target);
}

// Tous les transports encore OUVERTS, tous profils confondus.
function openTransports(transports) {
  const out = [];
  for (const [profile, list] of transports) for (const t of list) if (t.open) out.push({ profile, t });
  return out;
}

let ctx;
beforeEach(() => { ctx = null; });
afterEach(() => {
  if (!ctx) return;
  ctx.manager.stopAll();
  try { fs.unlinkSync(ctx.cfgPath); } catch {}
});

test('switch A->B : le transport de l ANCIEN profil est FERME (sinon il tape dans un serveur reape)', async () => {
  ctx = newManager(2);
  const { manager, transports } = ctx;

  await doSwitch(manager, 'p0');
  await doSwitch(manager, 'p1');

  const t0 = transports.get('p0')[0];
  // ⚠️ C'EST LA PANNE DU 02/08 : ce transport reste ouvert alors que le serveur p0 vient d'etre
  // reape (plus aucun client). Il tape dans le vide, le backend meurt, le manager respawn => boucle.
  expect(t0.open, 'le transport du profil quitte doit etre FERME au switch').toBe(false);
});

test('switch A->B->A : le retour ne laisse aucun transport orphelin ouvert', async () => {
  ctx = newManager(2);
  const { manager, transports } = ctx;

  await doSwitch(manager, 'p0');
  await doSwitch(manager, 'p1');
  await doSwitch(manager, 'p0');

  const open = openTransports(transports);
  expect(open.length, `un seul transport ouvert attendu, trouve ${open.map((o) => o.profile).join(',')}`).toBe(1);
  expect(open[0].profile).toBe('p0');
});

// ⚠️ INVARIANT SYSTEME — le filet generique. Il n'enumere aucun scenario : il affirme une propriete
// VRAIE APRES N'IMPORTE QUELLE SEQUENCE. C'est ce qui attrape les boucles qu'on n'a pas imaginees
// (celle du 02/08 en fait partie), et il vaut a 2 profils comme a 30.
test('INVARIANT (N profils, sequence quelconque) : au plus UN transport ouvert, celui du profil ACTIF', async () => {
  await fc.assert(
    fc.asyncProperty(
      // N ∈ [1,30] : le nombre d'identites est NON BORNE cote utilisateur (projet open source).
      fc.integer({ min: 1, max: 30 }).chain((n) =>
        fc.record({
          n: fc.constant(n),
          seq: fc.array(fc.integer({ min: 0, max: n - 1 }), { minLength: 1, maxLength: 40 }),
        })
      ),
      async ({ n, seq }) => {
        const local = newManager(n);
        try {
          for (const i of seq) await doSwitch(local.manager, `p${i}`);

          const open = openTransports(local.transports);
          // Propriete 1 : jamais plus d'un transport vivant, quel que soit N et la longueur de la sequence.
          expect(open.length).toBe(1);
          // Propriete 2 : c'est bien celui du profil actif (pas un rescape d'un tour precedent).
          expect(open[0].profile).toBe(local.manager.activeProfile);
        } finally {
          local.manager.stopAll();
          try { fs.unlinkSync(local.cfgPath); } catch {}
        }
      }
    ),
    // Sequences courtes et en memoire : 40 runs suffisent a couvrir N petit ET N grand.
    { numRuns: 40 }
  );
}, 60000);
