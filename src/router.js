// Router = coeur du multiplexeur. Regle d'or : PASSTHROUGH PAR DEFAUT.
// On n'intercepte QUE 3 choses cote Claude ; tout le reste est relaye au backend actif
// (y compris des methodes MCP qui n'existent pas encore -> le proxy "resiste a tout").
//
// Interception :
//   1. initialize        -> repond le proxy (mirror capabilities backend + tools.listChanged)
//   2. tools/list        -> liste du backend TELLE QUELLE + ajout de switch_profile
//   3. tools/call switch_profile -> traite en interne (change le backend actif)
//   4. ping              -> repond le proxy (robustesse meme backend KO)
// Bidirectionnel : les requetes server->client d'un backend remontent a Claude (id mappe).

import { writeMessage } from './jsonrpc.js';
import { log } from './logger.js';
import { detectCollisions, canonicalInjectedName, exposedName, isOurToolCall } from './collision.js';
import { alert } from './notify.js';

const PROTOCOL_FALLBACK = '2025-06-18';

export class Router {
  constructor(manager, clientOut, version = '1.0.0') {
    this.manager = manager;
    this.out = clientOut;
    this.version = version;
    this._toBackend = new Map(); // proxyId -> {profile, backendId}  (requete backend->client en attente de reponse Claude)
    this._idCounter = 0;
    this._alertedCollisions = new Set(); // noms deja signales (anti-spam d'alerte sur chaque tools/list)
    this._collisions = []; // collisions vues au dernier tools/list (route l'interception, cf _handleClientRequest)
    manager.onNewBackend = (b) => this._wire(b);
    manager.onConfigChange = () => this.notifyToolsChanged();
  }

  _pid() {
    return `p${++this._idCounter}`;
  }

  _send(msg) {
    writeMessage(this.out, msg);
  }

  _wire(backend) {
    backend.on('toClient', (msg) => this._send(msg)); // reponses aux requetes Claude relayees
    backend.on('backendNotification', (msg) => {
      // notifs (progress, tools/list_changed, log...) : on remonte celles du backend ACTIF.
      if (backend.profile === this.manager.activeProfile) this._send(msg);
    });
    backend.on('backendRequest', (msg) => this._forwardBackendRequest(backend, msg));
  }

  _forwardBackendRequest(backend, msg) {
    const pid = this._pid();
    this._toBackend.set(pid, { profile: backend.profile, backendId: msg.id });
    this._send({ ...msg, id: pid });
  }

