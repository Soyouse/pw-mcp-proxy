// I/O — LE DAEMON UNIQUE : un process léger, parent de tous les serveurs `@playwright/mcp`.
//
// 🛑 LA CONNEXION EST LE REF-COUNT. Depuis le 05/09/2026, UNE socket = UNE INSTANCE (un serveur +
// un Chrome + un dossier de profil JETABLE). La fermeture de la socket est l'événement EXACT
// « cette instance n'a plus de client » : tenu par le NOYAU, libéré même si un proxy meurt d'un
// `kill -9`. C'est ce qui REMPLACE registre + verrou + heartbeat + TTL + reaper — les 10 inférences.
// ⚠️ NE JAMAIS ajouter de message « je suis là » / « je m'en vais » : ce serait remplacer un fait
// du noyau par une supposition, et réintroduire la classe de pannes qu'on supprime.
//
// ═══ POURQUOI PLUS DE SERVEUR PARTAGÉ (mesuré le 04/09/2026, BACKLOG « PLAN DE CHANTIER SWARM ») ═══
// Un serveur `--user-data-dir X --shared-browser-context` servi à N clients = UN contexte, UN onglet
// courant : quand B navigue, A voit la page de B (la collision du 03/09, reproduite en test). Et
// sans le flag, le 2e client prend « Browser is already in use ». Le seul parallélisme réel = un
// navigateur par client. Le daemon reste UNIQUE (vue globale pour `maxBrowsers`, parent de tous
// les serveurs), mais il ne PARTAGE plus rien : il MATÉRIALISE une identité (copie de son snapshot
// dans un dossier neuf, `identity-store.js`) pour chaque client, et la RANGE (snapshot retour) quand
// il part. Deux clients de la même identité = deux instances, deux Chrome, deux dossiers.
//
// POURQUOI UN DAEMON, et pourquoi UN SEUL (alternatives épuisées le 02/08, doc-first — cf skill) :
//   - `@playwright/mcp` n'a AUCUN auto-shutdown (~50 flags relus) ⇒ un superviseur externe est une
//     CONTRAINTE DU PRODUIT, pas un choix ;
//   - `systemd` (socket activation + StopWhenUnneeded) et `launchd` le feraient, mais Windows n'a
//     pas d'équivalent et le projet s'installe par `npx` sans droits admin ;
//   - un PROXY ne peut pas tenir ce rôle : s'il meurt, son successeur IGNORE le port du serveur ⇒
//     il faudrait le persister ⇒ le registre revient ⇒ on rejoue la panne du 31/07 ;
//   - un daemon PAR IDENTITÉ ne peut pas porter la borne globale (vue globale requise) ⇒ registre ⇒ idem.
//
// ⚠️ Le daemon ignore `profiles.json` : le proxy lui envoie la `spec` déjà calculée ET la description
// de l'instance (identité, stratégie, coffre, plafonds). Rien à recharger, rien à synchroniser.

import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { daemonChannelName, channelIsFile } from './channel-name.js';
import { validerRequete, reponseOk, reponseErreur, lireLimite, placeDisponible } from './daemon-protocol.js';
import { instanceId as fabriquerInstanceId } from './identity-store-pure.js';
import { materialiser, snapshotRetour, supprimerInstance, attendreLibre, ecrireConfigInstance, supprimerConfigInstance } from './identity-store.js';
import { cheminsCoffre } from './identity-store-pure.js';
import os from 'node:os';
import { allocateEphemeralPort } from './port-alloc.js';
import { attendreReady } from './readiness.js';
import { treeKill } from './prockill.js';
import { describeError } from './error-detail.js';
import { log } from './logger.js';
import { alert } from './notify.js';
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
 *   `'libere'` {profil, identite, instanceId, restants}  une instance s'est terminée ;
 *              `restants` = nombre d'instances ENCORE vivantes de ce PROFIL après ce départ.
 *
 * ⚠️ RAISON D'ÊTRE (mesurée en CI le 03/08) : le daemon est la SEULE AUTORITÉ sur le ref-count.
 * Un observateur qui attend la fermeture de sa PROPRE socket puis suppose que le daemon a
 * décompté s'appuie sur un ORDRE QUE LA DOC NE GARANTIT PAS — « il n'existe pas de garantie
 * d'ordre entre le `close` client et le `close` serveur » (doc Node `net`, vérifiée 03/08).
 * Windows gagnait la course, POSIX la perdait : 3 tests ROUGES sur ubuntu+macOS, VERTS sur Windows.
 * ⚠️ `'libere'` est émis APRÈS le rangement de l'instance (kill → exit → snapshot → rm) : c'est
 * le fait « le daemon a fini avec cette instance », pas seulement « il a décompté ».
 * ⚠️ Attendre CET événement, jamais la fermeture de sa propre extrémité, et JAMAIS un délai.
 * ⚠️ Ne JAMAIS transformer ces événements en ordres : le daemon décide seul de la vie des serveurs.
 */
