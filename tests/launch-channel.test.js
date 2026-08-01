// INTEGRATION (I/O reelle, hors Stryker) — canal de lancement.
// Teste contre le VRAI noyau : c'est lui l'autorite, un faux `net` ne prouverait rien.
//
// ⚠️ Aucun `setTimeout` dans ces tests : si un scenario avait besoin d'attendre « un peu »,
//    c'est que le code sous test inferrerait au lieu d'observer. L'absence de delai ICI est
//    une PREUVE de la propriete qu'on cherche.

import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLaunchChannel } from '../src/launch-channel.js';
import { channelName } from '../src/channel-name.js';

// Profil UNIQUE par test : deux tests qui partagent un canal se contamineraient
// (meme piege que l'isolation de port du supervisor, corrige le 22/07).
let n = 0;
const uniq = () => `test-lc-${process.pid}-${++n}`;

const opened = [];
afterEach(() => {
  while (opened.length) {
    const h = opened.pop();
    try { h.close(); } catch { /* deja ferme */ }
  }
});

function keep(h) {
  opened.push(h);
  return h;
}

test('premier arrivant = LANCEUR (le noyau le designe, personne ne le devine)', async () => {
  const h = keep(await acquireLaunchChannel(uniq()));
  expect(h.role).toBe('leader');
});

test('second arrivant = SUIVEUR et recoit le port publie', async () => {
  const profile = uniq();
  const leader = keep(await acquireLaunchChannel(profile));
  expect(leader.role).toBe('leader');

  // Le suiveur se connecte AVANT la publication : il doit etre servi des qu'elle arrive.
  const pending = acquireLaunchChannel(profile);
  leader.publish(54321);

  const follower = await pending;
  expect(follower.role).toBe('follower');
  expect(follower.port).toBe(54321);
});

test('suiveur arrive APRES la publication : servi immediatement', async () => {
  const profile = uniq();
  const leader = keep(await acquireLaunchChannel(profile));
  leader.publish(4242);

  const follower = await acquireLaunchChannel(profile);
  expect(follower).toEqual({ role: 'follower', port: 4242 });
});

test('N suiveurs concurrents recoivent TOUS le meme port (multi-agent)', async () => {
  const profile = uniq();
  const leader = keep(await acquireLaunchChannel(profile));

  const followers = Promise.all([
    acquireLaunchChannel(profile),
    acquireLaunchChannel(profile),
    acquireLaunchChannel(profile),
  ]);
  leader.publish(7777);

  for (const f of await followers) expect(f).toEqual({ role: 'follower', port: 7777 });
});

test('LE CAS DU 01/08 : lanceur MORT ⇒ le suivant devient lanceur, sans aucun delai', async () => {
  // Avec le verrou fichier il fallait attendre la PEREMPTION (et sous charge, elle n'arrivait
  // jamais assez vite : contention en boucle, 5 h de panne). Ici le noyau libere le canal
  // immediatement ⇒ la reprise est instantanee et deterministe.
  const profile = uniq();
  const first = await acquireLaunchChannel(profile);
  expect(first.role).toBe('leader');
  first.close(); // simule la disparition du lanceur

  const second = keep(await acquireLaunchChannel(profile));
  expect(second.role).toBe('leader'); // reprise du role, PAS un blocage
});

test('lanceur mort AVANT publication : le suiveur ne pend pas, il prend le role', async () => {
  const profile = uniq();
  const leader = await acquireLaunchChannel(profile);

  // Le suiveur est connecte et attend une annonce qui ne viendra jamais.
  const pending = acquireLaunchChannel(profile);
  leader.close(); // le noyau ferme la socket du suiveur ⇒ evenement, pas timeout

  const next = keep(await pending);
  expect(next.role).toBe('leader');
});

test('profils DIFFERENTS = canaux INDEPENDANTS (etancheite entre identites)', async () => {
  const a = keep(await acquireLaunchChannel(uniq()));
  const b = keep(await acquireLaunchChannel(uniq()));
  expect(a.role).toBe('leader');
  expect(b.role).toBe('leader'); // aucun ne bloque l'autre
});

test('publish est idempotent en lecture : republier sert la nouvelle valeur', async () => {
  const profile = uniq();
  const leader = keep(await acquireLaunchChannel(profile));
  leader.publish(1111);
  expect((await acquireLaunchChannel(profile)).port).toBe(1111);
  leader.publish(2222); // respawn sur un port NEUF (cf SPAWN_ATTEMPTS)
  expect((await acquireLaunchChannel(profile)).port).toBe(2222);
});

test('close() est idempotent (un shutdown qui rejoue ne doit jamais jeter)', async () => {
  const h = await acquireLaunchChannel(uniq());
  h.close();
  expect(() => h.close()).not.toThrow();
});

// ── POSIX uniquement : la socket-fichier survit a un crash ──
const posix = process.platform !== 'win32';

test.skipIf(!posix)('POSIX : socket ORPHELINE d un crash ⇒ nettoyee et reprise', async () => {
  const profile = uniq();
  const name = channelName(profile);

  // Fabrique une orpheline REELLE : un serveur qui a ecoute puis dont le process a disparu
  // sans close() — on reproduit l'etat sur disque (fichier present, personne a l'ecoute).
  await new Promise((r) => {
    const s = net.createServer();
    s.listen(name, () => s.close(r)); // close() laisse le fichier sur POSIX
  });
  expect(fs.existsSync(name)).toBe(true);

  // ⚠️ La reprise passe par `connect` → ECONNREFUSED (fait EXACT du noyau : personne n'ecoute),
  //    jamais par « ce fichier a l'air vieux ».
  const h = keep(await acquireLaunchChannel(profile));
  expect(h.role).toBe('leader');
});

test.skipIf(!posix)('POSIX : close() retire le fichier socket (pas d orpheline apres sortie propre)', async () => {
  const profile = uniq();
  const name = channelName(profile);
  const h = await acquireLaunchChannel(profile);
  expect(fs.existsSync(name)).toBe(true);
  h.close();
  expect(fs.existsSync(name)).toBe(false);
});

test.skipIf(!posix)('POSIX : chemin de socket impossible ⇒ ERREUR, jamais un faux lanceur', async () => {
  const dir = path.join(os.tmpdir(), `pw-mcp-absent-${process.pid}`);
  await expect(acquireLaunchChannel('x', { platform: 'linux', tmpdir: dir })).rejects.toThrow(/listen/);
});
