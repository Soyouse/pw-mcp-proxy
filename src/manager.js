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
import { sweepByCmd } from './prockill.js';
import { buildSpec } from './spec.js';

const DEFAULT_CLIENT_INFO = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'pw-mcp-proxy', version: '1.0.0' },
};

export class Manager {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
    this.backends = new Map(); // profile -> Backend
    this.activeProfile = null;
    this.clientInfo = { ...DEFAULT_CLIENT_INFO }; // remplace au handshake Claude
    this.onNewBackend = null; // set par le Router (wiring des events)
    this.onConfigChange = null; // set par le Router (re-emet tools/list_changed)
    this.supervisor = null; // lazy : cree au 1er profil HTTP (mode stdio pur => jamais instancie)
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
      b = new Backend(profile, transport);
      this.backends.set(profile, b);
      if (this.onNewBackend) this.onNewBackend(b); // wiring AVANT tout message
    }
    await b.start(this.clientInfo);
    return b;
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
