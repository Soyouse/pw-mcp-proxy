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
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { daemonChannelName, channelIsFile } from './channel-name.js';
import { validerRequete, reponseOk, reponseErreur, lireLimite, placeDisponible } from './daemon-protocol.js';
import { allocateEphemeralPort } from './port-alloc.js';
import { attendreReady } from './readiness.js';
import { treeKill } from './prockill.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';
import { READY_TIMEOUT_MS } from './budget.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ Chemin ABSOLU du gardien : il est lance depuis un daemon dont le cwd est quelconque.
const CHILD_GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child-guard.js');

const BIND_HOST = 'localhost'; // défaut documenté ; le client se connecte sur le MÊME hôte
const URL_HOST = 'localhost'; // ⚠️ JAMAIS 127.0.0.1 : validation du Host header ⇒ 403

/**
 * 🛑 ÉVÉNEMENTS ÉMIS — OBSERVABILITÉ, jamais un canal de commande.
 *   `'libere'` {profil, restants}  un client a lâché ce profil ; `restants` = ref-count APRÈS.
 *
 * ⚠️ RAISON D'ÊTRE (mesurée en CI le 03/08) : le daemon est la SEULE AUTORITÉ sur le ref-count.
 * Un observateur qui attend la fermeture de sa PROPRE socket puis suppose que le daemon a
 * décompté s'appuie sur un ORDRE QUE LA DOC NE GARANTIT PAS — « il n'existe pas de garantie
 * d'ordre entre le `close` client et le `close` serveur » (doc Node `net`, vérifiée 03/08).
 * Windows gagnait la course, POSIX la perdait : 3 tests ROUGES sur ubuntu+macOS, VERTS sur Windows.
 * ⚠️ Attendre CET événement, jamais la fermeture de sa propre extrémité, et JAMAIS un délai.
 * ⚠️ Ne JAMAIS transformer ces événements en ordres : le daemon décide seul de la vie des serveurs.
 */
export class ServerDaemon extends EventEmitter {
  /**
   * @param {{env?:object, spawnFn?:Function, tuer?:Function, allouerPort?:Function,
   *          attendre?:Function, budgetMs?:number, nomCanal?:string, onArret?:Function,
   *          limite?:number|string}} [options] injections des tests + parametres imposes par le lanceur
   */
  constructor(options = {}) {
    super();
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
    // 🛑 LIMITE OPTIONNELLE (`maxBrowsers`), ABSENTE PAR DÉFAUT. Elle REFUSE un profil de plus ;
    // elle n'ÉVINCE JAMAIS. Évincer tuerait le navigateur d'un agent EN PLEINE ACTION (chaque
    // serveur vivant a, par construction, au moins un client qui le tient) — soit exactement la
    // violation du scénario S5 qu'on protège partout ailleurs. Refuser est bruyant et sans dégât ;
    // évincer serait silencieux et destructeur. ⚠️ NE JAMAIS transformer ceci en LRU.
    this.limite = lireLimite(options.limite);
  }

