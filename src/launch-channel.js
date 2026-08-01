// I/O — CANAL DE LANCEMENT : « qui a le droit de lancer le serveur de ce profil ? »
//
// REMPLACE le verrou fichier (peremption + vol + meta-verrou), cause de la panne de ~5 h du
// 31/07→01/08/2026. Le verrou n'etait PAS orphelin : il etait SATURE. Un delai avait ete charge
// de DECIDER un fait local, et sous charge il a decide faux, en boucle.
//
// PRINCIPE — on n'interroge que ce qui SAIT :
//   `listen(nom)` reussit          ⇒ le NOYAU m'a designe lanceur. Fait exact, pas une opinion.
//   `EADDRINUSE`                   ⇒ le NOYAU dit qu'un lanceur existe. Fait exact.
//   la connexion se ferme          ⇒ le NOYAU dit que le lanceur est mort. Fait exact.
// Aucune de ces trois questions n'a besoin d'un delai : il n'y a AUCUN setTimeout dans ce fichier,
// et le gate `no-inference-gate.test.js` l'exige (ce fichier n'est PAS dans son BUDGET).
//
// ⚠️ VERROU PERIME IMPOSSIBLE PAR CONSTRUCTION : le noyau detruit le canal a la mort du processus,
//    immediatement. Il n'y a plus rien a « perimer », donc plus de TTL, plus de vol, plus de course.
// ⚠️ NE JAMAIS revenir a un lockfile (`proper-lockfile` & co reimplementent la peremption par delai),
//    ni a un port TCP (ressource GLOBALE : collision avec un tiers), ni a etcd/ZooKeeper (consensus
//    INTER-machines ; ici tout est local, le noyau est deja l'autorite commune).
// ⚠️ Le canal est AUSSI le rendez-vous : le lanceur y publie « le serveur ecoute sur le port X ».
//    Verrou et decouverte deviennent le MEME objet — c'est ce qui permet de supprimer la contention
//    du registre fichier.

import net from 'node:net';
import fs from 'node:fs';
import { channelName, channelIsFile } from './channel-name.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';

// Borne d'essais. ⚠️ Ce n'est PAS un delai : chaque tour est declenche par un EVENEMENT du noyau
// (EADDRINUSE, fermeture de socket, ECONNREFUSED), jamais par une horloge. La borne n'existe que
// pour rendre un livelock IMPOSSIBLE (deux processus qui se cedent le canal indefiniment) : au-dela,
// on echoue BRUYAMMENT plutot que de tourner en silence.
const MAX_ATTEMPTS = 5;

/**
 * Prend le role de lanceur, ou suit celui qui l'a deja.
 *
 * @param {string} profile
 * @param {{platform?:string, tmpdir?:string}} [env]
 * @returns {Promise<{role:'leader', publish:(port:number)=>void, close:()=>void}
 *                 | {role:'follower', port:number}>}
 */
export async function acquireLaunchChannel(profile, env = {}) {
  const name = channelName(profile, env);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const leader = await tryListen(name);
    if (leader) return makeLeader(name, leader, env);

    // Le noyau dit : quelqu'un tient deja le canal. On le suit.
    const followed = await tryFollow(name, env);
    if (followed.port !== undefined) return { role: 'follower', port: followed.port };

    // Deux seuls cas ici, tous deux EVENEMENTIELS (jamais un timeout) :
    //  - 'refused'  : POSIX, fichier socket orphelin d'un crash — deja unlink, on reessaie listen.
    //  - 'closed'   : le lanceur est mort AVANT de publier — le canal est libre, on reessaie listen.
    // Dans les deux cas la bonne action est identique : reboucler pour devenir lanceur.
  }

  // ⚠️ Message qui NOMME la situation reelle. Ne jamais accuser « le serveur n'est pas pret » :
  // c'est le message qui avait envoye le diagnostic du 31/07 sur une fausse piste.
  throw new Error(
    `canal de lancement ${name} : ${MAX_ATTEMPTS} alternances lanceur/suiveur sans issue ` +
      `(des processus se cedent le canal en boucle)`
  );
}

