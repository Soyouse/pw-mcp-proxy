// Un Backend = un serveur MCP distant lie a UN profil isole. Le proxy en est CLIENT.
// Bidirectionnel : le backend peut aussi envoyer des requetes (server->client) qui remontent a Claude.
//
// Backend est AGNOSTIQUE au transport : il recoit un `transport` (StdioTransport ou HttpTransport)
// exposant start()/send(msg)/close() + events 'message'|'exit'|'error'. Toute la logique PROTOCOLAIRE
// (handshake, mapping d'ids, forward) vit ICI ; le transport ne fait que convoyer des messages bruts.
//
// ⚠️ NE JAMAIS hardcoder ni filtrer la liste de tools ici. Le backend est une boite noire : on relaie.
// C'est ce qui rend le proxy increvable face aux updates Microsoft.

import { EventEmitter } from 'node:events';
import { log } from './logger.js';

export class Backend extends EventEmitter {
  constructor(profile, transport) {
    super();
    this.profile = profile; // nom du profil
    this.transport = transport; // StdioTransport | HttpTransport
    this.ready = false;
    this.initResult = null; // resultat initialize du backend (capabilities/serverInfo/protocolVersion)
    this._idCounter = 0;
    this._internal = new Map(); // id -> {resolve,reject}  (requetes internes du proxy : initialize, tools/list)
    this._forward = new Map(); // backendId -> clientId    (requetes Claude->backend en vol)
    this._startPromise = null;
    this._exited = false;
  }

  // spec lue par le Manager (_reconcile compare spec.args) : portee par le transport.
  get spec() {
    return this.transport.spec;
  }

  _nextId() {
    return `b${this.profile}.${++this._idCounter}`;
  }

  start(clientInfo) {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart(clientInfo);
    return this._startPromise;
  }

  async _doStart(clientInfo) {
    // Wiring des events du transport AVANT de demarrer (aucun message perdu).
    this.transport.on('message', (m) => this._onMessage(m));
    this.transport.on('exit', (code, sig) => this._onExit(code, sig));
    this.transport.on('close', () => this._onExit(null, 'close'));
    this.transport.on('error', (e) => {
      log(`[backend:${this.profile}] transport error: ${e?.message || e}`);
      this._onExit(-1, 'error');
    });

    await this.transport.start();

    // Handshake MCP : le proxy initialise le backend avec les capacites NEGOCIEES par Claude.
    const initRes = await this._request('initialize', {
      protocolVersion: clientInfo.protocolVersion,
      capabilities: clientInfo.capabilities,
      clientInfo: clientInfo.clientInfo,
    });
    this.initResult = initRes;
    this._notify('notifications/initialized', {});
    this.ready = true;
    log(`[backend:${this.profile}] ready (server=${initRes?.serverInfo?.name || '?'})`);
    return initRes;
  }

  // --- requetes internes du proxy (initialize, tools/list) : Promise ---
  request(method, params) {
    return this._request(method, params);
  }

  _request(method, params) {
    const id = this._nextId();
    return new Promise((resolve, reject) => {
      this._internal.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  // --- forwarding transparent des messages Claude ---
  forwardRequest(clientMsg) {
    const id = this._nextId();
    this._forward.set(id, clientMsg.id);
    this._write({ ...clientMsg, id });
  }

  forwardNotification(clientMsg) {
    this._write(clientMsg);
  }

  // Reponse de Claude a une requete que CE backend avait initiee (server->client).
  respondToBackend(backendId, responseMsg) {
    this._write({ ...responseMsg, id: backendId });
  }

  _write(msg) {
    this.transport.send(msg);
  }

  _onMessage(m) {
    const isResponse = m.id !== undefined && (m.result !== undefined || m.error !== undefined);
    if (isResponse) {
      if (this._internal.has(m.id)) {
        const { resolve, reject } = this._internal.get(m.id);
        this._internal.delete(m.id);
        if (m.error) reject(Object.assign(new Error(m.error.message || 'rpc error'), { rpc: m.error }));
        else resolve(m.result);
        return;
      }
      if (this._forward.has(m.id)) {
        const clientId = this._forward.get(m.id);
        this._forward.delete(m.id);
        this.emit('toClient', { ...m, id: clientId });
        return;
      }
      log(`[backend:${this.profile}] orphan response id=${m.id}`);
      return;
    }
    // requete initiee par le backend (server->client) : doit remonter a Claude
    if (m.id !== undefined && m.method) {
      this.emit('backendRequest', m);
      return;
    }
    // notification
    if (m.method) {
      this.emit('backendNotification', m);
    }
  }

  _onExit(code, sig) {
    if (this._exited) return; // idempotent : http peut emettre error PUIS close
    this._exited = true;
    const wasReady = this.ready;
    this.ready = false;
    this._startPromise = null;
    for (const { reject } of this._internal.values())
      reject(new Error(`backend ${this.profile} exited (code=${code} sig=${sig})`));
    this._internal.clear();
    // Les requetes Claude en vol : on renvoie une erreur recuperable (le modele peut retenter).
    for (const clientId of this._forward.values()) {
      this.emit('toClient', {
        jsonrpc: '2.0',
        id: clientId,
        error: { code: -32000, message: `backend "${this.profile}" a crashe (code=${code})` },
      });
    }
    this._forward.clear();
    if (wasReady) log(`[backend:${this.profile}] exited code=${code} sig=${sig}`);
    this.emit('exit', code, sig);
  }

  stop() {
    try { this.transport.close(); } catch {}
    this.ready = false;
    this._startPromise = null;
  }
}
