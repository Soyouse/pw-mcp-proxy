// Manager = config (profiles.json) + pool de backends + profil actif.
// Hot-reload par mtime : ajouter/retirer un profil ne demande AUCUN restart.
// SCALABILITE : un profil peut surcharger `backend` (command/args) -> le proxy
// multiplexe N'IMPORTE quel serveur MCP par profil, pas seulement Playwright.
// Zero refactoring pour repurposer : c'est de la donnee, pas du code.

import fs from 'node:fs';
import process from 'node:process';
import { Backend } from './backend.js';
import { StdioTransport } from './stdio-transport.js';
import { HttpTransport } from './http-transport.js';
import { log } from './logger.js';
import { alert } from './notify.js';
import { sweepByCmd, listProcesses } from './prockill.js';
import { buildSpec } from './spec.js';
import { shouldAutoRestart, DEFAULT_MAX_RESTARTS, DEFAULT_WINDOW_MS } from './auto-restart.js';
import { formatFreezeReport } from './freeze-report.js';
// ⚠️ Le DAEMON remplace le superviseur : le ref-count est tenu par le NOYAU (socket ouverte),
// plus par un registre fichier + heartbeat + TTL. Cf src/server-daemon.js pour le POURQUOI.
import { acquerirProfil } from './daemon-client.js';
// ⚠️ SOURCE UNIQUE des delais (budget.js) — NE JAMAIS redeclarer une duree ici.
import { CONFIG_WATCH_INTERVAL_MS } from './budget.js';
// ⚠️ describeError : JAMAIS `e.message` seul (il peut etre VIDE — incident 01/08).
import { describeError } from './error-detail.js';
// ⚠️ SOURCE UNIQUE du repli de version MCP (3 copies avant l'audit du 03/08).
import { PROTOCOL_FALLBACK } from './protocol.js';

const DEFAULT_CLIENT_INFO = {
  protocolVersion: PROTOCOL_FALLBACK,
  capabilities: {},
  clientInfo: { name: 'pw-mcp-proxy', version: '1.0.0' },
};

export class Manager {
  // options.watchdog = passe tel quel a `new Backend(...)` (ping*/maxMissedPings, INJECTABLE pour
  // des tests rapides ; defauts prod = ceux de backend.js si omis).
  // options.autoRestart = {maxRestarts, windowMs} passe a shouldAutoRestart (garde anti-boucle,
  // COUCHE 2b) ; defauts prod = auto-restart.js (3 restarts / 5 min) si omis.
  constructor(configPath, options = {}) {
    this.configPath = configPath;
    this.config = null;
    this.backends = new Map(); // profile -> Backend
    this.activeProfile = null;
    this.clientInfo = { ...DEFAULT_CLIENT_INFO }; // remplace au handshake Claude
    this.onNewBackend = null; // set par le Router (wiring des events)
    this.onConfigChange = null; // set par le Router (re-emet tools/list_changed)
    this._watchdogOptions = options.watchdog || {};
    this._autoRestartOptions = {
      maxRestarts: options.autoRestart?.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      windowMs: options.autoRestart?.windowMs ?? DEFAULT_WINDOW_MS,
    };
    this._restartHistory = new Map(); // profile -> number[] timestamps des auto-restarts declenches (anti-boucle)
    // 🛑 profile -> socket vers le DAEMON. CETTE SOCKET **EST** LE REF-COUNT : tant qu'elle vit, le
    // daemon sait que CE proxy utilise ce profil. La fermer = « je n'en ai plus besoin » (evenement
    // du NOYAU, delivre meme sur kill -9). NE JAMAIS la fermer apres avoir lu l'URL.
    this._connexions = new Map();
    this._loadConfig();
    this._watch();
  }

