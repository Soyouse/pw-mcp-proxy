// PUR (Stryker) — derivation du nom de canal de lancement.
// L'invariant CRITIQUE teste ici : INJECTIVITE. Deux profils distincts ne doivent JAMAIS
// produire le meme canal — sinon deux identites Google partageraient un navigateur, ce qui
// est exactement la faute que ce projet existe pour empecher.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import path from 'node:path';
import os from 'node:os';
import { daemonChannelName, channelName, encodeProfile, channelIsFile, runtimeDir, userSegment, SUN_PATH_MAX } from '../src/channel-name.js';

// ⚠️ `userInfo` INJECTE : sur un repo PUBLIC, un test ne doit JAMAIS dependre du compte qui le
// lance (il passerait chez l'auteur et casserait chez un contributeur). Le segment utilisateur est
// verifie separement, avec des valeurs explicites.
const U = { username: 'u' };
const WIN = { platform: 'win32', userInfo: U };
const NIX = { platform: 'linux', tmpdir: '/tmp', userInfo: U };

test('Windows : named pipe dans l espace de noms dedie', () => {
  expect(channelName('vegeta', WIN)).toBe('\\\\.\\pipe\\pw-mcp-u-vegeta');
});

test('POSIX : socket de domaine Unix dans tmpdir', () => {
  expect(channelName('vegeta', NIX)).toBe(path.join('/tmp', 'pw-mcp-u-vegeta.sock'));
});

test('le nom se DERIVE du profil : ajouter une identite ne demande aucune table', () => {
  // 3 profils au 01/08/2026, le nombre est NON BORNE : chaque nom sort du profil, point.
  for (const p of ['vegeta', 'perso', 'client-42', 'un-profil-ajoute-demain']) {
    expect(channelName(p, WIN)).toBe(`\\\\.\\pipe\\pw-mcp-u-${p}`);
  }
});

test('caracteres speciaux : encodes, jamais laisses bruts', () => {
  expect(encodeProfile('a b')).toBe('a%20b');
  expect(encodeProfile('a/b')).toBe('a%2Fb'); // un `/` casserait le chemin POSIX
  expect(encodeProfile('a\\b')).toBe('a%5Cb'); // un `\` casserait le nom de pipe Windows
  expect(encodeProfile('éte')).toBe('%C3%A9te'); // UTF-8 multi-octets
});

test('octet < 0x10 : encode sur DEUX chiffres (%01, jamais %1)', () => {
  // Trouve par mutation : `padStart(2, '0')` mute en `padStart(2, '')` produisait `%1`.
  // Un percent-encoding a UN chiffre n'est plus du percent-encoding : le nom cesse d'etre
  // decodable, et l'injectivite ne repose plus que sur la chance.
  expect(encodeProfile('\x01')).toBe('%01');
  expect(encodeProfile('\t')).toBe('%09');
  expect(encodeProfile('\x0F')).toBe('%0F');
});

test('message d erreur de longueur : NOMME le profil fautif (diagnostic utilisable)', () => {
  expect(() => channelName('z'.repeat(SUN_PATH_MAX), NIX)).toThrow(/z{10}/);
});

test('les caracteres surs restent LISIBLES (le nom doit se lire dans un log)', () => {
  expect(encodeProfile('Client_42.prod-v2')).toBe('Client_42.prod-v2');
});

test('profil vide : REFUSE (fails-closed, jamais un canal anonyme partage)', () => {
  expect(() => channelName('', WIN)).toThrow(/vide/);
});

test('POSIX : chemin trop long ⇒ ERREUR EXPLICITE, jamais une troncature silencieuse', () => {
  // Une troncature ferait converger deux profils vers le MEME canal = navigateur partage.
  const long = 'x'.repeat(SUN_PATH_MAX);
  expect(() => channelName(long, NIX)).toThrow(/trop long/);
});

test('POSIX : juste sous la limite ⇒ accepte (la borne n est pas trop stricte)', () => {
  const base = Buffer.byteLength(path.join('/tmp', 'pw-mcp-u-.sock'), 'utf8');
  const ok = 'x'.repeat(SUN_PATH_MAX - base);
  expect(Buffer.byteLength(channelName(ok, NIX), 'utf8')).toBeLessThanOrEqual(SUN_PATH_MAX);
});

