// http-transport.js — I/O : client MCP « Streamable HTTP » (transport standard MCP 2025-11-25).
// ZERO dependance : fetch/AbortController/ReadableStream natifs (Node>=20). Le FRAMING SSE vient de
// sse-parse.js (pur). ICI : le reseau + le respect du contrat CLIENT (skill playwright-mcp-api).
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

import { EventEmitter } from 'node:events';
import { sseFeed } from './sse-parse.js';
import { log } from './logger.js';

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export class HttpTransport extends EventEmitter {
  constructor(url, { protocolVersion = '2025-06-18', spec = null } = {}) {
    super();
    this.url = url;
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

  // POST un message. La/les reponse(s) remontent via l'event 'message'. Ne throw pas : signale
  // les echecs de transport via l'event 'error' (le Backend les traite comme une perte de backend).
  async send(msg) {
    if (this._closed) return;
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this._headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        body: JSON.stringify(msg),
      });
    } catch (e) {
      this._fail('POST fetch: ' + e.message);
      return;
    }

    const sid = res.headers.get(SESSION_HEADER);
    if (sid) this.sessionId = sid; // capture a l'initialize

    if (res.status === 202) { this._ensureGetStream(); return; } // notif/response acceptee, pas de corps
    if (res.status === 404) { this._fail('session expiree (404)'); return; }
    if (!res.ok) { this._fail(`HTTP ${res.status}`); return; }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      await this._consumeSse(res.body); // la reponse JSON-RPC arrive dans le flux, puis le serveur clot
    } else {
      // application/json (ou defaut) : un unique message (ou un batch)
      let body;
      try { body = await res.json(); } catch (e) { this._fail('reponse JSON illisible: ' + e.message); return; }
      this._emitMessage(body);
    }
    this._ensureGetStream(); // apres l'init, ouvrir le sens serveur->client
  }

  _emitMessage(body) {
    if (Array.isArray(body)) for (const m of body) this.emit('message', m); // batch JSON-RPC
    else this.emit('message', body);
  }

  // Lit un flux SSE jusqu'a sa fin, re-emet chaque event data qui parse en JSON-RPC.
  async _consumeSse(stream) {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const r = sseFeed(pending, dec.decode(value, { stream: true }));
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
    } finally {
      try { reader.releaseLock(); } catch {}
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
        res = await fetch(this.url, {
          method: 'GET',
          headers: this._headers({ accept: 'text/event-stream' }),
          signal: this._getAbort.signal,
        });
      } catch {
        if (this._closed) return;
        await this._delay(500);
        continue;
      }
      if (res.status === 405) return; // serveur sans flux GET : legitime, on s'en passe
      if (res.status === 404) { this._fail('session expiree (404 GET)'); return; }
      if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
        if (this._closed) return;
        await this._delay(500);
        continue;
      }
      await this._consumeSse(res.body);
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
        await fetch(this.url, { method: 'DELETE', headers: this._headers({}) });
      } catch {}
    }
    this.emit('close');
  }
}