/**
 * Tente de devenir lanceur. Rend le serveur si le noyau nous l'accorde, null sur EADDRINUSE.
 * ⚠️ Toute autre erreur REMONTE : une permission refusee ou un chemin invalide doit etre bruyante,
 *    jamais confondue avec « quelqu'un d'autre lance ».
 */
function tryListen(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') return resolve(null);
      reject(new Error(`canal ${name}: listen — ${describeError(e)}`));
    });
    server.listen(name, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

/**
 * Suit le lanceur en place : lit le port qu'il publie.
 * Rend `{port}` si le lanceur a publie, `{reason:'closed'}` s'il est mort avant, ou
 * `{reason:'refused'}` si la socket POSIX etait orpheline (auquel cas elle est deja supprimee).
 */
function tryFollow(name, env) {
  return new Promise((resolve) => {
    const sock = net.connect(name);
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // message incomplet : on attend la suite (framing par ligne)
      try {
        const msg = JSON.parse(buf.slice(0, nl));
        if (typeof msg.port === 'number') return finish({ port: msg.port });
      } catch (e) {
        log(`canal ${name}: annonce illisible — ${describeError(e)}`);
      }
      finish({ reason: 'closed' }); // annonce invalide : on traite le lanceur comme absent
    });

    sock.on('error', (e) => {
      // ECONNREFUSED sur POSIX = le FICHIER socket a survecu a un crash mais plus personne n'ecoute.
      // ⚠️ SEUL cas ou l'on supprime quelque chose, et il est DETERMINISTE : le noyau vient de nous
      //    dire que personne n'ecoute. Jamais un TTL, jamais une inference « ça a l'air vieux ».
      if (e.code === 'ECONNREFUSED' && channelIsFile(env)) {
        try {
          fs.unlinkSync(name);
        } catch { /* deja disparu : une autre instance a nettoye, tant mieux */ }
        return finish({ reason: 'refused' });
      }
      // ENOENT = le canal a disparu entre le EADDRINUSE et notre connexion : course normale, on reessaie.
      finish({ reason: 'closed' });
    });

    // Le lanceur est mort avant de publier : le noyau ferme la socket. Fait exact, zero delai.
    sock.on('close', () => finish({ reason: 'closed' }));
  });
}

/**
 * Enveloppe le serveur en role « lanceur » : il publie le port a tout suiveur, present ou futur.
 */
function makeLeader(name, server, env) {
  let port; // undefined tant que le serveur @playwright/mcp n'ecoute pas
  const waiting = new Set();

  const announce = (sock) => {
    try {
      sock.write(JSON.stringify({ port }) + '\n');
    } catch (e) {
      log(`canal ${name}: annonce impossible — ${describeError(e)}`);
    }
  };

  server.on('connection', (sock) => {
    sock.on('error', () => {}); // un suiveur qui disparait ne doit JAMAIS faire tomber le lanceur
    if (port !== undefined) return announce(sock);
    waiting.add(sock);
    sock.on('close', () => waiting.delete(sock));
  });
  server.on('error', (e) => log(`canal ${name}: erreur serveur — ${describeError(e)}`));

  return {
    role: 'leader',
    /** Publie le port : les suiveurs deja connectes sont servis immediatement. */
    publish(p) {
      port = p;
      for (const sock of waiting) announce(sock);
      waiting.clear();
    },
    /**
     * Libere le canal. ⚠️ A appeler au shutdown, mais ce n'est PAS ce qui garantit la liberation :
     * le noyau detruit le canal a la mort du processus, meme sur un crash brutal. C'est toute la
     * raison d'etre de ce module — la correction ne depend d'AUCUN nettoyage volontaire.
     */
    close() {
      try {
        server.close();
      } catch { /* deja ferme */ }
      // POSIX : le fichier socket survit a close(). On le retire pour ne pas laisser d'orpheline
      // derriere une sortie PROPRE (le cas du crash reste couvert par ECONNREFUSED cote suiveur).
      if (channelIsFile(env)) {
        try {
          fs.unlinkSync(name);
        } catch { /* deja disparu */ }
      }
    },
  };
}