test('Windows ignore la limite sun_path (espace de noms, pas un chemin de fichier)', () => {
  const long = 'y'.repeat(300);
  expect(channelName(long, WIN)).toContain(long);
});

test('POSIX : $XDG_RUNTIME_DIR prefere a /tmp (systemd purge /tmp apres 10 jours)', () => {
  // Sans ca : socket EFFACEE sous un lanceur VIVANT ⇒ un 2e `listen()` reussit ⇒ DEUX lanceurs
  // ⇒ double spawn ⇒ « browser is already in use ». La garantie du canal sautait sur la duree.
  expect(runtimeDir('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000');
});

test('POSIX : repli sur tmpdir si XDG absent ou relatif (defaut connu, pas une equivalence)', () => {
  expect(runtimeDir('linux', {})).toBe(os.tmpdir());
  expect(runtimeDir('linux', { XDG_RUNTIME_DIR: '' })).toBe(os.tmpdir());
  expect(runtimeDir('linux', { XDG_RUNTIME_DIR: 'relatif/pas/absolu' })).toBe(os.tmpdir());
});

test('Windows : XDG ignore (les named pipes ne sont pas des fichiers)', () => {
  expect(runtimeDir('win32', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(os.tmpdir());
});

test('ISOLATION PAR UTILISATEUR : deux comptes ne partagent JAMAIS un canal', () => {
  // Doc officielle Microsoft : l'espace de noms des named pipes est GLOBAL a la machine, sans
  // isolation par session. Sans ce segment, deux comptes Windows avec le meme profil se bloquent.
  const a = channelName('vegeta', { platform: 'win32', userInfo: { username: 'alice' } });
  const b = channelName('vegeta', { platform: 'win32', userInfo: { username: 'bob' } });
  expect(a).not.toBe(b);
  expect(a).toContain('alice');
});

test('userSegment : nom d utilisateur exotique encode, jamais brut', () => {
  // Un compte Windows peut s'appeler `DOMAINE\Jean Dupont` : sans encodage, le `\` casserait
  // le nom du pipe et l'espace le rendrait ambigu.
  expect(encodeProfile(userSegment({ username: 'Jean Dupont' }))).toBe('Jean%20Dupont');
  expect(userSegment({ username: '' })).toBe('anon');
  expect(userSegment({ username: null })).toBe('anon');
});

test('channelIsFile : POSIX oui (survit au crash), Windows non (le noyau detruit)', () => {
  expect(channelIsFile(NIX)).toBe(true);
  expect(channelIsFile(WIN)).toBe(false);
});

test('PROPRIETE — INJECTIVITE : deux profils distincts ⇒ deux canaux distincts', () => {
  // L'invariant de securite du module. Un hash le violerait par collision ; l'encodage
  // reversible le garantit par construction.
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
      fc.pre(a !== b);
      fc.pre(encodeProfile(a) !== '' && encodeProfile(b) !== '');
      expect(channelName(a, WIN)).not.toBe(channelName(b, WIN));
    })
  );
});

test('PROPRIETE : l encodage ne laisse JAMAIS passer un separateur de chemin', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (s) => {
      const enc = encodeProfile(s);
      expect(enc).not.toContain('/');
      expect(enc).not.toContain('\\');
    })
  );
});

test('PROPRIETE : deterministe (meme entree ⇒ meme sortie, toujours)', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (s) => {
      fc.pre(encodeProfile(s) !== '');
      expect(channelName(s, WIN)).toBe(channelName(s, WIN));
    })
  );
});

// ── canal du DAEMON UNIQUE ───────────────────────────────────────────────────────────────────
// ⚠️ Non-collision PAR CONSTRUCTION : le nom du daemon omet le segment de profil, et channelName
// refuse un profil vide => aucun profil ne peut produire le nom du daemon. Si cette propriete
// tombait, un proxy dialoguerait avec le mauvais interlocuteur.
test('DAEMON : le nom est stable et distinct du canal de tout profil', () => {
  const env = { platform: 'win32', userInfo: { username: 'theo' } };
  const d = daemonChannelName(env);
  expect(d).toBe(daemonChannelName(env)); // deterministe
  for (const p of ['daemon', '_daemon', 'DAEMON', 'a', 'vegeta', 'perso', ' ', '-', '%2d']) {
    expect(channelName(p, env), `collision avec le profil "${p}"`).not.toBe(d);
  }
});

