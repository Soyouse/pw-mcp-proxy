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
 * Obtient l'URL du serveur d'un profil, en lançant le daemon si nécessaire.
 * @returns {Promise<{url:string, connexion:net.Socket}>} ⚠️ NE PAS fermer `connexion` tant que le
 *          profil sert : c'est elle qui maintient le serveur en vie.
 */
export async function acquerirProfil(profile, spec, env = {}, options = {}) {
  const nomCanal = daemonChannelName(env);

  for (let essai = 1; essai <= MAX_ESSAIS; essai++) {
    const sock = await connecter(nomCanal, env);
    if (sock) {
      const rep = await demander(sock, profile, spec, nomCanal);
      // ⚠️ `null` = le daemon s'est FERMÉ avant de répondre. COURSE RÉELLE, mesurée le 02/08 : le
      // dernier client d'un daemon s'en va, celui-ci sort (il n'a plus d'objet) et un autre proxy
      // se connecte pendant sa sortie — sa socket est acceptée puis tombe. C'est un FAIT du noyau,
      // pas une lenteur : on reboucle et on en lance un neuf. Sans ça, l'agent malchanceux
      // n'obtient JAMAIS son navigateur, pour une raison qu'il ne peut pas comprendre.
      if (rep) return rep;
      continue;
    }

    // Aucun daemon : en lancer un et ATTENDRE SON SIGNAL (jamais sonder en boucle).
    const signal = await lancerDaemon(nomCanal, options.maxBrowsers);
    if (signal === 'echec') throw new Error(`daemon ${nomCanal} : lancement impossible`);
    // 'ready' ⇒ il écoute · 'busy' ⇒ un autre a gagné la course : dans les DEUX cas, un daemon
    // est joignable maintenant. On reboucle pour s'y connecter — c'est un fait, pas une attente.
  }
  throw new Error(
    `daemon ${nomCanal} : ${MAX_ESSAIS} tentatives sans pouvoir s'y connecter ` +
      `(des daemons se cèdent le canal en boucle — anomalie, jamais une lenteur)`
  );
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
 * @returns {Promise<{url:string,connexion:net.Socket}|null>} `null` = le daemon s'est fermé avant
 *          de répondre (il sortait) : à l'appelant de reboucler — ce n'est PAS une erreur du profil.
 */
function demander(sock, profile, spec, nomCanal) {
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
      resolve({ url: rep.url, connexion: sock });
    });
    sock.on('error', (e) => reject(new Error(`daemon ${nomCanal} : ${describeError(e)}`)));
    writeMessage(sock, requeteAcquire(profile, spec));
  });
}

/**
 * Lance le daemon et attend SON SIGNAL sur stdout — pas un délai.
 * @returns {Promise<'ready'|'busy'|'echec'>}
 */
function lancerDaemon(nomCanal, maxBrowsers) {
  return new Promise((resolve) => {
    // ⚠️ `detached` : il doit SURVIVRE au proxy qui le lance (il porte les navigateurs des autres
    // agents). ⚠️ stdout en `pipe` UNIQUEMENT pour recevoir le signal : le daemon n'écrit qu'une
    // ligne puis se tait, donc aucun risque de pipe plein ni d'EPIPE quand ce proxy mourra.
    const args = [DAEMON_MAIN, nomCanal];
    if (maxBrowsers != null) args.push(String(maxBrowsers));
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