  // Un profil est en mode HTTP (serveur @playwright/mcp partage ref-compte, MULTI-AGENT) si son
  // flag `http` OU le flag global `http` est vrai. Defaut = stdio (retro-compatible : profils/tests
  // existants inchanges). C'est le point de bascule expand/contract : les deux transports coexistent.
  _isHttp(profile) {
    const p = this.config.profiles[profile] || {};
    return p.http !== undefined ? !!p.http : !!this.config.http;
  }

  _loadConfig() {
    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    if (!cfg.profiles || typeof cfg.profiles !== 'object' || !Object.keys(cfg.profiles).length)
      throw new Error('profiles.json: "profiles" manquant ou vide');
    if (!cfg.defaultProfile || !cfg.profiles[cfg.defaultProfile])
      throw new Error('profiles.json: "defaultProfile" invalide');
    this.config = cfg;
    if (!this.activeProfile || !cfg.profiles[this.activeProfile])
      this.activeProfile = cfg.defaultProfile;
  }

  _watch() {
    fs.watchFile(this.configPath, { interval: CONFIG_WATCH_INTERVAL_MS }, async () => {
      try {
        this._loadConfig();
        await this._reconcile();
        log('config rechargee (hot-reload)');
        if (this.onConfigChange) this.onConfigChange();
      } catch (e) {
        log('config reload IGNOREE (invalide) : ' + describeError(e)); // on garde l'ancienne config valide
      }
    });
  }

  // Aligne les backends vivants sur la nouvelle config : profil supprime -> stop ;
  // spec changee (ex: caps, args, userDataDir) -> respawn (le backend actif tout de suite,
  // les autres en lazy au prochain switch). C'est ce qui rend le changement de `caps`
  // effectif a chaud (respawn transparent + le Router emet tools/list_changed).
  async _reconcile() {
    for (const [name, b] of [...this.backends]) {
      if (!this.config.profiles[name]) {
        b.stop();
        this.backends.delete(name);
        this._closeConnexion(name); // http : je ne suis plus client de ce profil (ref-count noyau)
        continue;
      }
      const newSpec = this._spec(name);
      if (JSON.stringify(newSpec.args) !== JSON.stringify(b.spec.args)) {
        const wasActive = name === this.activeProfile;
        b.stop();
        this.backends.delete(name);
        // 🛑 RELACHER AVANT DE REPRENDRE — l'inverse EXACT de `setActiveProfile`, et c'est voulu.
        // Ici l'intention est de REDEMARRER le serveur avec la nouvelle spec : garder l'ancienne
        // connexion le maintiendrait vivant, et le daemon nous rendrait le MEME serveur, avec les
        // ANCIENS args. Bug REEL trouve le 02/08 par la matrice de transports : en stdio le child
        // prive respawnait (donc vert), en HTTP le changement de `caps` n'avait JAMAIS lieu.
        // ⚠️ MULTI-AGENT : si un AUTRE agent tient encore ce profil, son serveur SURVIT (refcount)
        // et la nouvelle spec ne s'appliquera qu'a son depart. C'est la bonne semantique — on ne
        // coupe pas le navigateur d'autrui pour un changement de config qui nous concerne.
        this._closeConnexion(name);
        if (wasActive) {
          try {
            await this.get(name); // respawn immediat avec la nouvelle spec
          } catch (e) {
            log(`respawn ${name} echoue: ${describeError(e)}`);
          }
        }
      }
    }
  }

  // Delegue a buildSpec (pur, mutation-teste). Le manager fournit la config + le flag http (qui decide
  // --shared-browser-context pour un profil persistant multi-agent, cf spec.js / doc @playwright/mcp).
  _spec(profile) {
    return buildSpec(profile, this.config.profiles[profile], this.config, { http: this._isHttp(profile) });
  }

