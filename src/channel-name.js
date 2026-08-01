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

/**
 * Segment identifiant l'UTILISATEUR, insere dans le nom du canal.
 *
 * ⚠️ POURQUOI (doc officielle Microsoft, « Named Pipe Security and Access Rights ») : sur Windows,
 *    TOUS les named pipes vivent dans UN SEUL espace de noms GLOBAL a la machine — il n'y a pas
 *    d'isolation par session. Sans ce segment, deux comptes Windows utilisant le meme nom de profil
 *    entrent en COLLISION : l'un empeche l'autre de lancer son serveur. Sur POSIX le probleme ne se
 *    pose qu'au repli sur /tmp (XDG_RUNTIME_DIR est deja par-utilisateur), mais on applique la meme
 *    regle PARTOUT : une regle uniforme ne peut pas etre oubliee sur une plateforme.
 * ⚠️ CECI N'EST PAS UNE MESURE DE SECURITE. Le DACL par defaut d'un named pipe accorde la LECTURE
 *    a Everyone, et Node n'expose aucun moyen de passer un security descriptor a `listen()`. Un
 *    autre utilisateur local peut donc toujours lire le port publie. Ce n'est PAS une regression :
 *    le serveur @playwright/mcp ecoute deja sur la loopback SANS authentification, il etait donc
 *    deja joignable par tout utilisateur local. NE PAS presenter ce segment comme une protection.
 * ⚠️ Repli sur 'anon' si l'utilisateur est illisible (conteneur sans passwd) : mieux vaut un canal
 *    partage qu'aucun canal — mais c'est un DEFAUT CONNU, pas un cas nominal.
 */
export function userSegment(info = null) {
  try {
    const u = (info || os.userInfo()).username;
    return typeof u === 'string' && u !== '' ? u : 'anon';
  } catch {
    return 'anon'; // os.userInfo() JETTE quand l'uid n'a pas d'entree passwd (conteneurs)
  }
}

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
 * Repertoire ou poser une socket de domaine Unix, par ordre de PREFERENCE.
 *
 * ⚠️ `$XDG_RUNTIME_DIR` d'abord : c'est le SEUL emplacement garanti non nettoye pendant la session
 *    (et en mode 0700). `/tmp` est purge par `systemd-tmpfiles` apres 10 jours d'inactivite du
 *    fichier — sur un service qui tourne des mois, c'est une CERTITUDE, pas un risque.
 * ⚠️ Repli sur `os.tmpdir()` quand la variable est absente (macOS, session non-systemd, cron) :
 *    mieux vaut un canal dans /tmp que pas de canal du tout. Le repli est un DEFAUT CONNU, pas
 *    une equivalence — ne pas le presenter comme tel.
 * ⚠️ Valeur RELATIVE ignoree : la spec XDG impose un chemin absolu ; une valeur relative viendrait
 *    d'un environnement casse et poserait la socket a un endroit imprevisible.
 */
export function runtimeDir(platform = process.platform, env = process.env) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (platform !== 'win32' && typeof xdg === 'string' && path.isAbsolute(xdg)) return xdg;
  return os.tmpdir();
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

  // ⚠️ Segment UTILISATEUR obligatoire sur les DEUX plateformes (cf `userSegment`) : sur Windows
  // l'espace de noms des pipes est GLOBAL a la machine, donc deux comptes se marcheraient dessus.
  const who = encodeProfile(userSegment(env.userInfo || null));

  if (platform === 'win32') {
    // Espace de noms des named pipes : jamais de chemin de fichier, jamais de limite sun_path.
    return `\\\\.\\pipe\\${PREFIX}${who}-${enc}`;
  }

  // ⚠️ `$XDG_RUNTIME_DIR` AVANT `os.tmpdir()`, et ce n'est PAS un detail de confort :
  // `systemd-tmpfiles` supprime par defaut ce qui n'a pas ete touche depuis **10 jours** dans
  // `/tmp` (doc officielle systemd.io/TEMPORARY_DIRECTORIES). Un serveur actif depuis 2 semaines
  // verrait donc son fichier socket EFFACE SOUS LUI alors qu'il vit ⇒ un nouveau proxy reussirait
  // son `listen()` ⇒ **DEUX lanceurs simultanes** ⇒ double spawn ⇒ « browser is already in use ».
  // La garantie d'exclusion du canal saute exactement au moment ou elle compte : la longue duree.
  // `$XDG_RUNTIME_DIR` est le repertoire prevu pour ca (sockets/pipes), en mode 0700 — donc il
  // corrige AUSSI le fait qu'une socket dans /tmp est lisible par les autres utilisateurs locaux.
  // ⚠️ `env.tmpdir` reste prioritaire : c'est l'injection des TESTS, jamais un chemin de prod.
  const dir = env.tmpdir || runtimeDir(platform);
  const full = path.join(dir, `${PREFIX}${who}-${enc}.sock`);
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
