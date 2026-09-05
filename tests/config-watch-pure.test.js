// PUR + property — LA DÉCISION du rechargement de config (config-watch-pure.js). Cible Stryker.
// Import DIRECT du fichier muté (jamais un re-export : perTest raterait le mapping).
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { empreinte, concerne, verdictLecture, verdictErreurLecture } from '../src/config-watch-pure.js';

const CAL = Object.freeze([100, 500, 2000]);

test('empreinte : déterministe, sensible à un octet, identique Buffer/string', () => {
  expect(empreinte('abc')).toBe(empreinte(Buffer.from('abc')));
  expect(empreinte('abc')).not.toBe(empreinte('abd'));
  expect(empreinte('')).toHaveLength(64);
});

test('concerne : nom absent (doc Node) ⇒ OUI (fails-closed), nom exact ⇒ OUI, autre nom ⇒ NON', () => {
  expect(concerne(null, 'profiles.json')).toBe(true);
  expect(concerne(undefined, 'profiles.json')).toBe(true);
  expect(concerne('profiles.json', 'profiles.json')).toBe(true);
  expect(concerne(Buffer.from('profiles.json'), 'profiles.json')).toBe(true);
  expect(concerne('profiles.json.tmp', 'profiles.json')).toBe(false);
  expect(concerne('autre.json', 'profiles.json')).toBe(false);
});

test('verdictLecture : contenu identique au chargé ⇒ identique (événement double / antivirus absorbé)', () => {
  const octets = Buffer.from('{"a":1}');
  expect(verdictLecture(empreinte(octets), octets, JSON.parse)).toEqual({ action: 'identique' });
});

test('verdictLecture : contenu différent et valide ⇒ charger, avec hash ET texte', () => {
  const v = verdictLecture(empreinte('{"a":1}'), Buffer.from('{"a":2}'), JSON.parse);
  expect(v).toEqual({ action: 'charger', hash: empreinte('{"a":2}'), texte: '{"a":2}' });
});

test('verdictLecture : rien chargé (null) et contenu valide ⇒ charger', () => {
  expect(verdictLecture(null, '{"a":1}', JSON.parse).action).toBe('charger');
});

test('verdictLecture : contenu à moitié écrit ⇒ invalide, raison nommée, jamais charger', () => {
  const v = verdictLecture(empreinte('{"a":1}'), Buffer.from('{"a":'), JSON.parse);
  expect(v.action).toBe('invalide');
  expect(/** @type {{raison:string}} */ (v).raison).toMatch(/illisible/);
  expect(/** @type {{raison:string}} */ (v).raison).toMatch(/JSON|Unexpected|end/i);
});

test('verdictLecture : un parse qui throw autre chose qu une Error est quand même nommé', () => {
  const v = verdictLecture(null, 'x', () => { throw 'boum'; });
  expect(v).toEqual({ action: 'invalide', raison: 'contenu illisible (écriture en cours ?) : boum' });
});

test('verdictErreurLecture : codes transitoires ⇒ rejeu au calendrier, puis abandon ; autre ⇒ fatal', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EAGAIN']) {
    expect(verdictErreurLecture(code, 0, CAL)).toEqual({ action: 'rejouer', pauseMs: 100 });
    expect(verdictErreurLecture(code, 1, CAL)).toEqual({ action: 'rejouer', pauseMs: 500 });
    expect(verdictErreurLecture(code, 2, CAL)).toEqual({ action: 'rejouer', pauseMs: 2000 });
    expect(verdictErreurLecture(code, 3, CAL)).toEqual({ action: 'abandon' });
  }
  expect(verdictErreurLecture('EISDIR', 0, CAL)).toEqual({ action: 'fatal' });
  expect(verdictErreurLecture(undefined, 0, CAL)).toEqual({ action: 'fatal' });
  expect(verdictErreurLecture('EBUSY', 0, [])).toEqual({ action: 'abandon' });
});

test('PROPERTY : verdictLecture est TOTALE et cohérente sur tout contenu', () => {
  fc.assert(fc.property(fc.uint8Array(), fc.option(fc.uint8Array(), { nil: null }), (a, b) => {
    const octets = Buffer.from(a);
    const hashCharge = b === null ? null : empreinte(Buffer.from(b));
    const v = verdictLecture(hashCharge, octets, JSON.parse);
    if (empreinte(octets) === hashCharge) return v.action === 'identique';
    let valide = true;
    try { JSON.parse(octets.toString('utf8')); } catch { valide = false; }
    return valide ? v.action === 'charger' && /** @type {{hash:string}} */ (v).hash === empreinte(octets) : v.action === 'invalide';
  }));
});

test('PROPERTY : verdictErreurLecture rejoue EXACTEMENT calendrier.length fois, dans l ordre, puis abandonne', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 10000 }), { maxLength: 6 }), fc.nat(10), (cal, essai) => {
    const v = verdictErreurLecture('EBUSY', essai, cal);
    return essai < cal.length ? v.action === 'rejouer' && /** @type {{pauseMs:number}} */ (v).pauseMs === cal[essai] : v.action === 'abandon';
  }));
});

test('PROPERTY : concerne ne dit OUI que pour le nom exact ou l absence de nom', () => {
  fc.assert(fc.property(fc.string(), fc.string({ minLength: 1 }), (nom, cible) => concerne(nom, cible) === (nom === cible)));
});