  async get(profile) {
    if (!this.config.profiles[profile]) throw new Error(`profil inconnu: ${profile}`);
    let b = this.backends.get(profile);
    if (b && b.ready) return b;
    // Backend EXITE = cadavre (bug live 2026-07-23) : son transport porte une session morte (http :
    // sessionId perime => re-initialize prend un 404 avale par l'idempotence de _onExit => promesse
    // eternelle => appel MCP qui pend 120 s ; stdio : child mort). NE JAMAIS le ranimer : on le purge
    // et on reconstruit backend + transport FRAIS (nouvelle session HTTP via _makeTransport, qui
    // re-acquiert le profil aupres du daemon). stop() = close best-effort (DELETE session, treeKill stdio).
    if (b && b.exited) {
      // LOG SIGNAL (traçabilité incident) : c'est cette ligne qui rend le remplacement VISIBLE dans
      // pw-mcp-proxy.log — le bug du 23/07 n'a été trouvé QUE grâce aux logs. NE PAS la retirer.
      log(`[backend:${profile}] exited => purge du cadavre + respawn (transport/session frais)`);
      b.stop();
      this.backends.delete(profile);
      b = null;
    }
    if (!b) {
      const transport = await this._makeTransport(profile);
      b = new Backend(profile, transport, this._watchdogOptions);
      this.backends.set(profile, b);
      // COUCHE 2b (auto-restart, 0-human) : reagit UNIQUEMENT au gel detecte par le watchdog
      // (sig==='unresponsive', cf _onBackendUnresponsive). Cable AVANT tout message (comme onNewBackend).
      b.on('exit', (code, sig) => this._onBackendUnresponsive(profile, sig, b));
      // FORENSIQUE (0-human : « ne jamais rester dans l'ignorance ») : sur un GEL detecte par le
      // watchdog, ecrire un rapport RICHE (etat process Chrome, requetes en vol) => la prochaine
      // occurrence d'un bug tordu est diagnosticable. Observation SEULE, ne change aucune decision.
      b.on('freeze', (info) => this._logFreezeReport(profile, info));
      if (this.onNewBackend) this.onNewBackend(b); // wiring AVANT tout message
    }
    await b.start(this.clientInfo);
    return b;
  }

  // Auto-restart (0-human, COUCHE 2b du bug de GEL) : recycle SEUL un backend que le watchdog a
  // declare fige, sans attendre que Claude appelle restart_profile a la main.
  // ⚠️ SCOPE STRICT : ne reagit QU'AU gel detecte par le watchdog liveness (backend.js _pingOnce).
  // 'unresponsive' n'est JAMAIS emis ailleurs (grep : seul _onExit(-1,'unresponsive') l'utilise) =>
  // un stop() volontaire (stopAll/_reconcile/restartProfile lui-meme) emet 'close'/'error'/exit stdio,
  // JAMAIS 'unresponsive' => AUCUNE garde supplementaire requise, ce filtre suffit par construction.
  // ⚠️ ANTI-RECURSION : restartProfile() appelle b.stop() -> transport.close() -> _onExit(null,'close')
  // sur l'ANCIEN backend => sig='close' => le filtre ci-dessus l'ignore (pas de re-declenchement).
  async _onBackendUnresponsive(profile, sig, backend) {
    if (sig !== 'unresponsive') return; // seul le gel watchdog nous interesse (cf commentaire ci-dessus)
    if (this.backends.get(profile) !== backend) return; // event PERIME : ce backend a deja ete remplace

    const now = Date.now();
    const hist = this._restartHistory.get(profile) || [];
    const allowed = shouldAutoRestart(hist, now, this._autoRestartOptions);

    if (!allowed) {
      // ANTI-BOUCLE (dead-man) : on ne restart PAS a l'infini un profil qui gele en boucle -> on crie
      // au lieu de boucler en silence (0-human = crier, pas travailler pour rien).
      const msg = `pw-mcp-proxy: profil "${profile}" en BOUCLE de gel (>=${this._autoRestartOptions.maxRestarts} auto-restarts en ${this._autoRestartOptions.windowMs}ms) — auto-restart SUSPENDU, redemarrage de Claude Code probablement requis.`;
      log(msg);
      alert(msg, this.config?.ntfyUrl);
      return;
    }

    // Purge les timestamps HORS fenetre en meme temps qu'on enregistre le nouveau : la liste reste
    // bornee (jamais de croissance illimitee sur une longue session) ET l'historique ne porte que ce
    // que shouldAutoRestart regarde. NE PAS remplacer par un simple `[...hist, now]` (fuite + histo faux).
    const windowStart = now - this._autoRestartOptions.windowMs;
    this._restartHistory.set(profile, [...hist.filter((t) => t > windowStart), now]);
    log(`[auto-restart] profil "${profile}" declare unresponsive par le watchdog => restart automatique`);
    try {
      await this.restartProfile(profile);
    } catch (e) {
      // Cas "gel grave" (BACKLOG.md) : le respawn lui-meme ne revient pas -> alerte bruyante, jamais
      // un echec silencieux (le proxy resterait mort sans que personne ne le sache).
      const msg = `pw-mcp-proxy: auto-restart de "${profile}" a ECHOUE (${describeError(e)}) — serveur probablement mort, redemarrage de Claude Code requis.`;
      log(msg);
      alert(msg, this.config?.ntfyUrl);
    }
  }

