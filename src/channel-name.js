// PUR — nom du CANAL DE LANCEMENT derive du nom de profil.
//
// POURQUOI CE MODULE (incident 31/07→01/08/2026) : le verrou de lancement etait un FICHIER,
// donc soumis a peremption par delai (« ce .lock a plus de N ms, je le vole »). Un canal nomme
// est detruit PAR LE NOYAU a la mort du processus : le verrou perime devient IMPOSSIBLE par
// construction, pas « improbable ». Plus de TTL, plus de vol, plus de meta-verrou.
//
// ⚠️ Le nombre d'identites est DYNAMIQUE et NON BORNE : le nom se DERIVE du profil, il n'y a
//    JAMAIS de table d'attribution ni de numero reserve. Ajouter une identite = une entree
//    dans profiles.json, rien d'autre.
// ⚠️ ENCODAGE REVERSIBLE (percent-encoding), JAMAIS UN HASH : un hash peut collisionner, et
//    deux profils qui partagent un canal = deux identites Google qui partagent un navigateur.
//    C'est la faute exacte que ce projet existe pour empecher. Le reversible rend la collision
//    impossible par construction (injectif), et le nom reste LISIBLE dans les logs.
// ⚠️ PAS un port TCP : un port est une ressource GLOBALE (collision possible avec un tiers).
//    Un canal nomme vit dans un espace de noms dedie. C'est ce que fait Chrome (SingletonLock).

import path from 'node:path';
import os from 'node:os';

// Prefixe commun : identifie NOS canaux sans ambiguite dans l'espace de noms de la machine.
const PREFIX = 'pw-mcp-';

// Longueur max du chemin d'une socket de domaine Unix (`sun_path`) : 108 octets sur Linux,
// 104 sur macOS/BSD. On prend la borne la PLUS BASSE, moins le terminateur NUL.
// ⚠️ Depasser ne donne PAS une erreur claire : le noyau TRONQUE ou rend EINVAL selon la plateforme.
// On echoue donc NOUS-MEMES, bruyamment, plutot que de laisser naitre un canal au nom tronque
// (deux profils tronques au meme nom = partage de navigateur silencieux).
export const SUN_PATH_MAX = 103;

/**
 * Encode un nom de profil en un segment sur pour un nom de canal.
 * Tout ce qui n'est pas [A-Za-z0-9._-] devient %XX (majuscules, stable).
 * Injectif : deux profils distincts ne peuvent JAMAIS produire le meme segment.
 */
// ⚠️ Encodage NON precise : utf8 est le defaut de `Buffer.from`/`Buffer.byteLength` (doc Node).
// L'ecrire explicitement n'ajoutait aucun comportement mais 3 mutants EQUIVALENTS indistinguables
// (`Buffer.from(s, '')` retombe sur utf8 — mesure faite au node le 01/08). Moins de code, meme
// semantique, et le score de mutation redevient un signal au lieu d'un bruit a justifier.
// ⚠️ En revanche `padStart(2, '0')` est ESSENTIEL : mute en `padStart(2, '')` il rendait `%1`
// au lieu de `%01` — trouve par mutation, tue par test. Ne pas relacher celui-la.
export function encodeProfile(profile) {
  return String(profile).replace(/[^A-Za-z0-9._-]/g, (c) => {
    const bytes = Buffer.from(c);
    let out = '';
    for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    return out;
  });
}

/**
 * Nom du canal de lancement pour un profil, selon la plateforme.
 *
 * Windows : `\\.\pipe\pw-mcp-<profil>` — espace de noms dedie, aucune limite pratique de longueur,
 *           detruit par le noyau a la mort du dernier handle.
 * POSIX   : `<tmpdir>/pw-mcp-<profil>.sock` — le FICHIER survit a un crash (contrairement au pipe
 *           Windows) ; c'est a l'appelant de traiter l'orpheline par `connect` → ECONNREFUSED →
 *           `unlink` → re-`listen`. JAMAIS par un TTL.
 *
 * @param {string} profile
 * @param {{platform?: string, tmpdir?: string}} [env] injecte pour rendre la fonction TESTABLE
 *        sur les deux plateformes depuis n'importe quelle machine (determinisme des tests).
 * @returns {string}
 */
export function channelName(profile, env = {}) {
  const platform = env.platform || process.platform;
  const enc = encodeProfile(profile);
  if (enc === '') throw new Error('channelName: nom de profil vide');

  if (platform === 'win32') {
    // Espace de noms des named pipes : jamais de chemin de fichier, jamais de limite sun_path.
    return `\\\\.\\pipe\\${PREFIX}${enc}`;
  }

  const dir = env.tmpdir || os.tmpdir();
  const full = path.join(dir, `${PREFIX}${enc}.sock`);
  if (Buffer.byteLength(full) > SUN_PATH_MAX) {
    // ⚠️ FAILS-CLOSED. NE PAS "resoudre" en hachant le nom : un hash reintroduit la collision,
    // donc le partage de navigateur entre deux identites. Renommer le profil est la bonne reponse.
    throw new Error(
      `channelName: chemin de socket trop long (${Buffer.byteLength(full)} > ${SUN_PATH_MAX}) ` +
        `pour le profil "${profile}" — raccourcir le nom du profil.`
    );
  }
  return full;
}

/**
 * Le canal est-il un FICHIER susceptible de survivre a un crash ?
 * Vrai sur POSIX (socket de domaine Unix), faux sur Windows (le noyau detruit le pipe).
 * Determine si l'appelant doit gerer le cas « socket orpheline ».
 */
export function channelIsFile(env = {}) {
  return (env.platform || process.platform) !== 'win32';
}
