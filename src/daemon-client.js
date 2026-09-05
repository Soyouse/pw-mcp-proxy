// I/O — CÔTÉ PROXY : obtenir l'URL d'un profil auprès du daemon, et GARDER la connexion ouverte.
//
// 🛑 LA CONNEXION RETOURNÉE **EST** LE REF-COUNT. Tant qu'elle vit, le daemon sait que ce proxy
// utilise ce profil. La fermer (switch, arrêt, crash, kill -9) est l'ÉVÉNEMENT « je n'en ai plus
// besoin » — délivré par le NOYAU, donc infalsifiable et jamais oublié.
// ⚠️ NE JAMAIS « optimiser » en fermant la connexion après avoir lu l'URL : le profil serait
// aussitôt libéré et le navigateur tué sous l'agent. La connexion ouverte n'est pas un détail
// d'implémentation, c'est le mécanisme entier.
//
// ⚠️ ZÉRO APPEL TEMPOREL dans ce fichier — et ce n'est pas une consigne, c'est vérifié : il est
// HORS du BUDGET de `no-inference-gate`, donc tout `setTimeout` le fait ROUGIR. Trois faits du
// noyau suffisent :
//     connect() réussit          le daemon est là
//     ENOENT / ECONNREFUSED      il n'y en a pas (ou une socket POSIX orpheline) ⇒ en lancer un
//     `ready\n` sur son stdout   il écoute VRAIMENT (modèle systemd Type=notify)

import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { daemonChannelName, channelIsFile } from './channel-name.js';
import { requeteAcquire, lireReponse } from './daemon-protocol.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_MAIN = path.join(__dirname, 'daemon-main.js');

// Borne d'ESSAIS (pas un délai) : chaque tour est déclenché par un ÉVÉNEMENT du noyau, jamais par
// une horloge. Elle n'existe que pour rendre un livelock IMPOSSIBLE — deux process qui se cèdent
// le canal indéfiniment. Au-delà : échec BRUYANT plutôt qu'une boucle silencieuse.
const MAX_ESSAIS = 3;

/**
 * Obtient l'URL d'une INSTANCE du profil (un serveur + un Chrome pour CE proxy), en lançant le
 * daemon si nécessaire. `options.instance` = description de l'identité à matérialiser (profil v2,
 * cf daemon-protocol `requeteAcquire`) ; absent pour un profil v1/isolé.
 * @returns {Promise<{url:string, instanceId:string, connexion:net.Socket}>} ⚠️ NE PAS fermer
 *          `connexion` tant que l'instance sert : c'est elle qui maintient le serveur en vie.
 */
export async function acquerirProfil(profile, spec, env = {}, options = {}) {
  // ═══ NŒUD DISTANT (05/09/2026) : `PW_MCP_DAEMON=tcp://<hôte>:<port>` (+ jeton dans le fichier
  // `PW_MCP_DAEMON_TOKEN_FILE`) ⇒ on parle au daemon d'une AUTRE machine. On ne lance JAMAIS un
  // daemon distant (c'est l'opérateur du nœud qui l'expose) : absent = erreur NOMMÉE, pas de boucle.
  const distant = options.daemonUrl ?? process.env.PW_MCP_DAEMON;
  if (distant) {
    const u = new URL(distant);
    if (u.protocol !== 'tcp:') throw new Error(`PW_MCP_DAEMON=${distant} : forme attendue tcp://<hôte>:<port>`);
    const tokenFile = options.tokenFile ?? process.env.PW_MCP_DAEMON_TOKEN_FILE;
    const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
    const sock = await connecterTcp(u.hostname, Number(u.port));
    if (!sock) throw new Error(`daemon distant ${distant} : injoignable (aucun daemon n'écoute, ou réseau) — il se lance sur le nœud, jamais d'ici`);
    const rep = await demander(sock, profile, spec, distant, options.instance || null, token);
    if (!rep) throw new Error(`daemon distant ${distant} : fermé avant de répondre`);
    return rep;
  }
  const nomCanal = daemonChannelName(env);

  for (let essai = 1; essai <= MAX_ESSAIS; essai++) {
    const sock = await connecter(nomCanal, env);
    if (sock) {
      const rep = await demander(sock, profile, spec, nomCanal, options.instance || null);
      // ⚠️ `null` = le daemon s'est FERMÉ avant de répondre. COURSE RÉELLE, mesurée le 02/08 : le
      // dernier client d'un daemon s'en va, celui-ci sort (il n'a plus d'objet) et un autre proxy
      // se connecte pendant sa sortie — sa socket est acceptée puis tombe. C'est un FAIT du noyau,
      // pas une lenteur : on reboucle et on en lance un neuf. Sans ça, l'agent malchanceux
      // n'obtient JAMAIS son navigateur, pour une raison qu'il ne peut pas comprendre.
      if (rep) return rep;
      continue;
    }

    // Aucun daemon : en lancer un et ATTENDRE SON SIGNAL (jamais sonder en boucle).
    const signal = await lancerDaemon(nomCanal, options.maxBrowsers, options.bindHost);
    if (signal === 'echec') throw new Error(`daemon ${nomCanal} : lancement impossible`);
    // 'ready' ⇒ il écoute · 'busy' ⇒ un autre a gagné la course : dans les DEUX cas, un daemon
    // est joignable maintenant. On reboucle pour s'y connecter — c'est un fait, pas une attente.
  }
  throw new Error(
    `daemon ${nomCanal} : ${MAX_ESSAIS} tentatives sans pouvoir s'y connecter ` +
      `(des daemons se cèdent le canal en boucle — anomalie, jamais une lenteur)`
  );
}

