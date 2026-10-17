// Decision PURE du souvenir de handshake (handshake-cache-pure.js) — cible Stryker.
// ⚠️ Import DIRECT du module mute (jamais via un re-export : le mapping perTest le raterait).
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { cleHandshake, entreesValides, lireEntree, ecrireEntree, memesOutils, MAX_ENTREES_DEFAUT, VERSION_FORMAT } from '../src/handshake-cache-pure.js';

const SPEC = () => ({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--caps=storage'], configuration: null, label: 'job' });
const doc = (entrees) => ({ version: VERSION_FORMAT, entrees });

test('cle : toute la commande + la version de protocole, rien d autre (le label ne compte pas)', () => {
  const a = cleHandshake(SPEC(), '2025-06-18');
  expect(a).toBe(JSON.stringify(['npx', ['-y', '@playwright/mcp@0.0.80', '--caps=storage'], null, '2025-06-18']));
  expect(cleHandshake({ ...SPEC(), label: 'autre' }, '2025-06-18'), 'deux profils, meme commande => meme cle').toBe(a);
  expect(cleHandshake(SPEC(), '2025-03-26'), 'version de protocole differente => cle differente').not.toBe(a);
  expect(cleHandshake({ ...SPEC(), command: 'node' }, '2025-06-18')).not.toBe(a);
  expect(cleHandshake({ ...SPEC(), args: ['-y'] }, '2025-06-18')).not.toBe(a);
  expect(cleHandshake({ ...SPEC(), configuration: { browser: {} } }, '2025-06-18')).not.toBe(a);
});

test('cle : fonction TOTALE (spec ou version absentes => null explicites)', () => {
  expect(cleHandshake(undefined, undefined)).toBe('[null,null,null,null]');
  expect(cleHandshake(null, null)).toBe('[null,null,null,null]');
  expect(cleHandshake({}, 'v')).toBe('[null,null,null,"v"]');
});

test('entreesValides : un document douteux = AUCUN souvenir (jamais une reponse inventee)', () => {
  for (const mauvais of [null, undefined, 3, 'x', [], {}, { version: 2, entrees: [] }, { version: VERSION_FORMAT }, { version: VERSION_FORMAT, entrees: 'x' }]) {
    expect(entreesValides(mauvais)).toEqual([]);
  }
  const bonne = { cle: 'k', init: { a: 1 }, tools: [{ name: 't' }] };
  expect(entreesValides({ version: VERSION_FORMAT + 1, entrees: [bonne] }), 'format INCONNU, entrees bien formees : ignore quand meme').toEqual([]);
  const filtrees = entreesValides(doc([null, 4, [], { cle: 3 }, { cle: 'i', init: [] }, { cle: 'j', init: null }, { cle: 'j2', init: 'x' }, { cle: 't', tools: {} }, { cle: 'nue' }, bonne]));
  expect(filtrees).toEqual([{ cle: 'nue' }, bonne]);
});

test('lireEntree : trouve la cle, sinon null', () => {
  const d = doc([{ cle: 'a', tools: [] }, { cle: 'b', init: { x: 1 } }]);
  expect(lireEntree(d, 'b')).toEqual({ cle: 'b', init: { x: 1 } });
  expect(lireEntree(d, 'z')).toBeNull();
  expect(lireEntree(null, 'a')).toBeNull();
});

test('ecrireEntree : fusionne, passe en DERNIER, evince les plus anciennes au-dela du plafond', () => {
  const d1 = ecrireEntree(null, 'a', { init: { i: 1 } });
  expect(d1).toEqual({ version: VERSION_FORMAT, entrees: [{ cle: 'a', init: { i: 1 } }] });
  const d2 = ecrireEntree(d1, 'b', { tools: [] });
  const d3 = ecrireEntree(d2, 'a', { tools: [{ name: 't' }] });
  expect(d3.entrees, 'fusion init + tools, et "a" redevient la plus recente').toEqual([{ cle: 'b', tools: [] }, { cle: 'a', init: { i: 1 }, tools: [{ name: 't' }] }]);
  const d4 = ecrireEntree(d3, 'c', {}, 2);
  expect(d4.entrees.map((e) => e.cle), 'plafond 2 : la plus ancienne ("b") part').toEqual(['a', 'c']);
  expect(ecrireEntree(d3, 'a', { cle: 'pirate' }).entrees.at(-1).cle, 'le patch ne peut pas changer la cle').toBe('a');
});

test('ecrireEntree : plafond invalide => defaut, jamais "illimite"', () => {
  let d = null;
  for (let i = 0; i < MAX_ENTREES_DEFAUT + 3; i++) d = ecrireEntree(d, `k${i}`, {}, 0);
  expect(d.entrees.length).toBe(MAX_ENTREES_DEFAUT);
  expect(ecrireEntree(d, 'x', {}, 1.5).entrees.length).toBe(MAX_ENTREES_DEFAUT);
  expect(ecrireEntree(d, 'x', {}, -1).entrees.length).toBe(MAX_ENTREES_DEFAUT);
  expect(ecrireEntree(d, 'x', {}, 1).entrees).toEqual([{ cle: 'x' }]);
});

test('PROPERTY : le document reste borne, sans doublon de cle, la derniere ecrite est lisible', () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e'), fc.integer()), { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 4 }), (ecritures, max) => {
      let d = null;
      for (const [cle, v] of ecritures) d = ecrireEntree(d, cle, { init: { v } }, max);
      const cles = d.entrees.map((e) => e.cle);
      expect(cles.length).toBeLessThanOrEqual(max);
      expect(new Set(cles).size).toBe(cles.length);
      const [derniere, v] = ecritures.at(-1);
      expect(lireEntree(d, derniere)?.init).toEqual({ v });
    })
  );
});

test('memesOutils : egalite de la reponse telle que servie (ordre compris)', () => {
  expect(memesOutils([{ name: 'a' }, { name: 'b' }], [{ name: 'a' }, { name: 'b' }])).toBe(true);
  expect(memesOutils([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'a' }])).toBe(false);
  expect(memesOutils([{ name: 'a' }], [{ name: 'a', description: 'x' }])).toBe(false);
  expect(memesOutils(undefined, null)).toBe(true);
  expect(memesOutils([], null)).toBe(false);
});