export class ServerDaemon extends EventEmitter {
  /**
   * @param {{env?:object, spawnFn?:Function, tuer?:Function, allouerPort?:Function,
   *          attendre?:Function, budgetMs?:number, nomCanal?:string, onArret?:Function,
   *          limite?:number|string, bindHost?:string, listen?:{host:string, port:number}, token?:string,
   *          store?:{materialiser:Function, snapshotRetour:Function, supprimerInstance:Function, attendreLibre:Function, ecrireConfigInstance:Function, supprimerConfigInstance:Function},
   *          alerter?:Function}} [options] injections des tests + parametres imposes par le lanceur
   */
  constructor(options = {}) {
    super();
    this.env = options.env || {};
    this._spawn = options.spawnFn || spawn;
    this._tuer = options.tuer || treeKill;
    this._allouerPort = options.allouerPort || allocateEphemeralPort;
    this._attendre = options.attendre || attendreReady;
    this._budgetMs = options.budgetMs ?? READY_TIMEOUT_MS;
    // Le coffre est INJECTABLE (tests : un store en memoire, zero disque) ; defaut = identity-store.js.
    this._store = options.store || { materialiser, snapshotRetour, supprimerInstance, attendreLibre, ecrireConfigInstance, supprimerConfigInstance };
    this._alerter = options.alerter || alert;
    // ⚠️ ADRESSE D'ECOUTE des serveurs (05/09/2026). Defaut `localhost` = le produit OSS marche partout.
    // Hors loopback (carte dediee, adresse VALIDEE par le manager : jamais routable) pour sortir de la
    // classe libuv `uv__is_loopback` sous Windows — mesuree en live le 05/09 : `POST ETIMEDOUT` vers
    // localhost pendant le lancement de deux Chrome. Le serveur recoit alors `--allowed-hosts`
    // (validation du Host header, sinon 403). Allocation du port SUR LA MEME CHAINE (double pile).
    this.hote = typeof options.bindHost === 'string' && options.bindHost.length > 0 ? options.bindHost : BIND_HOST;

    // ⚠️ Le nom peut être IMPOSÉ par le lanceur (il l'a déjà calculé pour s'y connecter). Le
    // recalculer serait une SECONDE vérité : si les deux calculs divergent — env, utilisateur,
    // tmpdir — le daemon écoute un canal que personne n'appelle, et le client conclut « aucun
    // daemon » en boucle. Mesuré le 02/08 : 4 tests bout-en-bout rouges pour cette seule raison.
    this.nomCanal = options.nomCanal || daemonChannelName(this.env);
    // ═══ NŒUD DISTANT (05/09/2026) — 2e implémentation du contrat « un navigateur se désigne par une
    // ADRESSE ». `listen` = {host, port} ⇒ le daemon écoute en TCP au lieu du tuyau local, et EXIGE
    // un `token` sur chaque requête (comparaison à temps constant). Le tuyau local reste protégé
    // par l'OS (même utilisateur) ; un canal TCP ne l'est par RIEN d'autre que ce jeton.
    // ⚠️ Jeton ABSENT + listen TCP = REFUS au démarrage : un daemon réseau sans jeton offrirait
    // des navigateurs connectés à tout le réseau. Le jeton vient d'un FICHIER (jamais argv : visible
    // dans `ps`). ⚠️ La validation « bindHost jamais routable » (manager) NE s'applique PAS au daemon
    // lancé à la main sur un nœud : c'est l'opérateur qui l'expose, sur SON overlay (Tailscale),
    // et c'est l'exception NOMMÉE de bind-host-pure.js.
    this.listen = options.listen || null;
    this.token = typeof options.token === 'string' && options.token.length > 0 ? options.token : null;
    if (this.listen && !this.token) throw new Error('daemon: écoute TCP sans jeton — REFUSÉ (un canal réseau sans jeton offre les navigateurs au réseau)');
    this._serveur = null;
    /** instanceId -> {instanceId, profil, identite, instance, dir, port, pid, child, url, sock, fini} */
    this._instances = new Map();
    /** identite|profil -> compteur d'instances (mono-thread, jamais persiste : un daemon neuf repart a 1) */
    this._compteurs = new Map();
    /** identite -> promesse en cours : SÉRIALISE materialiser/snapshotRetour d'une MÊME identité */
    this._files = new Map();
    // 🛑 RANGEMENTS EN VOL. Une instance est retirée de `_instances` DÈS le début de son rangement
    // (kill → exit → snapshot → rm), qui est ASYNCHRONE. Sans ce compteur, le daemon voyait « zéro
    // instance, zéro client » pendant qu'un rangement courait encore, s'arrêtait, et `daemon-main`
    // SORTAIT DU PROCESS au milieu de la copie : identité PERDUE, dossier d'instance orphelin.
    // Mesuré en live le 05/09/2026 (`live-1` jamais rangé pendant que `live-2` finissait).
    this._rangements = 0;
    this._arrete = false;
    // ⚠️ Rappel du PROPRIETAIRE du process (daemon-main). La classe ne sort JAMAIS elle-meme.
    this.onArret = options.onArret || null;
    // 🛑 LIMITE OPTIONNELLE (`maxBrowsers`), ABSENTE PAR DÉFAUT. Elle REFUSE une instance de plus ;
    // elle n'ÉVINCE JAMAIS. Évincer tuerait le navigateur d'un agent EN PLEINE ACTION (chaque
    // instance vivante a, par construction, un client qui la tient) — soit exactement la
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
      const pret = () => { srv.removeAllListeners('error'); resolve(true); };
      if (this.listen) srv.listen(this.listen.port, this.listen.host, pret);
      else srv.listen(this.nomCanal, pret);
    });
    if (!pris) return false;

    this._serveur = srv;
    srv.on('error', (e) => log(`[daemon] erreur serveur: ${describeError(e)}`));
    srv.on('connection', (sock) => this._onConnexion(sock));
    const adr = srv.address();
    const portReel = adr && typeof adr === 'object' ? adr.port : this.listen?.port;
    log(`[daemon] canal ouvert ${this.listen ? `tcp://${this.listen.host}:${portReel} (jeton exigé)` : this.nomCanal}`);
    return true;
  }

  /** Le jeton reçu vaut-il le nôtre ? Comparaison à TEMPS CONSTANT (jamais `===` sur un secret). */
  _jetonValide(recu) {
    if (!this.token) return true; // tuyau local : pas de jeton, l'OS protège
    if (typeof recu !== 'string') return false;
    const a = Buffer.from(recu, 'utf8'), b = Buffer.from(this.token, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  _onConnexion(sock) {
    // ⚠️ Un client qui disparaît brutalement ne doit JAMAIS faire tomber le daemon : il sert N
    // agents, l'un d'eux ne peut pas les priver tous de navigateur.
    sock.on('error', () => {});
    // 🛑 FUITE MESUREE LE 02/08 (2 daemons orphelins observes) : `arreter()` n'etait appele QUE
    // depuis `_liberer`, donc un daemon qui n'a JAMAIS servi de profil — course perdue, client
    // parti avant sa demande, demarrage de serveur en echec — restait vivant POUR TOUJOURS. Un par
    // occurrence, silencieusement. Ici la question est posee a CHAQUE depart : « reste-t-il quelque
    // chose a faire ? ». Zero instance ET zero client = ce process n'a plus d'objet.
    sock.on('close', () => this._sortirSiInutile());
    const lecteur = new NdjsonReader(sock);
    lecteur.on('parse_error', () => this._repondre(sock, reponseErreur('message illisible')));
    lecteur.on('message', (msg) => this._onMessage(sock, msg));
  }

  async _onMessage(sock, msg) {
    const v = validerRequete(msg);
    if (!v.valide) return this._repondre(sock, reponseErreur(v.raison));
    if (!this._jetonValide(v.token)) {
      // Refus NOMMÉ puis socket DÉTRUITE : un client sans jeton n'a rien à faire sur ce canal, et on
      // ne le laisse pas rester connecté (il compterait comme « client » pour _sortirSiInutile).
      log(`[daemon] jeton invalide ou absent depuis ${sock.remoteAddress || 'inconnu'} — refusé`);
      this._repondre(sock, reponseErreur('jeton invalide ou absent (canal réseau)'));
      sock.destroy();
      return;
    }
    try {
      const etat = await this._acquerir(v.profile, v.spec, v.instance, sock);
      this._repondre(sock, reponseOk(etat.url, etat.instanceId));
    } catch (e) {
      this._repondre(sock, reponseErreur(describeError(e)));
    }
  }

  _repondre(sock, msg) {
    try { writeMessage(sock, msg); } catch (e) { log(`[daemon] réponse impossible: ${describeError(e)}`); }
  }

  /**
   * SÉRIALISE une opération sur le coffre d'une identité : deux clients de la MÊME identité qui
   * arrivent au même instant ne copient pas le snapshot pendant qu'un troisième le REMPLACE
   * (`snapshotRetour` fait des `rename` : une copie qui les traverse lit un dossier en mouvement).
   * Un process, un thread, une Map de promesses — aucun verrou. Identités DIFFÉRENTES = parallèle.
   */
  _serie(cle, fn) {
    const precedente = this._files.get(cle) || Promise.resolve();
    const courante = precedente.then(fn, fn); // l'echec du precedent ne bloque jamais le suivant
    // Ne garder la file que tant qu'elle a un successeur potentiel : sans ce nettoyage la Map
    // grossirait d'une entree par identite jamais vue, pour toute la vie du daemon.
    this._files.set(cle, courante.catch(() => {}).finally(() => { if (this._files.get(cle) === courante) this._files.delete(cle); }));
    return courante;
  }

  _prochainId(cle) {
    const n = (this._compteurs.get(cle) || 0) + 1;
    this._compteurs.set(cle, n);
    return fabriquerInstanceId(cle, n);
  }

  /**
   * Crée UNE instance pour `sock` : matérialise l'identité (si fournie), lance son serveur,
   * inscrit la socket comme SON client. Jamais de partage : deux appels = deux instances.
   */
  async _acquerir(profil, spec, instance, sock) {
    // ⚠️ Le contrôle porte sur les instances VIVANTES : chaque instance est un navigateur.
    if (!placeDisponible(this._instances.size, this.limite)) {
      throw new Error(
        `limite maxBrowsers=${this.limite} atteinte (${this._instances.size} instances vivantes) — profil ` +
        `"${profil}" REFUSÉ. Aucun navigateur existant n'a été touché : relâchez une instance, ou ` +
        `augmentez/retirez maxBrowsers dans profiles.json (absent = illimité).`
      );
    }
    const identite = instance ? instance.identite : null;
    const cle = identite || profil;
    const id = this._prochainId(cle);

    // ⚠️ AVERTIR, jamais refuser : une identité déjà tenue par une autre instance vivante est un
    // cas DÉCONSEILLÉ (Browserbase : « sites may force a log out »), pas interdit. La décision
    // appartient à l'opérateur ; le daemon NOMME le fait pour qu'il ne soit jamais silencieux.
    if (identite) {
      const deja = [...this._instances.values()].filter((e) => e.identite === identite && !e.fini).length;
      if (deja > 0) {
        const msg = `pw-mcp-proxy: identité "${identite}" déjà tenue par ${deja} instance(s) vivante(s) — une ${deja + 1}e démarre (${id}). Les sites peuvent déconnecter l'une des deux.`;
        log(msg);
        this._alerter(msg, this.env.PW_MCP_NTFY_URL);
      }
    }

    // Matérialisation SÉRIALISÉE par identité (cf _serie). `null` dir = profil v1/isolé : la spec
    // porte déjà son --user-data-dir (ou --isolated), le daemon ne touche à aucun dossier.
    const dir = instance
      ? await this._serie(identite, () => this._store.materialiser({ ...instance, instanceId: id }))
      : null;

    let etat;
    try {
      etat = await this._demarrerServeur({ instanceId: id, profil, identite, instance, dir }, spec);
    } catch (e) {
      // Le serveur n'a jamais servi : le dossier matérialisé n'a rien à ranger, on le retire.
      if (dir && instance.strategie === 'snapshot') this._store.supprimerInstance(dir);
      if (spec.configuration) this._store.supprimerConfigInstance(this._cheminConfig(id, dir, instance));
      throw e;
    }
    etat.sock = sock;
    this._instances.set(id, etat);
    // ⚠️ LE REF-COUNT EST ICI, et nulle part ailleurs : la fermeture de la socket est l'ÉVÉNEMENT
    // exact « ce client n'utilise plus cette instance ». Vaut aussi pour un proxy tué brutalement.
    sock.once('close', () => { this._finirInstance(etat, 'client parti').catch((e) => log(`[daemon:${id}] fin d'instance: ${describeError(e)}`)); });
    return etat;
  }

  /** Chemin du fichier `--config` d'une instance : a cote du dossier d'instance, sinon dans le dossier d'instances par defaut. */
  _cheminConfig(id, dir, instance) {
    if (dir) return `${dir}.config.json`;
    const base = instance && instance.instancesDir ? instance.instancesDir : cheminsCoffre({}, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join).instancesDir;
    return path.join(base, `${id}.config.json`);
  }

  async _demarrerServeur(desc, spec) {
    const { instanceId: id, profil, dir, instance } = desc;
    const port = await this._allouerPort(this.hote);
    // `playwrightConfig` du profil ⇒ fichier `--config` ECRIT ICI (valeur runtime : son chemin depend de
    // l'instance), supprime au rangement. Contenu deja valide DEUX fois (manager + protocole).
    const configFichier = spec.configuration ? this._store.ecrireConfigInstance(this._cheminConfig(id, dir, instance), spec.configuration) : null;
    // Le `--user-data-dir` d'une INSTANCE est une valeur RUNTIME, ajoutée ICI comme le port (cf spec.js).
    // 🛑 JAMAIS `--allowed-hosts` ici, même hors loopback — LU DANS LE CODE INSTALLÉ (0.0.80,
    // `installHttpTransport`, coreBundle.js) : la couche MCP compare l'en-tête `Host` ENTIER
    // (`hote:port`) à sa liste, et sa liste PAR DÉFAUT est exactement l'hôte lié AVEC son port. Passer
    // `--allowed-hosts <hote>` sans port REMPLACE ce défaut correct par une liste fausse ⇒ 403 sur
    // chaque requête (mesuré en live le 05/09 : 8/8 tests rouges sur 169.254.29.100). Le port
    // n'étant connu qu'après le bind, le défaut du serveur est le seul choix juste.
    const rawArgs = [...spec.args, ...(dir ? ['--user-data-dir', dir] : []), ...(configFichier ? ['--config', configFichier] : []), '--host', this.hote, '--port', String(port)];
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
    child.on('error', (e) => log(`[daemon:${id}] spawn: ${describeError(e)}`));
    const pid = child.pid;
    if (!pid) throw new Error(`instance ${id} (profil ${profil}) : spawn avorté (aucun pid)`);

    // URL_HOST (`localhost`) et `this.hote` coincident par defaut ; hors loopback l'URL porte l'adresse
    // d'ecoute — la MEME chaine que `--host`/`--allowed-hosts`, jamais une resolution differente.
    const etat = { ...desc, port, pid, child, configFichier, url: `http://${this.hote === BIND_HOST ? URL_HOST : this.hote}:${port}/mcp`, sock: null, fini: false, exited: false };
    // 🛑 L'`exit` du serveur est un FAIT du noyau, delivre a NOUS parce que nous sommes son PARENT.
    // Enregistre AVANT toute attente : un serveur qui meurt pendant la readiness doit etre vu.
    child.on('exit', (code, sig) => {
      etat.exited = true;
      if (this._instances.get(id) !== etat) return; // jamais inscrite, ou deja rangee : rien a faire
      log(`[daemon:${id}] serveur MORT (pid=${pid} code=${code} sig=${sig}) — instance rangée`);
      // ⚠️ On ne respawn RIEN : un respawn spontane serait une boucle de relance sans client pour
      // la justifier. L'instance est RANGEE (snapshot si persist) et retiree ; le client, lui,
      // verra son transport tomber et redemandera une instance NEUVE (manager.get).
      this._finirInstance(etat, 'serveur mort').catch((e) => log(`[daemon:${id}] rangement après mort: ${describeError(e)}`));
    });

    const verdict = await this._attendre(port, { budgetMs: this._budgetMs, pid, host: this.hote });
    if (verdict !== 'pret') {
      // ⚠️ PAS DE SILENCE ICI : si ce kill echoue, le serveur avorte SURVIT en tenant son
      // `--user-data-dir`, et plus personne ne le connait (on n'a jamais inscrit cette instance).
      // C'est exactement l'orphelin que tout le reste du design supprime — il DOIT crier.
      try { this._tuer(pid); } catch (e) { log(`[daemon:${id}] FUITE POSSIBLE — arret du serveur avorte impossible (pid=${pid}): ${describeError(e)}`); }
      throw new Error(
        verdict === 'mort'
          ? `instance ${id} (profil ${profil}) : le serveur s'est ARRÊTÉ avant d'écouter (cause dans sa sortie, pas le réseau)`
          : `instance ${id} (profil ${profil}) : serveur VIVANT mais silencieux après ${this._budgetMs}ms`
      );
    }
    log(`[daemon:${id}] serveur prêt pid=${pid} ${etat.url}${dir ? ` dir=${dir}` : ''}`);
    return etat;
  }

  /**
   * RANGE une instance, dans cet ordre et sans aucun délai :
   *   1. tuer le serveur (treeKill : le gardien, le serveur, Chrome et ses fils) ;
   *   2. attendre l'événement `exit` du NOYAU (nous sommes le parent) — jamais un chronomètre :
   *      Chrome tient ses fichiers SQLite tant qu'il vit, un snapshot avant serait incohérent ;
   *   3. snapshot RETOUR si `persist` (atomique, refus NOMMÉ au-dessus du plafond — crié) ;
   *   4. supprimer le dossier d'instance (stratégie `snapshot` seulement : en `inplace` c'est le coffre).
   * Idempotente (`etat.fini`) : le départ du client et la mort du serveur peuvent tous deux
   * l'appeler, dans n'importe quel ordre.
   */
  async _finirInstance(etat, cause) {
    if (etat.fini) return;
    etat.fini = true;
    this._rangements += 1;
    try {
      await this._rangerInstance(etat, cause);
    } finally {
      this._rangements -= 1;
      // Plus aucune instance ? La question « ai-je encore un objet ? » se pose au NOYAU (connexions
      // vivantes) ET aux rangements en vol, jamais à un compteur d'instances seul : un client dont le
      // serveur vient de MOURIR est encore connecté et va redemander une instance (3 tests ETIMEDOUT
      // le 05/09 avec un `arreter()` direct à zéro instance).
      this._sortirSiInutile();
    }
  }

  async _rangerInstance(etat, cause) {
    const { instanceId: id, profil, identite, instance, dir, pid } = etat;
    this._instances.delete(id);
    if (!etat.exited) {
      let tue = true;
      try { this._tuer(pid); } catch (e) { tue = false; log(`[daemon:${id}] FUITE POSSIBLE — arrêt impossible (pid=${pid}): ${describeError(e)}`); }
      // ⚠️ Un kill qui a ÉCHOUÉ = Chrome tient encore ses fichiers : on ne range PAS (snapshot
      // incohérent) et on ne supprime PAS (rm sous un process vivant). L'erreur est déjà criée.
      if (tue) await new Promise((resolve) => (etat.exited ? resolve() : etat.child.once('exit', resolve)));
      else { this._emettreLibere(etat); return; }
    }
    // ⚠️ L'`exit` recu est celui du GARDIEN (notre enfant). Chrome est un PETIT-ENFANT : sa mort ne
    // nous est delivree par aucun evenement (doc Node : « child processes of child processes will not
    // be terminated when attempting to kill their parent » — et leur fin n'est pas notifiee non plus),
    // et sous Windows ses fichiers restent VERROUILLES jusqu'a sa disparition effective. Le FAIT
    // observable = le dossier se laisse renommer (`attendreLibre`, identity-store). Mesure le 05/09 :
    // sans cette attente, snapshot et rm echouaient sur des SQLite encore tenus.
    let dirLibre = dir;
    if (dir && instance && instance.strategie === 'snapshot') {
      dirLibre = await this._store.attendreLibre(dir);
      if (!dirLibre) {
        const msg = `pw-mcp-proxy: instance ${id} — le dossier ${dir} reste VERROUILLE apres l'arret (un process le tient encore) : ni range ni supprime`;
        log(`[daemon:${id}] ${msg}`);
        this._alerter(msg, this.env.PW_MCP_NTFY_URL);
        this._emettreLibere(etat);
        return;
      }
    }
    if (instance && instance.persist && instance.strategie === 'snapshot') {
      const r = await this._serie(identite, () => this._store.snapshotRetour({ identite, storeDir: instance.storeDir, instanceDir: dirLibre, plafonds: instance.plafonds }));
      if (r.ok) log(`[daemon:${id}] identité "${identite}" rangée (${Math.round(r.octets / 1048576)} Mo) — ${cause}`);
      else {
        const msg = `pw-mcp-proxy: identité "${identite}" NON rangée (${r.raison}) — l'état de cette session est PERDU, l'ancien snapshot est conservé`;
        log(`[daemon:${id}] ${msg}`);
        this._alerter(msg, this.env.PW_MCP_NTFY_URL);
      }
    }
    if (dir && instance && instance.strategie === 'snapshot') this._store.supprimerInstance(dirLibre);
    if (etat.configFichier) this._store.supprimerConfigInstance(etat.configFichier);
    log(`[daemon:${id}] instance terminée (${cause}, profil ${profil})`);
    this._emettreLibere(etat);
  }

  _emettreLibere(etat) {
    const restants = [...this._instances.values()].filter((e) => e.profil === etat.profil).length;
    // ⚠️ ÉMIS dans TOUS les cas : c'est le FAIT « le daemon a fini avec cette instance », seule
    // vérité opposable. Un observateur qui attendrait la fermeture de sa PROPRE socket parierait
    // sur un ordre non contractuel.
    this.emit('libere', { profil: etat.profil, identite: etat.identite, instanceId: etat.instanceId, restants });
  }

  /**
   * Ce daemon a-t-il encore une raison d'exister ? Zéro instance servie ET zéro client connecté.
   * ⚠️ Les DEUX conditions : un client peut être connecté sans (encore) tenir d'instance — sortir
   * là le laisserait sans réponse. Et une instance peut vivre pendant qu'un client se reconnecte.
   * ⚠️ Le nombre de connexions est demandé au SERVEUR (donc au noyau), jamais compté à la main :
   * un compteur maison finirait par diverger, et c'est exactement ce que ce refactor supprime.
   */
  _sortirSiInutile() {
    // ⚠️ Un rangement EN VOL est une raison de vivre : sortir maintenant = `process.exit` au milieu
    // d'une copie d'identité (cf `_rangements`).
    if (this._arrete || this._instances.size > 0 || this._rangements > 0) return;
    // ⚠️ CETTE CLASSE NE SORT JAMAIS DU PROCESS. Elle est instanciée telle quelle par les tests :
    // un `process.exit()` ici tuerait le worker de test. Elle s'ARRÊTE, et c'est `daemon-main`
    // (seul propriétaire du process) qui en tire la conséquence via `onArret`.
    this._serveur?.getConnections((err, n) => {
      if (err || n > 0) return;
      log('[daemon] plus aucune instance ni client — arrêt');
      this.arreter();
    });
  }

  /**
   * Arrêt propre. ⚠️ La correction n'en dépend PAS : à la mort du process, le noyau libère tout.
   * ⚠️ Les instances encore vivantes ici sont TUÉES sans snapshot : `arreter` n'est atteint
   * qu'à zéro instance (chemin nominal) ou sur un arrêt IMPOSÉ du daemon (le rangement, lui, se
   * fait au départ de CHAQUE client — c'est là qu'une identité se range, jamais à l'arrêt global).
   */
  arreter() {
    if (this._arrete) return;
    this._arrete = true;
    for (const [id, etat] of this._instances) {
      try { this._tuer(etat.pid); } catch (e) { log(`[daemon:${id}] arrêt: ${describeError(e)}`); }
    }
    this._instances.clear();
    try { this._serveur?.close(); } catch { /* SILENCE: arret — le noyau detruit le canal a la mort du process de toute facon */ }
    // POSIX : le fichier socket survit à close(). Le retirer évite une orpheline après une sortie
    // PROPRE ; le cas du crash reste couvert côté client (ECONNREFUSED ⇒ unlink ⇒ re-listen).
    if (channelIsFile(this.env)) { try { fs.unlinkSync(this.nomCanal); } catch { /* SILENCE: fichier deja retire (autre daemon, nettoyage OS) ; le client sait traiter une socket orpheline via ECONNREFUSED */ } }
    log('[daemon] arrêté');
    try { this.onArret?.(); } catch (e) { log(`[daemon] onArret: ${describeError(e)}`); }
  }

  /** Observabilité (tests + diagnostic) : quelles instances vivent, pour quel profil/identité. */
  etat() {
    return [...this._instances.values()].map((e) => ({ instanceId: e.instanceId, profil: e.profil, identite: e.identite, port: e.port, pid: e.pid, dir: e.dir }));
  }
}