/** TCP vers un nœud distant : socket connectée, ou `null` (ECONNREFUSED/ETIMEDOUT/EHOSTUNREACH = personne). */
function connecterTcp(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const rate = (e) => { log(`daemon distant ${host}:${port} : ${describeError(e)}`); sock.destroy(); resolve(null); };
    sock.once('error', rate);
    sock.once('connect', () => { sock.removeListener('error', rate); resolve(sock); });
  });
}

/** Rend la socket connectée, ou `null` si aucun daemon n'écoute (fait exact du noyau). */
function connecter(nomCanal, env) {
  return new Promise((resolve) => {
    const sock = net.connect(nomCanal);
    const rate = (e) => {
      // ⚠️ POSIX : le FICHIER socket survit à un crash. `ECONNREFUSED` = plus personne n'écoute :
      // SEUL cas où l'on supprime quelque chose, et il est DÉTERMINISTE (le noyau vient de le
      // dire). Jamais un TTL, jamais « ce fichier a l'air vieux ».
      if (e.code === 'ECONNREFUSED' && channelIsFile(env)) {
        try { fs.unlinkSync(nomCanal); } catch { /* déjà nettoyé par un autre : tant mieux */ }
      }
      sock.destroy();
      resolve(null);
    };
    sock.once('error', rate);
    sock.once('connect', () => { sock.removeListener('error', rate); resolve(sock); });
  });
}

/**
 * 🛑 SOURCE UNIQUE : « le pair a disparu avant de répondre » — LE MÊME FAIT, que le noyau le
 * rapporte comme une fin de flux propre ou comme une coupure brutale.
 *
 * ⚠️ CE N'EST PAS UN AIGUILLAGE PAR OS, et il ne faut PAS en faire un. La doc Node ne garantit
 * AUCUNE différence entre socket Unix et named pipe sur ces événements (vérifiée à la source le
 * 03/08) : c'est la MANIÈRE DE MOURIR du pair qui varie, pas la plateforme. Un daemon qui sort
 * pendant qu'on lui parle produit un EOF s'il ferme proprement, un RST s'il disparaît — et les
 * deux veulent dire exactement « aucune réponse ne viendra de cette socket, en relancer un ».
 * ⚠️ MESURÉ EN CI le 03/08 (ubuntu, VERT sur Windows) : traité comme une ERREUR FATALE, ce RST
 * faisait échouer l'acquisition du profil au lieu de reboucler — l'agent n'obtenait JAMAIS son
 * navigateur, pour une raison qu'il ne pouvait pas comprendre.
 * ⚠️ NE JAMAIS y ajouter un code qui signifie autre chose (`EACCES`, `ENOENT`…) : ceux-là doivent
 * remonter BRUYAMMENT. Cette liste ne couvre QUE la disparition du pair.
 */
const PAIR_DISPARU = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

/**
 * @returns {Promise<{url:string,instanceId:string,connexion:net.Socket}|null>} `null` = le daemon
 *          s'est fermé avant de répondre (il sortait) : à l'appelant de reboucler — ce n'est PAS
 *          une erreur du profil.
 */