  // ============ messages venant de Claude ============
  async handleClientMessage(msg) {
    const isResponse = msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);
    if (isResponse) return this._handleClientResponse(msg);
    if (msg.id === undefined && msg.method) return this._handleClientNotification(msg);
    if (msg.method) return this._handleClientRequest(msg);
  }

  // Reponse de Claude a une requete initiee par un backend (server->client).
  _handleClientResponse(msg) {
    const ent = this._toBackend.get(msg.id);
    if (!ent) {
      log(`reponse Claude orpheline id=${msg.id}`);
      return;
    }
    this._toBackend.delete(msg.id);
    const b = this.manager.backends.get(ent.profile);
    if (b) b.respondToBackend(ent.backendId, msg);
  }

  async _handleClientNotification(msg) {
    if (msg.method === 'notifications/initialized') return; // consomme par le proxy (handshake par hop)
    try {
      const b = await this.manager.active();
      b.forwardNotification(msg);
    } catch (e) {
      log('notif Claude non relayee: ' + e.message);
    }
  }

  async _handleClientRequest(msg) {
    const method = msg.method;
    if (method === 'initialize') return this._handleInitialize(msg);
    if (method === 'tools/list') return this._handleToolsList(msg);
    if (method === 'ping') return this._send({ jsonrpc: '2.0', id: msg.id, result: {} });
    // Interception de NOS tools maison : canonicalInjectedName accepte le nom nu ET le repli
    // `proxy_<name>` (utilise si le backend expose un homonyme, cf garde anti-collision).
    if (method === 'tools/call' && msg.params) {
      const canonical = canonicalInjectedName(msg.params.name);
      if (canonical && isOurToolCall(msg.params.name, this._collisions)) {
        if (canonical === 'switch_profile') return this._handleSwitch(msg);
        if (canonical === 'current_profile') return this._handleCurrentProfile(msg);
        if (canonical === 'restart_profile') return this._handleRestart(msg);
      }
      // Nom nu MAIS en collision => c'est le tool du BACKEND (homonyme) => passthrough (ci-dessous).
    }

    // PASSTHROUGH : tout le reste -> backend actif (transparence totale)
    try {
      const b = await this.manager.active();
      b.forwardRequest(msg);
    } catch (e) {
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `backend actif indisponible: ${e.message}` } });
    }
  }

  // ============ interceptions ============
  async _handleInitialize(msg) {
    const p = msg.params || {};
    this.manager.clientInfo = {
      protocolVersion: p.protocolVersion || PROTOCOL_FALLBACK,
      capabilities: p.capabilities || {},
      clientInfo: p.clientInfo || { name: 'unknown', version: '0' },
    };
    let result;
    try {
      const b = await this.manager.active();
      const caps = structuredClone(b.initResult?.capabilities || {});
      caps.tools = { ...(caps.tools || {}), listChanged: true }; // on garantit la propagation des updates
      result = {
        protocolVersion: b.initResult?.protocolVersion || this.manager.clientInfo.protocolVersion,
        capabilities: caps,
        serverInfo: { name: 'pw-mcp-proxy', version: this.version, title: 'Playwright MCP multi-profil' },
        ...(b.initResult?.instructions ? { instructions: b.initResult.instructions } : {}),
      };
    } catch (e) {
      // Backend KO : on repond quand meme pour que la session vive (au moins switch_profile).
      log('initialize: backend non pret: ' + e.message);
      result = {
        protocolVersion: this.manager.clientInfo.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'pw-mcp-proxy', version: this.version, title: 'Playwright MCP multi-profil' },
      };
    }
    this._send({ jsonrpc: '2.0', id: msg.id, result });
  }

  async _handleToolsList(msg) {
    try {
      const b = await this.manager.active();
      const tools = await this._collectBackendTools(b);
      const collisions = this._checkCollisions(tools);
      tools.push(this._switchTool(collisions));
      tools.push(this._currentProfileTool(collisions));
      tools.push(this._restartTool(collisions));
      this._send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    } catch (e) {
      log('tools/list degrade (backend KO): ' + e.message);
      // backend KO => aucun tool backend connu => aucune collision possible => noms nus.
      this._send({ jsonrpc: '2.0', id: msg.id, result: { tools: [this._switchTool([]), this._currentProfileTool([]), this._restartTool([])] } });
    }
  }

  // Garde anti-collision : detecte un tool backend homonyme d'un de nos tools maison.
  // Signale UNE FOIS par nom (log + NTFY best-effort) ; nos tools cederont la place sous `proxy_`
  // (cf exposedName). Passthrough integre : le tool backend garde son nom nu, on ne casse rien.
  _checkCollisions(backendTools) {
    const collisions = detectCollisions((backendTools || []).map((t) => t.name));
    this._collisions = collisions; // memorise pour router l'interception (nom nu en collision => backend)
    for (const name of collisions) {
      if (this._alertedCollisions.has(name)) continue;
      this._alertedCollisions.add(name);
      // ntfyUrl vient de profiles.json (config-first) — aucune URL/topic hardcodé (open-source).
      alert(
        `COLLISION de tool: le backend expose deja "${name}" (update @playwright/mcp ?). Notre tool maison est expose sous "proxy_${name}". Verifier l'interception.`,
        this.manager.config && this.manager.config.ntfyUrl
      );
    }
    return collisions;
  }

  // Aspire toutes les pages du backend (pagination par cursor) sans rien filtrer.
  async _collectBackendTools(backend) {
    const all = [];
    let cursor;
    do {
      const res = await backend.request('tools/list', cursor ? { cursor } : {});
      for (const t of res.tools || []) all.push(t);
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  }

  // Suffixe de description ajoute quand un tool maison a du ceder son nom nu au backend (collision).
  _collisionNote(canonical, collisions) {
    return (collisions || []).includes(canonical)
      ? ` (⚠️ expose sous "proxy_${canonical}" car le backend occupe deja "${canonical}")`
      : '';
  }

  _switchTool(collisions = []) {
    const profs = this.manager.profileList();
    const listed = profs.map((p) => `"${p.name}"${p.label ? ` (${p.label})` : ''}`).join(', ');
    return {
      name: exposedName('switch_profile', collisions),
      title: 'Changer de profil de navigateur',
      description:
        `Bascule le navigateur actif vers un profil isole (compte/identite separes, cookies/session non partages). ` +
        `Les outils browser_* agissent ENSUITE dans ce profil. ` +
        `Profil actif: "${this.manager.activeProfile}". Profils disponibles: ${listed}.` +
        this._collisionNote('switch_profile', collisions),
      inputSchema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Nom du profil cible.', enum: profs.map((p) => p.name) },
        },
        required: ['profile'],
        additionalProperties: false,
      },
    };
  }

  // current_profile : outil LECTURE SEULE. Son RESULTAT est frais a chaque appel
  // (jamais mis en cache cote client, contrairement a une description d'outil).
  // OBLIGATOIRE comme verite de reference : la description de switch_profile peut
  // refleter un etat anterieur ; current_profile, lui, ne ment jamais.
  _currentProfileTool(collisions = []) {
    return {
      name: exposedName('current_profile', collisions),
      title: 'Profil de navigateur actif',
      description:
        `Renvoie le profil de navigateur ACTIF a l'instant (valeur fraiche, jamais mise en cache). ` +
        `A appeler AVANT toute action sensible pour confirmer sur quel compte/identite on agit.` +
        this._collisionNote('current_profile', collisions),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
  }

  // restart_profile : outil de MAINTENANCE. Interception LEGITIME (action sur l'etat du proxy
  // lui-meme, meme famille que switch/current) — pas une violation du passthrough.
  _restartTool(collisions = []) {
    const profs = this.manager.profileList();
    return {
      name: exposedName('restart_profile', collisions),
      title: 'Redemarrer le backend d un profil',
      description:
        `Force le redemarrage du navigateur d'un profil : tue son backend + son Chrome et respawn propre. ` +
        `A utiliser si un profil est BLOQUE ("Browser is already in use for ...") ou si ses commandes browser_* PENDENT. ` +
        `N'affecte QUE le profil cible (les autres profils et le navigateur perso restent intacts).` +
        this._collisionNote('restart_profile', collisions),
      inputSchema: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Nom du profil a redemarrer.', enum: profs.map((p) => p.name) },
        },
        required: ['profile'],
        additionalProperties: false,
      },
    };
  }

  async _handleRestart(msg) {
    const target = msg.params?.arguments?.profile;
    const avail = this.manager.profileList().map((p) => p.name);
    if (!target || !this.manager.config.profiles[target]) {
      return this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Profil inconnu: ${target}. Disponibles: ${avail.join(', ')}` }], isError: true },
      });
    }
    try {
      await this.manager.restartProfile(target);
      const label = this.manager.config.profiles[target].label || target;
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Profil "${target}" (${label}) redemarre : verrou libere, backend neuf operationnel.` }], isError: false },
      });
      // Le backend actif a pu changer d'instance -> forcer Claude a re-tirer tools/list (coherence).
      this.notifyToolsChanged();
    } catch (e) {
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Echec du redemarrage de "${target}": ${e.message}` }], isError: true },
      });
    }
  }

  _handleCurrentProfile(msg) {
    const name = this.manager.activeProfile;
    const label = this.manager.config.profiles[name]?.label || name;
    this._send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `Profil actif: "${name}" (${label}).` }], isError: false },
    });
  }

  async _handleSwitch(msg) {
    const target = msg.params?.arguments?.profile;
    const avail = this.manager.profileList().map((p) => p.name);
    if (!target || !this.manager.config.profiles[target]) {
      return this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Profil inconnu: ${target}. Disponibles: ${avail.join(', ')}` }], isError: true },
      });
    }
    try {
      await this.manager.get(target); // spawn + handshake si lazy
      this.manager.activeProfile = target;
      const label = this.manager.config.profiles[target].label || target;
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Profil actif: "${target}" (${label}). Les outils browser_* agissent maintenant dans ce profil.` }], isError: false },
      });
      // OBLIGATOIRE : un switch change le profil ACTIF -> on force Claude a re-tirer tools/list,
      // ce qui rafraichit la description "Profil actif" (sinon elle reste figee/cachee = mensonge).
      // C'est la racine de l'incident 2026-06-02 (action sur le mauvais compte). NE PAS retirer.
      this.notifyToolsChanged();
    } catch (e) {
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Echec du switch vers "${target}": ${e.message}` }], isError: true },
      });
    }
  }

  notifyToolsChanged() {
    this._send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}