test('PROPERTY : AUCUN nom de profil ne produit le canal du daemon', () => {
  const env = { platform: 'win32', userInfo: { username: 'theo' } };
  const d = daemonChannelName(env);
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 60 }), (profil) => {
      let nom;
      try { nom = channelName(profil, env); } catch { return true; } // profil refuse : sans objet
      return nom !== d;
    }),
    { numRuns: 500 }
  );
});

test('DAEMON : le segment UTILISATEUR est présent (espace de noms des pipes global à la machine)', () => {
  const a = daemonChannelName({ platform: 'win32', userInfo: { username: 'alice' } });
  const b = daemonChannelName({ platform: 'win32', userInfo: { username: 'bob' } });
  expect(a).not.toBe(b);
  expect(a).toMatch(/alice/);
});

// ⚠️ Branche POSIX du daemon testée en INJECTANT `platform` — le dev est sous Windows, donc sans
// ça ce code n'est jamais exécuté (12 mutants sans couverture mesurés le 02/08). Même technique
// que pour channelName : la plateforme est un paramètre, précisément pour rester testable.
test('DAEMON POSIX : socket dans le répertoire runtime, avec le segment utilisateur', () => {
  const nom = daemonChannelName({ platform: 'linux', tmpdir: '/run/user/1000', userInfo: { username: 'theo' } });
  expect(nom).toBe(path.join('/run/user/1000', 'pw-mcp-theo.sock'));
});

// ⚠️ Sans `tmpdir` injecté, le répertoire vient de `runtimeDir(platform)` — qui lit `process.env`,
// PAS un env passé ici (comportement identique à `channelName`, vérifié dans la source). Le test
// le CONSTATE au lieu de le supposer : mon premier jet affirmait l'inverse et rougissait à raison.
test('DAEMON POSIX : sans tmpdir injecté, le répertoire est celui de runtimeDir', () => {
  expect(daemonChannelName({ platform: 'linux' })).toBe(
    path.join(runtimeDir('linux'), `pw-mcp-${userSegment()}.sock`)
  );
});

// ⚠️ FAILS-CLOSED : jamais de troncature ni de hash — deux daemons au même nom, ce serait pire
// que pas de daemon du tout.
test('DAEMON POSIX : chemin trop long => ERREUR explicite, jamais une troncature', () => {
  const long = '/' + 'x'.repeat(SUN_PATH_MAX);
  expect(() => daemonChannelName({ platform: 'linux', tmpdir: long, userInfo: { username: 'theo' } }))
    .toThrow(/trop long/);
});

test('DAEMON : Windows => named pipe, jamais un chemin de fichier', () => {
  const nom = daemonChannelName({ platform: 'win32', userInfo: { username: 'theo' } });
  // Assertions SANS backslash littéral (un heredoc/copier-coller les mange, piège vécu le 02/08) :
  // on caractérise le pipe par ce qui le distingue d'un chemin POSIX.
  expect(nom.includes('pipe'), 'espace de noms des named pipes').toBe(true);
  expect(nom.includes('/'), 'jamais un séparateur POSIX sur Windows').toBe(false);
  expect(nom.endsWith('.sock'), 'un pipe n est pas un fichier socket').toBe(false);
});

// ⚠️ `userInfo: null` ne force PAS le repli : la fonction lit alors l'utilisateur RÉEL. Le repli
// `anon` ne sert qu'aux cas où le nom est vide ou `os.userInfo()` jette (conteneur sans passwd).
// Mon premier jet confondait les deux et rougissait à raison — le code avait raison.
test('DAEMON : nom d utilisateur VIDE => repli anon (jamais un throw au démarrage)', () => {
  expect(daemonChannelName({ platform: 'win32', userInfo: { username: '' } })).toMatch(/anon/);
});
