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
  // ⚠️ options.ping* = WATCHDOG DE LIVENESS (garde-fou fails-closed contre le GEL du backend).
  // Defauts PROD genereux (faux positif quasi impossible) ; override COURT en test uniquement.
  // Bug scelle 2026-07-22 : un backend @playwright/mcp fige (popup OAuth natif, page qui hang) et
  // ne renvoie JAMAIS la reponse => l'appel MCP pendait >120s EN SILENCE (agent qui brule des tokens
  // contre un navigateur mort). Cf memory reference-browser-mcp-freeze-bug + doc scellee.
  constructor(profile, transport, options = {}) {
    super();
    this.profile = profile; // nom du profil
    this.transport = transport; // StdioTransport | HttpTransport
    this.ready = false;
    this.initResult = null; // resultat initialize du backend (capabilities/serverInfo/protocolVersion)
    this._idCounter = 0;
    this._internal = new Map(); // id -> {resolve,reject}  (requetes internes du proxy : initialize, tools/list, ping)
    this._forward = new Map(); // backendId -> clientId    (requetes Claude->backend en vol)
    this._forwardMeta = new Map(); // backendId -> {tool, startedAt}  (FORENSIQUE : quoi + depuis quand, pour le rapport de gel)
    this._startPromise = null;
    this._exited = false;
    // Watchdog : n'agit que TANT QU'une requete est en vol (spec MCP utilities/ping : eviter le ping excessif).
    this._pingIntervalMs = options.pingIntervalMs ?? 15000; // periode entre deux pings quand ca attend
    this._pingTimeoutMs = options.pingTimeoutMs ?? 10000; // budget de reponse d'UN ping
    this._maxMissedPings = options.maxMissedPings ?? 3; // pings rates CONSECUTIFS => backend declare fige
    this._watchdog = null; // handle setInterval (null = inactif)
    this._missedPings = 0; // compteur de pings rates consecutifs (reset des qu'un ping repond)
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
    // FORENSIQUE (non-intrusif) : on retient CE qui est en vol (nom du tool si tools/call, sinon method)
    // + DEPUIS QUAND. Sert UNIQUEMENT au rapport de gel (freeze-report) — jamais a une decision.
    this._forwardMeta.set(id, { tool: clientMsg?.params?.name || clientMsg?.method || '?', startedAt: Date.now() });
    this._startWatchdog(); // une requete est en vol => surveiller la vivacite du backend
    this._write({ ...clientMsg, id });
  }

  // Instantane FORENSIQUE des requetes en vol : [{method, ageMs}] (age = maintenant - depart). Lu au
  // moment d'un gel pour le rapport. PUR de lecture (n'altere rien). now injectable pour les tests.
  inflightSummary(now = Date.now()) {
    return [...this._forwardMeta.values()].map((m) => ({ method: m.tool, ageMs: now - m.startedAt }));
  }

  // ---------- watchdog de liveness (ping applicatif MCP) ----------
  // ⚠️ Distingue "backend OCCUPE (action longue legitime)" de "backend FIGE (mort silencieux)".
  // Le contrat Streamable HTTP n'envoie AUCUN octet pendant une action longue (la reponse arrive a
  // la FIN) => un timeout d'inactivite tuerait un upload legitime (12 min = normal). SEUL un canal
  // SEPARE tranche : le `ping` (spec MCP 2025-11-25 utilities/ping, le receveur DOIT repondre {}).
  // Repond => vivant, on attend ; K pings CONSECUTIFS sans reponse => fige => on coupe (-32000).
  _startWatchdog() {
    if (this._watchdog || this._pingIntervalMs <= 0) return; // deja actif, ou desactive (intervalle<=0)
    this._missedPings = 0;
    this._watchdog = setInterval(() => { this._pingOnce().catch(() => {}); }, this._pingIntervalMs);
    this._watchdog.unref?.(); // NE JAMAIS retenir l'event loop du proxy sur le watchdog
  }

  _stopWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    this._missedPings = 0;
  }

  // Un cycle : ping le backend, borne par _pingTimeoutMs. Repond => reset ; timeout => compte ;
  // seuil atteint => _onExit('unresponsive') (meme chemin qu'un crash => -32000 aux requetes en vol,
  // recuperable : Claude reprend la main et peut appeler restart_profile).
  async _pingOnce() {
    if (this._exited) { this._stopWatchdog(); return; }
    if (this._forward.size === 0) { this._stopWatchdog(); return; } // plus rien en vol : on arrete de pinger
    const id = this._nextId();
    const answered = new Promise((resolve) => {
      // resolve(true) au retour du ping, resolve(false) si le backend meurt (reject des _internal).
      this._internal.set(id, { resolve: () => resolve(true), reject: () => resolve(false) });
      this._write({ jsonrpc: '2.0', id, method: 'ping', params: {} });
    });
    const timedOut = new Promise((resolve) => {
      const h = setTimeout(() => resolve(false), this._pingTimeoutMs);
      h.unref?.();
    });
    const ok = await Promise.race([answered, timedOut]);
    if (ok) { this._missedPings = 0; return; } // backend vivant (action longue legitime) : on continue d'attendre
    this._internal.delete(id); // timeout : purge l'entree orpheline (une reponse tardive n'aura personne)
    if (this._exited) return; // le backend est mort entre-temps (course) : rien a declarer
    this._missedPings += 1;
    if (this._missedPings >= this._maxMissedPings) {
      log(`[backend:${this.profile}] FIGE: ${this._missedPings} pings sans reponse => backend declare mort (unresponsive)`);
      // FORENSIQUE : snapshot AVANT _onExit (qui vide _forwardMeta). Le manager ecoute 'freeze' pour
      // ecrire le rapport riche (etat process, etc.). Emis UNIQUEMENT sur gel detecte => jamais bruyant.
      this.emit('freeze', { missedPings: this._missedPings, inflight: this.inflightSummary() });
      this._onExit(-1, 'unresponsive'); // renvoie -32000 aux requetes en vol + stoppe le watchdog
    }
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
        this._forwardMeta.delete(m.id); // FORENSIQUE : la requete a repondu => plus en vol
        if (this._forward.size === 0) this._stopWatchdog(); // plus rien en vol => on cesse de pinger
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
    this._stopWatchdog(); // le backend est mort/declare mort : plus rien a surveiller
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
    this._forwardMeta.clear();
    if (wasReady) log(`[backend:${this.profile}] exited code=${code} sig=${sig}`);
    this.emit('exit', code, sig);
  }

  stop() {
    this._stopWatchdog(); // ne pas laisser un interval de ping survivre a l'arret du backend
    try { this.transport.close(); } catch {}
    this.ready = false;
    this._startPromise = null;
  }
}
