// PUR (Stryker) — derivation du nom de canal du DAEMON UNIQUE.
//
// L'invariant CRITIQUE teste ici : INJECTIVITE SUR L'UTILISATEUR. Deux comptes distincts ne
// doivent JAMAIS produire le meme canal — sinon deux utilisateurs de la machine partageraient un
// daemon, donc des navigateurs, donc des identites Google. C'est la faute que ce projet existe
// pour empecher.
//
// ⚠️ HISTORIQUE UTILE (02/08/2026) : ce fichier testait AUSSI `channelName(profil)`, un canal PAR
// PROFIL. Cette fonction est devenue du CODE MORT a l'arrivee du daemon unique (plus aucun
// consommateur hors de ce test) et a ete SUPPRIMEE. L'injectivite, elle, n'a PAS ete perdue : elle
// est reciblee ci-dessous sur le segment UTILISATEUR, qui est ce qui distingue reellement deux
// canaux aujourd'hui. NE PAS reintroduire un canal par profil (cf `channel-name.js`).

import { test, expect } from 'vitest';
import fc from 'fast-check';
import path from 'node:path';
import os from 'node:os';
import { daemonChannelName, encodeProfile, channelIsFile, runtimeDir, userSegment, SUN_PATH_MAX } from '../src/channel-name.js';

// ⚠️ `userInfo` INJECTE : sur un repo PUBLIC, un test ne doit JAMAIS dependre du compte qui le
// lance (il passerait chez l'auteur et casserait chez un contributeur).
const WIN = (username) => ({ platform: 'win32', userInfo: { username } });
const NIX = (username) => ({ platform: 'linux', tmpdir: '/tmp', userInfo: { username } });

// ── encodage (partage : il encode le segment UTILISATEUR du canal) ───────────────────────────

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