function demander(sock, profile, spec, nomCanal, instance, token = null) {
  return new Promise((resolve, reject) => {
    const lecteur = new NdjsonReader(sock);
    // Le daemon disparaît avant de répondre : fait exact, verdict immédiat (aucune attente).
    const coupe = () => resolve(null);
    lecteur.once('close', coupe);
    lecteur.once('message', (msg) => {
      lecteur.removeListener('close', coupe);
      const rep = lireReponse(msg);
      if (!rep.ok) { sock.destroy(); return reject(new Error(`profil ${profile} : ${rep.erreur}`)); }
      // ⚠️ La socket reste OUVERTE et est rendue à l'appelant : elle EST le ref-count.
      resolve({ url: rep.url, instanceId: rep.instanceId, connexion: sock });
    });
    sock.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
      // Le pair a disparu ⇒ MÊME verdict que `close` : on rebouclera, ce n'est pas l'échec du
      // profil. Toute AUTRE erreur reste fatale et NOMMÉE (cf PAIR_DISPARU).
      if (PAIR_DISPARU.has(e.code || '')) return coupe();
      reject(new Error(`daemon ${nomCanal} : ${describeError(e)}`));
    });
    writeMessage(sock, requeteAcquire(profile, spec, instance, token));
  });
}

/**
 * Lance le daemon et attend SON SIGNAL sur stdout — pas un délai.
 * @returns {Promise<'ready'|'busy'|'echec'>}
 */
function lancerDaemon(nomCanal, maxBrowsers, bindHost) {
  return new Promise((resolve) => {
    // ⚠️ `detached` : il doit SURVIVRE au proxy qui le lance (il porte les navigateurs des autres
    // agents). ⚠️ stdout en `pipe` UNIQUEMENT pour recevoir le signal : le daemon n'écrit qu'une
    // ligne puis se tait, donc aucun risque de pipe plein ni d'EPIPE quand ce proxy mourra.
    const args = [DAEMON_MAIN, nomCanal];
    if (maxBrowsers != null) args.push(String(maxBrowsers));
    // `bindHost` (05/09/2026) = l'adresse sur laquelle les serveurs ECOUTENT (defaut `localhost`).
    // Argument NOMME : la position libre est deja prise par le marqueur de test ci-dessous. Impose
    // au LANCEMENT comme la limite : le daemon ne lit aucune config, et le premier proxy decide.
    if (typeof bindHost === 'string' && bindHost.length > 0) args.push('--bind-host', bindHost);
    // 🛑 LE DAEMON DOIT ETRE VISIBLE DU RATCHET DE TEST — c'est la CAUSE RACINE du defaut #11
    // (« le daemon et ses serveurs survivent aux runs », 6 orphelins mesures le 03/08/2026).
    // Le ratchet du harnais scanne les CMDLINE a la recherche de son marqueur. Le gardien et le
    // serveur le portent (ils viennent de la `spec`, construite par `taggedArgs`), mais le daemon,
    // lui, est spawne ICI a partir de rien : sa cmdline etait VIERGE. Il echappait donc au scan,
    // survivait a la suite, et gardait ses serveurs avec lui — un orphelin INVISIBLE au gate cense
    // les interdire. Le gate existait, il regardait simplement a cote.
    // ⚠️ On propage l'ENVIRONNEMENT vers la CMDLINE : `PWMCP_TEST` est herite par tout l'arbre,
    // mais l'heritage n'est pas SCANNABLE de facon portable (lire l'env d'un tiers demande /proc
    // sous Linux et WMI sous Windows). La cmdline, elle, se lit partout et de la meme facon.
    // ⚠️ Position LIBRE : `lireLimite` rend `null` sur toute valeur non entiere (`Number(...)` =>
    // NaN), donc ce jeton ne peut pas etre confondu avec une limite meme s'il tombe en argv[3].
    // ⚠️ HORS TEST la variable est absente : la cmdline de PRODUCTION reste strictement inchangee.
    if (process.env.PWMCP_TEST) args.push(process.env.PWMCP_TEST);
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      windowsHide: true,
    });
    let fini = false;
    const finir = (v) => { if (fini) return; fini = true; child.unref(); resolve(v); };

    child.on('error', (e) => { log(`daemon: spawn — ${describeError(e)}`); finir('echec'); });
    // Mort AVANT tout signal = fait exact : inutile d'attendre quoi que ce soit.
    child.on('exit', () => finir('echec'));

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      if (buf.includes('ready')) return finir('ready');
      if (buf.includes('busy')) return finir('busy');
    });
  });
}
