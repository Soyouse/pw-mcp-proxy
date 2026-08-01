// INTEGRATION (I/O reelle, hors Stryker) — lecture de l'identite aupres du VRAI systeme.
// Un faux `ps`/`/proc` ne prouverait rien : c'est le format REEL de la machine qu'on doit lire.

import { test, expect } from 'vitest';
import { processIdentity } from '../src/proc-identity.js';

test('mon propre process : identite LISIBLE et NON VIDE', () => {
  const id = processIdentity(process.pid);
  expect(id, `identite illisible sur ${process.platform} — le parseur ne colle pas au format reel`).toBeTruthy();
  expect(typeof id).toBe('string');
});

test('STABILITE : deux lectures du MEME process donnent EXACTEMENT la meme valeur', () => {
  // Invariant vital : si la lecture n'etait pas stable, `safeToKill` refuserait toujours et le
  // reap cesserait silencieusement de nettoyer (panne inverse, invisible).
  expect(processIdentity(process.pid)).toBe(processIdentity(process.pid));
});

test('PID inexistant ⇒ null (fails-closed : pas de preuve, pas de kill)', () => {
  // 2^22 depasse `pid_max` par defaut partout : aucun process ne peut porter ce numero.
  expect(processIdentity(4194304)).toBe(null);
});

test('entrees absurdes ⇒ null, jamais une exception', () => {
  for (const bad of [0, -1, 1.5, NaN, null, undefined, '123']) {
    expect(processIdentity(bad), String(bad)).toBe(null);
  }
});

test('LA FAILLE : deux process DIFFERENTS ont des identites DIFFERENTES', () => {
  // C'est ce qui rend le recyclage de PID detectable. Sans cette propriete, rien ne distingue
  // « notre serveur » d'un process tiers qui a herite du numero.
  const mine = processIdentity(process.pid);
  const parent = processIdentity(process.ppid);
  expect(mine).toBeTruthy();
  if (parent) expect(mine).not.toBe(parent);
});

test('plateforme inconnue : passe par le chemin POSIX sans jeter', () => {
  expect(() => processIdentity(process.pid, { platform: 'freebsd' })).not.toThrow();
});
