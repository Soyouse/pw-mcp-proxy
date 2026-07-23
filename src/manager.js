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
import { Supervisor } from './supervisor.js';
import { log } from './logger.js';
import { alert } from './notify.js';
import { sweepByCmd, listProcesses, isPidAlive } from './prockill.js';
import { buildSpec } from './spec.js';
import { shouldAutoRestart, DEFAULT_MAX_RESTARTS, DEFAULT_WINDOW_MS } from './auto-restart.js';
import { formatFreezeReport } from './freeze-report.js';
import { serverEntry } from './server-registry.js';

const DEFAULT_CLIENT_INFO = {
  protocolVersion: '2025-06-18',
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
    this.supervisor = null; // lazy : cree au 1er profil HTTP (mode stdio pur => jamais instancie)
    this._watchdogOptions = options.watchdog || {};
    this._autoRestartOptions = {
      maxRestarts: options.autoRestart?.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      windowMs: options.autoRestart?.windowMs ?? DEFAULT_WINDOW_MS,
    };
    this._restartHistory = new Map(); // profile -> number[] timestamps des auto-restarts declenches (anti-boucle)
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

  _sup() {
    // ntfyUrl config-first (comme le Router/notify) : dead-man des serveurs partages (mort inattendue).
    if (!this.supervisor) this.supervisor = new Supervisor(this.configPath, { ntfyUrl: this.config.ntfyUrl });
    return this.supervisor;
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
    fs.watchFile(this.configPath, { interval: 1000 }, async () => {
      try {
        this._loadConfig();
        await this._reconcile();
        log('config rechargee (hot-reload)');
        if (this.onConfigChange) this.onConfigChange();
      } catch (e) {
        log('config reload IGNOREE (invalide) : ' + e.message); // on garde l'ancienne config valide
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
        this.supervisor?.unregisterClient(name); // http : je ne suis plus client de ce profil (ref-count)
        continue;
      }
      const newSpec = this._spec(name);
      if (JSON.stringify(newSpec.args) !== JSON.stringify(b.spec.args)) {
        const wasActive = name === this.activeProfile;
        b.stop();
        this.backends.delete(name);
        if (wasActive) {
          try {
            await this.get(name); // respawn immediat avec la nouvelle spec
          } catch (e) {
            log(`respawn ${name} echoue: ${e.message}`);
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
      const msg = `pw-mcp-proxy: auto-restart de "${profile}" a ECHOUE (${e?.message || e}) — serveur probablement mort, redemarrage de Claude Code requis.`;
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
      let serverPid = null, serverAlive = null, port = null, browserCount = null;
      if (this._isHttp(profile)) {
        try {
          const entry = serverEntry(this._sup()._read(), profile);
          if (entry) { serverPid = entry.pid; port = entry.port; serverAlive = isPidAlive(entry.pid); }
        } catch {}
      }
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
        } catch {}
      }
      log(formatFreezeReport({ profile, reason: 'unresponsive', serverPid, serverAlive, port, browserCount, missedPings: info.missedPings, inflight: info.inflight }));
    } catch (e) {
      log(`[freeze-report] echec du diagnostic pour "${profile}": ${e?.message || e}`);
    }
  }

  // Fabrique le transport d'un profil. Mode HTTP (MULTI-AGENT) : le superviseur GARANTIT le serveur
  // partage (spawn/adopt) AVANT d'injecter un HttpTransport client + enregistre CE proxy (ref-count).
  // Mode stdio (defaut) : child MCP prive au proxy (tests, backends custom). userDataDir passe au
  // superviseur pour le self-heal d'un orphelin (cf supervisor.ensureServer).
  async _makeTransport(profile) {
    const spec = this._spec(profile);
    if (!this._isHttp(profile)) return new StdioTransport(profile, spec);
    const cfg = this.config.profiles[profile] || {};
    const url = await this._sup().ensureServer(profile, spec, { userDataDir: cfg.userDataDir });
    this._sup().registerClient(profile);
    return new HttpTransport(url, { protocolVersion: this.clientInfo.protocolVersion, spec });
  }

  active() {
    return this.get(this.activeProfile);
  }

  profileList() {
    return Object.entries(this.config.profiles).map(([name, p]) => ({ name, label: p.label || name }));
  }

  // Tous les --user-data-dir declares (needles du boot-sweep / restart_profile).
  // UNIQUES a nos profils isoles => jamais le Chrome perso (AppData\...\User Data).
  userDataDirs() {
    return Object.values(this.config.profiles).map((p) => p.userDataDir).filter(Boolean);
  }

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
  }

  // Au moins un profil en mode HTTP (=> supervision de serveurs partages requise) ?
  _anyHttp() {
    return Object.keys(this.config.profiles).some((p) => this._isHttp(p));
  }

  // Boot du multi-agent (HTTP) : boot-reap (purge les serveurs d'anciennes sessions morts/idle) puis
  // demarre le reaper periodique (dead-man des serveurs partages). No-op en mode stdio pur.
  // REMPLACE l'ancien boot-sweep global + lock d'abdication (incompatibles avec le serveur partage :
  // ils tueraient le serveur qu'un AUTRE agent utilise / feraient abdiquer un proxy vivant).
  async bootSupervision() {
    if (!this._anyHttp()) return;
    const s = this._sup();
    await s.reap();
    s.startReaper();
  }

  // Arret propre de CE proxy : retire mes heartbeats + stoppe le reaper. NE tue AUCUN serveur partage
  // (d'autres agents peuvent l'utiliser) — le reaper s'en charge s'il devient orphelin.
  async stopSupervision() {
    if (this.supervisor) await this.supervisor.shutdown();
  }
}
