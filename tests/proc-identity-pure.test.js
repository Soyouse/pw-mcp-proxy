// PUR (Stryker) — identite de process (pid + starttime).
// L'invariant de SURETE teste ici : on ne peut JAMAIS conclure « c'est le meme process »
// sans preuve. Un faux positif ici = `treeKill` sur un process TIERS.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseLinuxStat,
  parseWindowsCreationDate,
  parseLstart,
  identityMatches,
  safeToKill,
} from '../src/proc-identity-pure.js';

// Ligne /proc/<pid>/stat reelle (tronquee apres le champ 22 = starttime).
const statLine = (comm, start) =>
  `1234 (${comm}) S 1 1234 1234 0 -1 4194304 100 0 0 0 5 2 0 0 20 0 12 0 ${start} 1234567 890`;

test('Linux : starttime extrait du champ 22', () => {
  expect(parseLinuxStat(statLine('node', '987654'))).toBe('987654');
});

test('Linux : PIEGE — un `comm` avec espaces ET parentheses ne casse pas le parsing', () => {
  // Un binaire peut legitimement s'appeler ainsi. Un `split(' ')` naif decalerait TOUS les champs
  // et rendrait un starttime FAUX — donc une identite fausse, donc un kill sur le mauvais process.
  expect(parseLinuxStat(statLine('my (weird) app', '555'))).toBe('555');
  expect(parseLinuxStat(statLine('a b c d e', '777'))).toBe('777');
});

test('Linux : contenu illisible ⇒ null (jamais une valeur inventee)', () => {
  expect(parseLinuxStat('')).toBe(null);
  expect(parseLinuxStat('pas de parenthese ici')).toBe(null);
  expect(parseLinuxStat('1234 (node) S 1 2 3')).toBe(null); // tronque avant le champ 22
  expect(parseLinuxStat(null)).toBe(null);
  expect(parseLinuxStat(42)).toBe(null);
});

test('Linux : un starttime non numerique est REFUSE', () => {
  expect(parseLinuxStat(statLine('node', 'abc'))).toBe(null);
});

test('Linux : un starttime PARTIELLEMENT numerique est REFUSE (regex ANCREE)', () => {
  // Trouve par mutation : `/^\d+$/` mute en `/\d+$/` ou `/^\d+/` laissait passer `abc123` / `123abc`.
  // Une identite a moitie parsee est PIRE qu'aucune : elle serait stable, donc crue.
  expect(parseLinuxStat(statLine('node', 'abc123'))).toBe(null);
  expect(parseLinuxStat(statLine('node', '123abc'))).toBe(null);
  expect(parseLinuxStat(statLine('node', '12.5'))).toBe(null);
});

test('Linux : espaces MULTIPLES entre champs ne decalent pas le parsing', () => {
  // Trouve par mutation : `split(/\s+/)` mute en `split(/\s/)` produisait des champs VIDES et
  // decalait tout ⇒ starttime faux ⇒ identite fausse ⇒ kill sur le mauvais process.
  const spaced = statLine('node', '4242').replace(/ /g, '  ');
  expect(parseLinuxStat(spaced)).toBe('4242');
});

test('Linux : ligne SANS parenthese mais riche en champs ⇒ null', () => {
  // Trouve par mutation : la garde `close === -1` doit tenir meme quand la ligne a >22 champs.
  expect(parseLinuxStat(Array.from({ length: 30 }, (_, i) => i).join(' '))).toBe(null);
});

test('Windows : CreationDate ISO conservee TELLE QUELLE (7 decimales incluses)', () => {
  // Valeur MESUREE sur la machine le 2026-08-01.
  const line = '30020\t2026-08-01T23:46:21.5690920+02:00';
  expect(parseWindowsCreationDate(line)).toBe('2026-08-01T23:46:21.5690920+02:00');
});

test('Windows : formats UTC et sans fraction acceptes', () => {
  expect(parseWindowsCreationDate('1 2026-08-01T23:46:21Z')).toBe('2026-08-01T23:46:21Z');
  expect(parseWindowsCreationDate('1 2026-01-02T03:04:05.12-05:00')).toBe('2026-01-02T03:04:05.12-05:00');
});

test('Windows : ligne sans date ⇒ null', () => {
  expect(parseWindowsCreationDate('30020\t')).toBe(null);
  expect(parseWindowsCreationDate('pas de date')).toBe(null);
  expect(parseWindowsCreationDate(undefined)).toBe(null);
});

test('macOS : lstart normalise (espaces multiples quand le jour a 1 chiffre)', () => {
  // Sans normalisation, `Aug  1` et `Aug 1` seraient deux identites DIFFERENTES pour le meme
  // process selon la commande utilisee — l'egalite echouerait au hasard.
  expect(parseLstart('Fri Aug  1 23:46:21 2026')).toBe('Fri Aug 1 23:46:21 2026');
  expect(parseLstart('  Fri Aug 11 23:46:21 2026  ')).toBe('Fri Aug 11 23:46:21 2026');
});

test('macOS : sortie vide ⇒ null', () => {
  expect(parseLstart('   ')).toBe(null);
  expect(parseLstart('')).toBe(null);
  expect(parseLstart(null)).toBe(null);
});

test('SURETE : identite inconnue (null) ne matche JAMAIS', () => {
  expect(identityMatches(null, null)).toBe(false); // deux inconnues ne font pas une preuve
  expect(identityMatches('123', null)).toBe(false);
  expect(identityMatches(null, '123')).toBe(false);
  expect(identityMatches('', '')).toBe(false);
});

test('SURETE : starttime DIFFERENT = PID recycle = on ne tue pas', () => {
  // Le scenario exact de la faille : meme numero de pid, autre process.
  expect(safeToKill('987654', '112233')).toBe(false);
});

test('meme identite ⇒ kill autorise', () => {
  expect(safeToKill('987654', '987654')).toBe(true);
});

test('AUCUNE tolerance : un token proche n est PAS le meme process', () => {
  // Interdit toute tentation d'« approximation temporelle » sur un token OPAQUE.
  expect(safeToKill('987654', '987655')).toBe(false);
  expect(safeToKill('2026-08-01T23:46:21.5690920+02:00', '2026-08-01T23:46:21.5690921+02:00')).toBe(false);
});

test('PROPRIETE : identityMatches est reflexive sur toute chaine non vide', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (s) => {
      expect(identityMatches(s, s)).toBe(true);
    })
  );
});

test('PROPRIETE : deux tokens differents ne matchent JAMAIS', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
      fc.pre(a !== b);
      expect(identityMatches(a, b)).toBe(false);
    })
  );
});

test('PROPRIETE : safeToKill est FAILS-CLOSED sur toute entree non-chaine', () => {
  fc.assert(
    fc.property(fc.anything(), (x) => {
      if (typeof x === 'string' && x !== '') return; // cas nominal traite ailleurs
      expect(safeToKill(x, x)).toBe(false);
      expect(safeToKill('987654', x)).toBe(false);
      expect(safeToKill(x, '987654')).toBe(false);
    })
  );
});

test('PROPRIETE : le champ 22 est extrait quel que soit le nom du binaire', () => {
  fc.assert(
    fc.property(fc.string(), fc.integer({ min: 0, max: 2 ** 31 }), (comm, start) => {
      expect(parseLinuxStat(statLine(comm, String(start)))).toBe(String(start));
    })
  );
});