test('les caracteres surs restent LISIBLES (le nom doit se lire dans un log)', () => {
  expect(encodeProfile('Client_42.prod-v2')).toBe('Client_42.prod-v2');
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

// ── segment utilisateur ──────────────────────────────────────────────────────────────────────

test('userSegment : nom d utilisateur exotique encode, jamais brut', () => {
  // Un compte Windows peut s'appeler `DOMAINE\Jean Dupont` : sans encodage, le `\` casserait
  // le nom du pipe et l'espace le rendrait ambigu.
  expect(encodeProfile(userSegment({ username: 'Jean Dupont' }))).toBe('Jean%20Dupont');
  expect(userSegment({ username: '' })).toBe('anon');
  expect(userSegment({ username: null })).toBe('anon');
});

// ── repertoire runtime (POSIX) ───────────────────────────────────────────────────────────────

test('POSIX : $XDG_RUNTIME_DIR prefere a /tmp (systemd purge /tmp apres 10 jours)', () => {
  // Sans ca : socket EFFACEE sous un daemon VIVANT ⇒ un 2e `listen()` reussit ⇒ DEUX daemons
  // ⇒ double spawn ⇒ « browser is already in use ». La garantie saute sur la duree.
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

test('channelIsFile : POSIX oui (survit au crash), Windows non (le noyau detruit)', () => {
  expect(channelIsFile(NIX('u'))).toBe(true);
  expect(channelIsFile(WIN('u'))).toBe(false);
});

// ── canal du DAEMON UNIQUE ───────────────────────────────────────────────────────────────────

test('DAEMON Windows : named pipe dans l espace de noms dedie, jamais un chemin de fichier', () => {
  const nom = daemonChannelName(WIN('theo'));
  // Assertions SANS backslash litteral (un heredoc/copier-coller les mange, piege vecu le 02/08) :
  // on caracterise le pipe par ce qui le distingue d'un chemin POSIX.
  expect(nom.includes('pipe'), 'espace de noms des named pipes').toBe(true);
  expect(nom.includes('/'), 'jamais un separateur POSIX sur Windows').toBe(false);
  expect(nom.endsWith('.sock'), 'un pipe n est pas un fichier socket').toBe(false);
  expect(nom).toContain('theo');
});

test('DAEMON : deterministe (meme entree ⇒ meme sortie, toujours)', () => {
  const env = WIN('theo');
  expect(daemonChannelName(env)).toBe(daemonChannelName(env));
});

test('DAEMON POSIX : socket dans le repertoire runtime, avec le segment utilisateur', () => {
  const nom = daemonChannelName({ platform: 'linux', tmpdir: '/run/user/1000', userInfo: { username: 'theo' } });
  expect(nom).toBe(path.join('/run/user/1000', 'pw-mcp-theo.sock'));
});

// ⚠️ Sans `tmpdir` injecte, le repertoire vient de `runtimeDir(platform)` — qui lit `process.env`,
// PAS un env passe ici. Le test le CONSTATE au lieu de le supposer : mon premier jet affirmait
// l'inverse et rougissait a raison.
test('DAEMON POSIX : sans tmpdir injecte, le repertoire est celui de runtimeDir', () => {
  expect(daemonChannelName({ platform: 'linux' })).toBe(
    path.join(runtimeDir('linux'), `pw-mcp-${userSegment()}.sock`)
  );
});

// ⚠️ FAILS-CLOSED : jamais de troncature ni de hash — deux daemons au meme nom serait pire que
// pas de daemon du tout (chacun croirait etre seul ⇒ double spawn sur le meme user-data-dir).
test('DAEMON POSIX : chemin trop long ⇒ ERREUR explicite, jamais une troncature', () => {
  const long = '/' + 'x'.repeat(SUN_PATH_MAX);
  expect(() => daemonChannelName({ platform: 'linux', tmpdir: long, userInfo: { username: 'theo' } }))
    .toThrow(/trop long/);
});

// ⚠️ `userInfo: null` ne force PAS le repli : la fonction lit alors l'utilisateur REEL. Le repli
// `anon` ne sert qu'aux cas ou le nom est vide ou `os.userInfo()` jette (conteneur sans passwd).
test('DAEMON : nom d utilisateur VIDE ⇒ repli anon (jamais un throw au demarrage)', () => {
  expect(daemonChannelName(WIN(''))).toMatch(/anon/);
});

// ── L'INVARIANT DE SECURITE ──────────────────────────────────────────────────────────────────

test('ISOLATION PAR UTILISATEUR : deux comptes ne partagent JAMAIS un canal', () => {
  // Doc officielle Microsoft : l'espace de noms des named pipes est GLOBAL a la machine, sans
  // isolation par session. Sans ce segment, deux comptes Windows se bloqueraient mutuellement.
  const a = daemonChannelName(WIN('alice'));
  const b = daemonChannelName(WIN('bob'));
  expect(a).not.toBe(b);
  expect(a).toContain('alice');
});

test('PROPRIETE — INJECTIVITE : deux utilisateurs distincts ⇒ deux canaux distincts', () => {
  // L'invariant de securite du module, RECIBLE le 02/08 depuis les profils vers les utilisateurs
  // (le canal par profil a ete supprime, cf en-tete). Un hash le violerait par collision ;
  // l'encodage reversible le garantit PAR CONSTRUCTION.
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
      fc.pre(a !== b);
      fc.pre(encodeProfile(a) !== '' && encodeProfile(b) !== '');
      expect(daemonChannelName(WIN(a))).not.toBe(daemonChannelName(WIN(b)));
    })
  );
});

test('PROPRIETE : le canal POSIX respecte TOUJOURS la borne sun_path, ou il jette', () => {
  // Fonction TOTALE : soit un nom valide sous la borne, soit une erreur EXPLICITE — jamais un
  // nom tronque silencieusement (deux utilisateurs tronques au meme nom = daemon partage).
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 200 }), (username) => {
      let nom;
      try {
        nom = daemonChannelName({ platform: 'linux', tmpdir: '/tmp', userInfo: { username } });
      } catch (e) {
        expect(String(e.message)).toMatch(/trop long/);
        return true;
      }
      return Buffer.byteLength(nom, 'utf8') <= SUN_PATH_MAX;
    })
  );
});