  /**
   * Prend le canal. Rend `false` si un AUTRE daemon le tient déjà (`EADDRINUSE`) — fait EXACT du
   * noyau, aucune supposition : l'appelant n'a plus qu'à sortir, il est en trop.
   */
  async demarrer() {
    const srv = net.createServer();
    const pris = await new Promise((resolve, reject) => {
      srv.once('error', (/** @type {NodeJS.ErrnoException} */ e) => {
        // ⚠️ `ErrnoException`, pas `Error` : c'est `e.code` qui porte le FAIT (`EADDRINUSE`), et
        // le type `Error` ne le declare pas — meme logique que l'interdiction de `err.message` nu.
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
    // ⚠️ Le contrôle porte sur la CRÉATION seulement : rejoindre un profil déjà servi est du
    // partage, il ne coûte aucun navigateur de plus (et le refuser casserait le multi-agent).
    if (!placeDisponible(this._profils.size, this.limite)) {
      throw new Error(
        `limite maxBrowsers=${this.limite} atteinte (${this._profils.size} profils servis) — profil ` +
        `"${profil}" REFUSÉ. Aucun navigateur existant n'a été touché : relâchez un profil, ou ` +
        `augmentez/retirez maxBrowsers dans profiles.json (absent = illimité).`
      );
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
    // 🛑 ON NE LANCE JAMAIS LE SERVEUR DIRECTEMENT : on lance un GARDIEN (`child-guard.js`) qui le
    // porte. Le gardien tient notre stdin ; si CE daemon meurt brutalement (`kill -9`, OOM), le
    // noyau ferme le tuyau, le gardien recoit EOF et tue le serveur. L'ORPHELIN — un serveur qui
    // survit sans parent en tenant son `--user-data-dir` a vie — devient IMPOSSIBLE, sans le
    // moindre balayage au demarrage ni aucun jugement sur des process existants.
    // ⚠️ NE JAMAIS re-spawner le serveur en direct « pour economiser un process » : on rachèterait
    // cette classe de pannes. ⚠️ `stdio[0]='pipe'` EST le lien de vie — ne pas le passer a 'ignore'.
    // ⚠️ Le gardien est lance NU (chemin absolu de node, aucun shell) : a travers un shell, le
    // tuyau appartiendrait a `cmd.exe` et l'EOF n'atteindrait jamais le gardien. C'est LUI qui
    // resout le shell pour la vraie commande (via `spawn-cmd.js`, source unique).
    // 🛑 `detached` SUR POSIX = LE GARDIEN DEVIENT CHEF DE SON GROUPE (pgid === pid). OBLIGATOIRE,
    // et ce n'est PAS une optimisation : `treeKill` tue par GROUPE (`kill(-pid)`) sur POSIX.
    // Sans ça (defaut mesure en CI le 03/08, ROUGE sur ubuntu ET macOS, VERT sur Windows) :
    //   1. le gardien herite du groupe du DAEMON ⇒ `kill(-pidGardien)` ne designe aucun groupe ;
    //   2. repli sur `kill(pidGardien)` ⇒ SIGKILL, que le gardien NE PEUT PAS intercepter ⇒ son
    //      `partir()` ne tourne jamais ⇒ **le serveur @playwright/mcp SURVIT, orphelin**, port
    //      toujours ouvert. C'est la fuite de navigateur que tout ce design existe pour interdire.
    //   3. PIRE, latent : l'espace des pgid est celui des pid ⇒ si un groupe ETRANGER porte l'id du
    //      gardien, `kill(-pid)` tue le process d'un TIERS. Action destructive sur une inference.
    // Windows ne discrimine pas (`taskkill /T /F` tue l'arbre) : le defaut y restait invisible.
    // ⚠️ `detached` NE CASSE PAS le lien de vie du gardien : il change le GROUPE, jamais les
    // descripteurs — `stdio[0]='pipe'` reste notre tuyau, donc l'EOF arrive toujours (cf child-guard).
    // ⚠️ NE PAS retirer, et NE PAS l'appliquer sur Windows (`detached` y ouvre une console).
    const child = this._spawn(process.execPath, [CHILD_GUARD, spec.command, ...rawArgs], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.on('error', (e) => log(`[daemon:${profil}] spawn: ${describeError(e)}`));
    const pid = child.pid;
    if (!pid) throw new Error(`profil ${profil} : spawn avorté (aucun pid)`);

    const verdict = await this._attendre(port, { budgetMs: this._budgetMs, pid, host: URL_HOST });
    if (verdict !== 'pret') {
      // ⚠️ PAS DE SILENCE ICI : si ce kill echoue, le serveur avorte SURVIT en tenant son
      // `--user-data-dir`, et plus personne ne le connait (on n'a jamais inscrit ce profil).
      // C'est exactement l'orphelin que tout le reste du design supprime — il DOIT crier.
      try { this._tuer(pid); } catch (e) { log(`[daemon:${profil}] FUITE POSSIBLE — arret du serveur avorte impossible (pid=${pid}): ${describeError(e)}`); }
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
    // ⚠️ ÉMIS AVANT toute décision, et dans TOUS les cas (dernier parti ou non) : c'est le FAIT
    // « le daemon a décompté », seule vérité opposable sur le ref-count. Un observateur qui
    // attendrait la fermeture de sa PROPRE socket parierait sur un ordre non contractuel.
    this.emit('libere', { profil, restants: etat.clients.size });
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
    try { this._serveur?.close(); } catch { /* SILENCE: arret — le noyau detruit le canal a la mort du process de toute facon */ }
    // POSIX : le fichier socket survit à close(). Le retirer évite une orpheline après une sortie
    // PROPRE ; le cas du crash reste couvert côté client (ECONNREFUSED ⇒ unlink ⇒ re-listen).
    if (channelIsFile(this.env)) { try { fs.unlinkSync(this.nomCanal); } catch { /* SILENCE: fichier deja retire (autre daemon, nettoyage OS) ; le client sait traiter une socket orpheline via ECONNREFUSED */ } }
    log('[daemon] arrêté');
    try { this.onArret?.(); } catch (e) { log(`[daemon] onArret: ${describeError(e)}`); }
  }

  /** Observabilité (tests + diagnostic) : qui est servi, et par combien de clients. */
  etat() {
    return [...this._profils].map(([profil, e]) => ({ profil, port: e.port, pid: e.pid, clients: e.clients.size }));
  }
}