  // FORENSIQUE (I/O) : au moment d'un GEL (event 'freeze' du backend), collecte l'etat REEL et ecrit
  // le rapport via freeze-report (PUR). But 0-human : « ne jamais rester dans l'ignorance » — la
  // prochaine occurrence d'un bug tordu (gel 22/07 jamais capture) devient diagnosticable.
  // ⚠️ BEST-EFFORT : ne throw JAMAIS (un echec de diagnostic ne doit pas perturber le flux du proxy) ;
  // OBSERVATION SEULE (ne tue rien, ne decide rien — le restart reste gere par _onBackendUnresponsive).
  // Cout de listProcesses acceptable : emis UNIQUEMENT sur gel detecte (rare), jamais dans le chemin chaud.
  _logFreezeReport(profile, info = {}) {
    try {
      const cfg = this.config.profiles?.[profile] || {};
      const udd = cfg.userDataDir || null;
      // ⚠️ Le pid/port du serveur partage n'est PLUS lisible ici : il vit dans le daemon, qui est le
      // seul a le connaitre (fin du registre fichier). Le DISCRIMINANT du rapport reste intact —
      // c'est `browserCount` (0 = Chrome mort, >0 = fige), jamais le pid du serveur.
      let serverPid = null, serverAlive = null, port = null, browserCount = null;
      if (udd) {
        try {
          // Discriminant Chrome mort/fige. Normalise les slashes (Windows \ vs Unix /) pour ne pas
          // rater le match => un faux « AUCUN Chrome » tromperait le diagnostic. Meme filtre binaire
          // que le drift-test (chrome/headless, jamais node/npx/cmd wrappers).
          const uddN = udd.replace(/\\/g, '/');
          browserCount = listProcesses().filter((p) => {
            const c = p.cmd.replace(/\\/g, '/');
            return c.includes(uddN) && /(chrome|chromium|headless_shell|msedge)/i.test(c) && !/node|npx|cmd\.exe/i.test(c);
          }).length;
        } catch { /* SILENCE: diagnostic best-effort — un rapport de gel ne doit JAMAIS throw (cf freeze-report) */ }
      }
      log(formatFreezeReport({ profile, reason: 'unresponsive', serverPid, serverAlive, port, browserCount, missedPings: info.missedPings, inflight: info.inflight }));
    } catch (e) {
      log(`[freeze-report] echec du diagnostic pour "${profile}": ${describeError(e)}`);
    }
  }

