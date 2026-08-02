// I/O — LE DAEMON UNIQUE : un process léger, parent de tous les serveurs `@playwright/mcp`.
//
// 🛑 LA CONNEXION EST LE REF-COUNT. Le nombre de sockets ouvertes sur le canal EST le nombre de
// clients d'un profil : exact, tenu par le NOYAU, libéré même si un proxy meurt d'un `kill -9`.
// C'est ce qui REMPLACE registre + verrou + heartbeat + TTL + reaper — les 10 inférences.
// ⚠️ NE JAMAIS ajouter de message « je suis là » / « je m'en vais » : ce serait remplacer un fait
// du noyau par une supposition, et réintroduire la classe de pannes qu'on supprime.
//
// POURQUOI UN DAEMON, et pourquoi UN SEUL (alternatives épuisées le 02/08, doc-first — cf skill) :
//   - `@playwright/mcp` n'a AUCUN auto-shutdown (~50 flags relus) ⇒ un superviseur externe est une
//     CONTRAINTE DU PRODUIT, pas un choix ;
//   - `systemd` (socket activation + StopWhenUnneeded) et `launchd` le feraient, mais Windows n'a
//     pas d'équivalent et le projet s'installe par `npx` sans droits admin ;
//   - un PROXY ne peut pas tenir ce rôle : s'il meurt, son successeur IGNORE le port du serveur ⇒
//     il faudrait le persister ⇒ le registre revient ⇒ on rejoue la panne du 31/07 ;
//   - un daemon PAR PROFIL ne peut pas porter la borne LRU (vue globale requise) ⇒ registre ⇒ idem.
//
// ⚠️ Le daemon ignore `profiles.json` : le proxy lui envoie la `spec` déjà calculée. Rien à
// recharger, rien à synchroniser, aucune config à faire dériver.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { daemonChannelName, channelIsFile } from './channel-name.js';
import { validerRequete, reponseOk, reponseErreur } from './daemon-protocol.js';
import { resolveShellSpawn } from './spawn-cmd.js';
import { allocateEphemeralPort } from './port-alloc.js';
import { attendreReady } from './readiness.js';
import { treeKill } from './prockill.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';
import { READY_TIMEOUT_MS } from './budget.js';
import fs from 'node:fs';

const BIND_HOST = 'localhost'; // défaut documenté ; le client se connecte sur le MÊME hôte
const URL_HOST = 'localhost'; // ⚠️ JAMAIS 127.0.0.1 : validation du Host header ⇒ 403

export class ServerDaemon {
  /**
   * @param {{env?:object, spawnFn?:Function, tuer?:Function, allouerPort?:Function,
   *          attendre?:Function, budgetMs?:number}} [options] injections pour les tests
   */
  constructor(options = {}) {
    this.env = options.env || {};
    this._spawn = options.spawnFn || spawn;
    this._tuer = options.tuer || treeKill;
    this._allouerPort = options.allouerPort || allocateEphemeralPort;
    this._attendre = options.attendre || attendreReady;
    this._budgetMs = options.budgetMs ?? READY_TIMEOUT_MS;

    // ⚠️ Le nom peut être IMPOSÉ par le lanceur (il l'a déjà calculé pour s'y connecter). Le
    // recalculer serait une SECONDE vérité : si les deux calculs divergent — env, utilisateur,
    // tmpdir — le daemon écoute un canal que personne n'appelle, et le client conclut « aucun
    // daemon » en boucle. Mesuré le 02/08 : 4 tests bout-en-bout rouges pour cette seule raison.
    this.nomCanal = options.nomCanal || daemonChannelName(this.env);
    this._serveur = null;
    /** profil -> {port, pid, url, clients:Set<net.Socket>} */
    this._profils = new Map();
    /** promesses de démarrage en cours : sérialise les demandes concurrentes du MÊME profil */
    this._enCours = new Map();
    this._arrete = false;
    // ⚠️ Rappel du PROPRIETAIRE du process (daemon-main). La classe ne sort JAMAIS elle-meme.
    this.onArret = options.onArret || null;
  }

