// http-transport.js — I/O : client MCP « Streamable HTTP » (transport standard MCP 2025-11-25).
// ZERO dependance : node:http natif. Le FRAMING SSE vient de sse-parse.js (pur).
// ICI : le reseau + le respect du contrat CLIENT (skill playwright-mcp-api).
//
// ⚠️ POURQUOI node:http ET PAS fetch (NE PAS revenir a fetch — gate statique no-fetch.test.js) :
// fetch (undici) applique un bodyTimeout par DEFAUT de 300 s ENTRE deux chunks (doc officielle
// undici Client.md, verifiee 2026-07-24) et fetch ne permet PAS de le desactiver sans passer un
// dispatcher undici custom = dependance runtime (interdite). Consequence mesuree en prod : le flux
// GET SSE idle etait COUPE toutes les ~5 min (« SSE read err: terminated » en boucle) et la reponse
// SSE d'un POST d'action LONGUE (upload 12 min, flux muet pendant l'action = contrat Streamable
// HTTP) aurait ete tuee a 300 s = reponse PERDUE. node:http n'a AUCUN timeout de body par defaut ;
// la liveness reste garantie par le watchdog ping de backend.js (fails-closed), jamais par un
// timeout d'inactivite (interdit — tuerait l'action longue legitime).
//
// Modele : full-duplex evenementiel pour rester un remplacant transparent du transport stdio.
//   - send(msg)  : POST le message (fire-and-forget cote appelant) ; les messages RECUS (la reponse
//                  JSON-RPC, + toute request/notif serveur liee) sont RE-EMIS via l'event 'message'.
//   - GET SSE    : flux persistant pour les requests/notifs serveur->client NON sollicitees.
//   - close()    : DELETE la session + coupe le GET.
// Ainsi le Backend consomme un unique flux d'events 'message', qu'il soit stdio OU http (agnostique).
//
// ⚠️ Contrat CLIENT (tous MUST de la spec, cf skill playwright-mcp-api / modelcontextprotocol.io) :
//   POST + Accept: application/json,text/event-stream ; gerer JSON *ou* SSE ; renvoyer MCP-Session-Id
//   sur toutes les requetes des qu'il est fourni ; MCP-Protocol-Version post-init ; 404 => session morte.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { sseFeed } from './sse-parse.js';
import { log } from './logger.js';

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export class HttpTransport extends EventEmitter {
  constructor(url, { protocolVersion = '2025-06-18', spec = null } = {}) {
    super();
    this.url = url;
    this._u = new URL(url); // parse une fois (hostname/port/path stables)
    this.protocolVersion = protocolVersion;
    this.spec = spec; // { command, args, label } : lu par le Manager (_reconcile compare spec.args)
    this.sessionId = null; // fourni par le serveur a l'initialize (peut rester null : mode stateless)
    this._closed = false;
    this._getAbort = null;
    this._getOpened = false;
  }

  // Interface commune des transports. Rien a demarrer cote HTTP : le serveur partage vit deja (garanti
  // par supervisor.ensureServer AVANT l'injection de ce transport). La session s'ouvre au 1er send
  // (initialize) qui capture le MCP-Session-Id ; le flux GET serveur->client s'ouvre ensuite.
  async start() {}

  _headers(base) {
    const h = { ...base, [PROTOCOL_HEADER]: this.protocolVersion };
    if (this.sessionId) h[SESSION_HEADER] = this.sessionId; // MUST des qu'il est connu
    return h;
  }

  // Requete HTTP bas-niveau (node:http). Resout a la reception des HEADERS ({status, headers, stream}) ;
  // le corps (stream = IncomingMessage) est consomme par l'appelant. AUCUN timeout pose ici (voir
  // l'entete du fichier) ; `signal` optionnel pour couper (flux GET au close()).
  _req(method, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this._u.hostname,
          port: this._u.port,
          path: this._u.pathname + this._u.search,
          method,
          headers,
          signal,
        },
        (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res })
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  // POST un message. La/les reponse(s) remontent via l'event 'message'. Ne throw pas : signale
  // les echecs de transport via l'event 'error' (le Backend les traite comme une perte de backend).
  async send(msg) {
    if (this._closed) return;
    let res;
    try {
      res = await this._req(
        'POST',
        this._headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        JSON.stringify(msg)
      );
    } catch (e) {
      this._fail('POST request: ' + e.message);
      return;
    }

    const sid = res.headers[SESSION_HEADER];
    if (sid) this.sessionId = sid; // capture a l'initialize

    if (res.status === 202) { res.stream.resume(); this._ensureGetStream(); return; } // notif/response acceptee, pas de corps
    if (res.status === 404) { res.stream.resume(); this._fail('session expiree (404)'); return; }
    if (res.status < 200 || res.status >= 300) { res.stream.resume(); this._fail(`HTTP ${res.status}`); return; }

    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/event-stream')) {
      await this._consumeSse(res.stream); // la reponse JSON-RPC arrive dans le flux, puis le serveur clot
    } else {
      // application/json (ou defaut) : un unique message (ou un batch)
      let body;
      try {
        body = JSON.parse(await this._readAll(res.stream));
      } catch (e) { this._fail('reponse JSON illisible: ' + e.message); return; }
      this._emitMessage(body);
    }
    this._ensureGetStream(); // apres l'init, ouvrir le sens serveur->client
  }

  async _readAll(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  _emitMessage(body) {
    if (Array.isArray(body)) for (const m of body) this.emit('message', m); // batch JSON-RPC
    else this.emit('message', body);
  }

  // Lit un flux SSE (IncomingMessage) jusqu'a sa fin, re-emet chaque event data qui parse en JSON-RPC.
  async _consumeSse(stream) {
    if (!stream) return;
    const dec = new TextDecoder();
    let pending = '';
    try {
      for await (const chunk of stream) {
        const r = sseFeed(pending, dec.decode(chunk, { stream: true }));
        pending = r.pending;
        for (const ev of r.events) {
          if (!ev.data) continue; // priming/keep-alive (data vide) : ignore
          let m;
          try { m = JSON.parse(ev.data); } catch { continue; } // event non-JSON : ignore
          this._emitMessage(m);
        }
      }
    } catch (e) {
      if (!this._closed) log('SSE read err: ' + e.message);
    }
  }

  // Ouvre (une seule fois) le flux GET pour les messages serveur->client non sollicites.
  _ensureGetStream() {
    if (this._getOpened || this._closed) return;
    this._getOpened = true;
    this._openGet();
  }

  async _openGet() {
    // Le serveur peut clore le stream a tout moment (spec) : on re-ouvre tant qu'on est vivant.
    while (!this._closed) {
      this._getAbort = new AbortController();
      let res;
      try {
        res = await this._req('GET', this._headers({ accept: 'text/event-stream' }), undefined, this._getAbort.signal);
      } catch {
        if (this._closed) return;
        await this._delay(500);
        continue;
      }
      if (res.status === 405) { res.stream.resume(); return; } // serveur sans flux GET : legitime, on s'en passe
      if (res.status === 404) { res.stream.resume(); this._fail('session expiree (404 GET)'); return; }
      if (res.status < 200 || res.status >= 300 || !(res.headers['content-type'] || '').includes('text/event-stream')) {
        res.stream.resume();
        if (this._closed) return;
        await this._delay(500);
        continue;
      }
      await this._consumeSse(res.stream);
      if (this._closed) return;
      await this._delay(300); // stream clos par le serveur : petite pause puis re-ouverture
    }
  }

  _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  _fail(reason) {
    if (this._closed) return;
    this.emit('error', new Error(reason));
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { this._getAbort?.abort(); } catch {}
    // DELETE explicite (SHOULD) : libere la session cote serveur. Best-effort.
    if (this.sessionId) {
      try {
        const res = await this._req('DELETE', this._headers({}));
        res.stream.resume();
      } catch {}
    }
    this.emit('close');
  }
}