  // Fabrique le transport d'un profil.
  // Mode HTTP (MULTI-AGENT) : le DAEMON garantit le serveur partage (le demarre ou le partage) et
  // rend une socket AVANT qu'on injecte un HttpTransport client — cette socket EST le ref-count.
  // Mode stdio (defaut) : child MCP prive au proxy (tests, backends custom), aucun daemon implique.
  async _makeTransport(profile) {
    const spec = this._spec(profile);
    if (!this._isHttp(profile)) return new StdioTransport(profile, spec);
    // ⚠️ Le daemon GARANTIT le serveur (le demarre si besoin, le partage sinon) et rend une socket.
    // Cette socket EST le ref-count : on la GARDE ouverte, `_release` la fermera. La fermer ici
    // libererait le profil aussitot et tuerait le navigateur sous l'agent.
    // `maxBrowsers` (optionnel, absent = illimite) : garde-fou CHOISI par l'utilisateur, applique
    // par le daemon au LANCEMENT. Il REFUSE un profil de plus, il n'evince jamais.
    const { url, connexion } = await acquerirProfil(profile, spec, {}, { maxBrowsers: this.config.maxBrowsers });
    this._closeConnexion(profile); // une SEULE connexion par profil (re-acquisition apres purge)
    this._connexions.set(profile, connexion);
    return new HttpTransport(url, { protocolVersion: this.clientInfo.protocolVersion, spec });
  }

  // Ferme MA connexion au daemon pour ce profil = decremente le ref-count. Best-effort et
  // idempotent : liberer ne doit JAMAIS faire echouer une bascule reussie.
  _closeConnexion(profile) {
    const c = this._connexions.get(profile);
    if (!c) return;
    this._connexions.delete(profile);
    try { c.destroy(); } catch (e) { log(`[daemon:${profile}] fermeture: ${describeError(e)}`); }
  }

  // SEUL chemin de bascule de profil (router._handleSwitch l'appelle ; NE PAS re-ecrire
  // `manager.activeProfile = x` ailleurs — ce serait sauter la liberation ci-dessous).
  //
  // ⚠️ LIBERER L'ANCIEN PROFIL EST OBLIGATOIRE — incident LIVE 2026-08-02 07:15 (boucle de spawn) :
  // sans ca, le backend quitte RESTAIT dans le pool avec son transport HTTP VIVANT, alors que son
  // serveur partage venait d'etre reape « idle » (legitime : plus aucun client). Ce transport tapait
  // dans le vide => backend exited => « purge du cadavre + respawn » => un serveur @playwright/mcp
  // (+ son Chrome) relance toutes les ~15 s jusqu'a saturer la machine.
  //
  // ⚠️ ORDRE OBLIGATOIRE : on n'ouvre le nouveau QU'APRES l'avoir obtenu (get d'abord). Liberer avant
  // laisserait l'agent SANS AUCUN backend si le nouveau profil echoue a demarrer.
  // ⚠️ MULTI-AGENT : liberer = fermer MA session (DELETE HTTP) + retirer MON heartbeat. Le serveur
  // partage survit tant qu'un AUTRE agent le tient (ref-count) ; on ne tue JAMAIS le serveur ici.
  // Scelle par tests/manager-switch-lifecycle.test.js (invariant N profils : au plus 1 transport ouvert).
  async setActiveProfile(target) {
    if (!this.config.profiles[target]) throw new Error(`profil inconnu: ${target}`);
    const previous = this.activeProfile;
    await this.get(target); // peut throw : on n'a alors RIEN libere, l'agent garde son backend courant
    this.activeProfile = target;
    if (previous && previous !== target) this._release(previous);
    return target;
  }

  // Libere un profil dont CE proxy n'est plus client : ferme backend + transport et retire le
  // heartbeat. Best-effort et idempotent — liberer ne doit jamais faire echouer une bascule reussie.
  _release(profile) {
    const b = this.backends.get(profile);
    if (b) {
      this.backends.delete(profile); // AVANT stop() : 'close' -> _onBackendUnresponsive ne doit rien retrouver
      try { b.stop(); } catch (e) { log(`[backend:${profile}] liberation: ${describeError(e)}`); }
    }
    // http seulement : fermer ma socket decremente le ref-count tenu par le NOYAU (no-op en stdio).
    this._closeConnexion(profile);
  }