  /**
   * Prend le canal. Rend `false` si un AUTRE daemon le tient déjà (`EADDRINUSE`) — fait EXACT du
   * noyau, aucune supposition : l'appelant n'a plus qu'à sortir, il est en trop.
   */
  async demarrer() {
    const srv = net.createServer();
    const pris = await new Promise((resolve, reject) => {
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE') return resolve(false);
        // ⚠️ Toute AUTRE erreur remonte : une permission refusée ne doit jamais être confondue
        // avec « quelqu'un d'autre est déjà là ».
        reject(new Error(`daemon ${this.nomCanal}: listen — ${describeError(e)}`));
      });
      srv.listen(this.nomCanal, () => { srv.removeAllListeners('error'); resolve(true); });
    });
    if (!pris) return false;

    this._serveur = srv;
    srv.on('error', (e) => log(`[daemon] erreur serveur: ${describeError(e)}`));
    srv.on('connection', (sock) => this._onConnexion(sock));
    log(`[daemon] canal ouvert ${this.nomCanal}`);
    return true;
  }

  _onConnexion(sock) {
    // ⚠️ Un client qui disparaît brutalement ne doit JAMAIS faire tomber le daemon : il sert N
    // agents, l'un d'eux ne peut pas les priver tous de navigateur.
    sock.on('error', () => {});
    // 🛑 FUITE MESUREE LE 02/08 (2 daemons orphelins observes) : `arreter()` n'etait appele QUE
    // depuis `_liberer`, donc un daemon qui n'a JAMAIS servi de profil — course perdue, client
    // parti avant sa demande, demarrage de serveur en echec — restait vivant POUR TOUJOURS. Un par
    // occurrence, silencieusement. Ici la question est posee a CHAQUE depart : « reste-t-il quelque
    // chose a faire ? ». Zero profil ET zero client = ce process n'a plus d'objet.
    sock.on('close', () => this._sortirSiInutile());
    const lecteur = new NdjsonReader(sock);
    lecteur.on('parse_error', () => this._repondre(sock, reponseErreur('message illisible')));
    lecteur.on('message', (msg) => this._onMessage(sock, msg));
  }

  async _onMessage(sock, msg) {
    const v = validerRequete(msg);
    if (!v.valide) return this._repondre(sock, reponseErreur(v.raison));
    try {
      const url = await this._acquerir(v.profile, v.spec, sock);
      this._repondre(sock, reponseOk(url));
    } catch (e) {
      this._repondre(sock, reponseErreur(describeError(e)));
    }
  }

  _repondre(sock, msg) {
    try { writeMessage(sock, msg); } catch (e) { log(`[daemon] réponse impossible: ${describeError(e)}`); }
  }

  /**
   * Garantit un serveur vivant pour `profil` et inscrit `sock` comme client.
   *
   * ⚠️ SÉRIALISÉ par `_enCours` : deux agents qui demandent le MÊME profil au même instant
   * partagent LA MÊME promesse de démarrage. Sans ça, deux spawns concurrents pour un seul
   * `--user-data-dir` ⇒ « browser is already in use ». C'est le seul point de course du daemon,
   * et il est résolu sans verrou : un process, un thread, une Map.
   */
  async _acquerir(profil, spec, sock) {
    const existant = this._profils.get(profil);
    if (existant) {
      this._inscrire(existant, sock, profil);
      return existant.url;
    }
    if (!this._enCours.has(profil)) {
      this._enCours.set(profil, this._demarrerServeur(profil, spec).finally(() => this._enCours.delete(profil)));
    }
    const etat = await this._enCours.get(profil);
    this._inscrire(etat, sock, profil);
    return etat.url;
  }

  _inscrire(etat, sock, profil) {
    etat.clients.add(sock);
    // ⚠️ LE REF-COUNT EST ICI, et nulle part ailleurs : la fermeture de la socket est l'ÉVÉNEMENT
    // exact « ce client n'utilise plus ce profil ». Vaut aussi pour un proxy tué brutalement.
    sock.once('close', () => this._liberer(profil, sock));
  }

  async _demarrerServeur(profil, spec) {
    const port = await this._allouerPort();
    const rawArgs = [...spec.args, '--host', BIND_HOST, '--port', String(port)];
    const { command, args, shell } = resolveShellSpawn(spec.command, rawArgs);
    // ⚠️ ENFANT, PAS détaché : le daemon EST le parent, c'est ce qui rend l'identité `(pid,
    // starttime)` inutile — un PID recyclé ne peut pas se glisser ici, on ne tue que notre enfant.
    const child = this._spawn(command, args, { stdio: 'ignore', windowsHide: true, shell });
    child.on('error', (e) => log(`[daemon:${profil}] spawn: ${describeError(e)}`));
    const pid = child.pid;
    if (!pid) throw new Error(`profil ${profil} : spawn avorté (aucun pid)`);

    const verdict = await this._attendre(port, { budgetMs: this._budgetMs, pid, host: URL_HOST });
    if (verdict !== 'pret') {
      try { this._tuer(pid); } catch {}
      throw new Error(
        verdict === 'mort'
          ? `profil ${profil} : le serveur s'est ARRÊTÉ avant d'écouter (cause dans sa sortie, pas le réseau)`
          : `profil ${profil} : serveur VIVANT mais silencieux après ${this._budgetMs}ms`
      );
    }
    const etat = { port, pid, url: `http://${URL_HOST}:${port}/mcp`, clients: new Set() };
    this._profils.set(profil, etat);
    // 🛑 LE SERVEUR PEUT MOURIR SANS QUE PERSONNE NE PARTE (crash, kill externe, OOM). Son `exit`
    // est un FAIT du noyau, delivre a NOUS parce que nous sommes son PARENT — le seul signal qui
    // dise « cette URL ne vaut plus rien ». Sans ce retrait, le daemon servirait indefiniment une
    // URL morte a chaque nouvel agent (mesure LIVE 02/08 : la reprise apres kill echouait).
    // ⚠️ On ne tue RIEN et on ne respawn RIEN ici : on OUBLIE. Le prochain `acquerir` redemarre
    // proprement — un respawn spontane serait une boucle de relance sans client pour la justifier.
    child.on('exit', (code, sig) => {
      if (this._profils.get(profil) !== etat) return; // deja remplace : evenement PERIME
      this._profils.delete(profil);
      log(`[daemon:${profil}] serveur MORT (pid=${pid} code=${code} sig=${sig}) — entree retiree`);
    });
    log(`[daemon:${profil}] serveur prêt pid=${pid} ${etat.url}`);
    return etat;
  }

  /**
   * Un client lâche un profil. DERNIER parti ⇒ le serveur n'a plus de raison de vivre.
   * ⚠️ Aucun délai, aucun TTL : `clients.size === 0` est un FAIT, pas une estimation.
   */
  _liberer(profil, sock) {
    const etat = this._profils.get(profil);
    if (!etat) return;
    etat.clients.delete(sock);
    if (etat.clients.size > 0) return; // d'AUTRES agents s'en servent : on ne touche à rien
    this._profils.delete(profil);
    try { this._tuer(etat.pid); } catch (e) { log(`[daemon:${profil}] arrêt: ${describeError(e)}`); }
    log(`[daemon:${profil}] dernier client parti — serveur arrêté (pid=${etat.pid})`);
    // Plus AUCUN profil servi : le daemon n'a plus d'objet. Il sort, le noyau détruit le canal.
    if (this._profils.size === 0) this.arreter();
  }

  /**
   * Ce daemon a-t-il encore une raison d'exister ? Zéro profil servi ET zéro client connecté.
   * ⚠️ Les DEUX conditions : un client peut être connecté sans (encore) tenir de profil — sortir
   * là le laisserait sans réponse. Et un profil peut vivre pendant qu'un client se reconnecte.
   * ⚠️ Le nombre de connexions est demandé au SERVEUR (donc au noyau), jamais compté à la main :
   * un compteur maison finirait par diverger, et c'est exactement ce que ce refactor supprime.
   */
  _sortirSiInutile() {
    if (this._arrete || this._profils.size > 0) return;
    // ⚠️ CETTE CLASSE NE SORT JAMAIS DU PROCESS. Elle est instanciée telle quelle par les tests :
    // un `process.exit()` ici tuerait le worker de test. Elle s'ARRÊTE, et c'est `daemon-main`
    // (seul propriétaire du process) qui en tire la conséquence via `onArret`.
    this._serveur?.getConnections((err, n) => {
      if (err || n > 0) return;
      log('[daemon] plus aucun profil ni client — arrêt');
      this.arreter();
    });
  }

  /** Arrêt propre. ⚠️ La correction n'en dépend PAS : à la mort du process, le noyau libère tout. */
  arreter() {
    if (this._arrete) return;
    this._arrete = true;
    for (const [profil, etat] of this._profils) {
      try { this._tuer(etat.pid); } catch (e) { log(`[daemon:${profil}] arrêt: ${describeError(e)}`); }
    }
    this._profils.clear();
    try { this._serveur?.close(); } catch {}
    // POSIX : le fichier socket survit à close(). Le retirer évite une orpheline après une sortie
    // PROPRE ; le cas du crash reste couvert côté client (ECONNREFUSED ⇒ unlink ⇒ re-listen).
    if (channelIsFile(this.env)) { try { fs.unlinkSync(this.nomCanal); } catch {} }
    log('[daemon] arrêté');
    try { this.onArret?.(); } catch (e) { log(`[daemon] onArret: ${describeError(e)}`); }
  }

  /** Observabilité (tests + diagnostic) : qui est servi, et par combien de clients. */
  etat() {
    return [...this._profils].map(([profil, e]) => ({ profil, port: e.port, pid: e.pid, clients: e.clients.size }));
  }
}