  active() {
    return this.get(this.activeProfile);
  }

  profileList() {
    return Object.entries(this.config.profiles).map(([name, p]) => ({ name, label: p.label || name }));
  }

  // ⚠️ `userDataDirs()` A ETE SUPPRIME LE 03/08/2026 (audit) : CODE MORT. Son commentaire annoncait
  // « needles du boot-sweep / restart_profile », or le boot-sweep global a ete retire le 02/08 avec
  // le superviseur, et `restartProfile` lit le udd du SEUL profil vise (chirurgical, ci-dessous) —
  // jamais la liste entiere. Verifie : zero appelant dans `src/` comme dans `tests/`.
  // 🛑 NE PAS le recreer : une methode qui rend TOUS les user-data-dir n'a qu'un usage possible, le
  // balayage LARGE — precisement la regression P0-inverse (tuer le serveur d'un AUTRE agent).

  // restart_profile (P1) : libere le verrou d'UN profil bloque et respawn un backend propre.
  // 1) stop() du backend connu (tree-kill son arbre) ; 2) sweep de tout ORPHELIN tenant encore
  // le lock de CE user-data-dir (backend d'un proxy deja mort) ; 3) respawn immediat.
  // Chirurgical par user-data-dir => n'affecte QUE ce profil (jamais l'autre compte ni le Chrome perso).
  // ⚠️ MULTI-AGENT (appelant = humain via tool OU _onBackendUnresponsive automatique) : en mode HTTP
  // partage, ce restart recycle le serveur PARTAGE (sweepByCmd userDataDir) => impacte TOUS les agents
  // actuellement clients de ce profil. C'est ACCEPTE PAR DESIGN (c'est l'automatisation de l'outil manuel
  // restart_profile, prevu pour debloquer un profil FIGE — un profil fige est deja inutilisable pour
  // TOUS ses clients) ; l'anti-boucle de _onBackendUnresponsive (shouldAutoRestart) borne l'emballement
  // pour ne pas thrasher le serveur partage a chaque gel repete. NE PAS reintroduire de boot-sweep global.
  async restartProfile(profile) {
    if (!this.config.profiles[profile]) throw new Error(`profil inconnu: ${profile}`);
    const b = this.backends.get(profile);
    if (b) {
      b.stop();
      this.backends.delete(profile);
    }
    const dir = this.config.profiles[profile].userDataDir;
    if (dir) {
      const killed = sweepByCmd([dir], process.pid);
      if (killed.length) log(`restart_profile ${profile}: ${killed.length} orphelin(s) tue(s) [${killed.join(',')}]`);
    }
    return this.get(profile);
  }

  stopAll() {
    for (const b of this.backends.values()) b.stop();
    this.backends.clear();
    // Rendre TOUS mes profils au daemon. La correction n'en depend pas (le noyau ferme les sockets
    // a la mort du process, meme sur kill -9) — c'est la sortie PROPRE, pas le filet.
    for (const p of [...this._connexions.keys()]) this._closeConnexion(p);
  }

  // ⚠️ PLUS AUCUNE SUPERVISION ICI — supprimee le 02/08 avec le superviseur. Le cycle de vie des
  // serveurs partages appartient au DAEMON, qui en est le PARENT : il les demarre a la demande et
  // les arrete quand leur derniere socket se ferme. Il n'y a plus rien a amorcer au boot, plus
  // rien a purger, plus aucun heartbeat a retirer a l'arret. NE PAS reintroduire de boot-sweep ni
  // de lock d'abdication : ils tueraient le serveur qu'un AUTRE agent utilise.
}
