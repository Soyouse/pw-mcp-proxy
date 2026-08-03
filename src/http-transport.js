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
import { describeError } from './error-detail.js';
// ⚠️ SOURCE UNIQUE des delais (budget.js) — NE JAMAIS ecrire une duree en dur ici (`_delay(500)`),
// meme « evidente » : sous cette forme elle echappe au gate temporel et sort de la source unique.
import { GET_RETRY_MS, GET_REOPEN_MS } from './budget.js';
import { PROTOCOL_FALLBACK } from './protocol.js';

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export class HttpTransport extends EventEmitter {
  constructor(url, { protocolVersion = PROTOCOL_FALLBACK, spec = null } = {}) {
    super();
    this.url = url;
    this._u = new URL(url); // parse une fois (hostname/port/path stables)
    this.protocolVersion = protocolVersion;
    this.spec = spec; // { command, args, label } : lu par le Manager (_reconcile compare spec.args)
    this.sessionId = null; // fourni par le serveur a l'initialize (peut rester null : mode stateless)
    this._closed = false;
    this._getAbort = null;
    this._getOpened = false;
    // 🛑 MEMOIRE DU HANDSHAKE — indispensable a la conformite du 404 (cf `_rouvrirSession`).
    // Le transport doit pouvoir REJOUER l'`initialize` SEUL, sans rien demander au Backend : c'est
    // la seule facon de tenir le MUST de la spec sans remonter de logique HTTP dans `backend.js`
    // (qui est AGNOSTIQUE au transport, invariant du depot).
    this._initialize = null; // le dernier message `initialize` vu passer, tel quel
    this._reouverture = null; // promesse de la reouverture EN COURS (serialise les concurrents)
    this._nReinit = 0; // discriminant des ids internes (jamais ceux du Backend)
  }

  // Interface commune des transports. Rien a demarrer cote HTTP : le serveur partage vit DEJA — le
  // DAEMON l'a garanti PRET (`acquerirProfil`) avant que ce transport soit construit. La session
  // s'ouvre au 1er send (initialize) qui capture le MCP-Session-Id ; le flux GET serveur->client ensuite.
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

  /**
   * POST bas-niveau d'UN message JSON-RPC. SOURCE UNIQUE des en-tetes de POST.
   * ⚠️ `send()` et `_rouvrirSession()` postaient le MEME bloc d'en-tetes, mot pour mot (detecte par
   * `jscpd` le 03/08). Deux copies = le jour ou la spec ajoute un en-tete obligatoire, on en corrige
   * une : le handshake de reprise partirait avec des en-tetes PERIMES, et seulement apres un 404 —
   * c'est-a-dire dans le chemin le plus rare et le plus difficile a reproduire du transport.
   * ⚠️ `accept` porte LES DEUX types : la spec autorise le serveur a repondre en JSON **ou** en SSE,
   * au choix, sur n'importe quelle requete. En omettre un = 406 intermittent.
   * @param {object} msg
   */
  _post(msg) {
    return this._req(
      'POST',
      this._headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
      JSON.stringify(msg),
    );
  }

  // POST un message. La/les reponse(s) remontent via l'event 'message'. Ne throw pas : signale
  // les echecs de transport via l'event 'error' (le Backend les traite comme une perte de backend).
  async send(msg, dejaRouvert = false) {
    if (this._closed) return;
    // ⚠️ MEMORISER L'`initialize` AU PASSAGE — il ne repassera jamais : le Backend ne l'emet qu'une
    // fois. Sans cette copie, une session terminee par le serveur serait irrattrapable ICI, et il
    // faudrait detruire tout le backend pour la refaire (l'ancien comportement, non conforme).
    if (msg?.method === 'initialize') this._initialize = msg;
    let res;
    try {
      res = await this._post(msg);
    } catch (e) {
      // ⚠️ describeError, JAMAIS e.message seul : `err.message` peut etre VIDE sur une erreur
      // socket, `err.code` ne l'est jamais (incident 01/08 non diagnosticable pour ce seul champ).
      this._fail('POST request: ' + describeError(e));
      return;
    }

    const sid = res.headers[SESSION_HEADER];
    if (sid) this.sessionId = sid; // capture a l'initialize

    if (res.status === 202) { res.stream.resume(); this._ensureGetStream(); return; } // notif/response acceptee, pas de corps
    if (res.status === 404) {
      res.stream.resume();
      // 🛑 UN 404 EST UN EVENEMENT NORMAL DE LA SPEC, PAS UNE PANNE — et c'est tout le sujet.
      // « The server MAY terminate the session at any time, after which it MUST respond […] 404 »,
      // et le client « MUST start a new session by sending a new InitializeRequest without a
      // session ID ». On rejoue donc le handshake ICI, puis on REPREND la requete d'origine.
      // ⚠️ `dejaRouvert` borne a UN essai : si le serveur 404 encore APRES un handshake tout neuf,
      // ce n'est plus une session perimee — c'est une vraie panne, et elle doit remonter.
      if (dejaRouvert || !(await this._rouvrirSession())) { this._fail('session expiree (404) et reouverture impossible'); return; }
      return this.send(msg, true);
    }
    if (res.status < 200 || res.status >= 300) { res.stream.resume(); this._fail(`HTTP ${res.status}`); return; }

    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/event-stream')) {
      await this._consumeSse(res.stream); // la reponse JSON-RPC arrive dans le flux, puis le serveur clot
    } else {
      // application/json (ou defaut) : un unique message (ou un batch)
      let body;
      try {
        body = JSON.parse(await this._readAll(res.stream));
      } catch (e) { this._fail('reponse JSON illisible: ' + describeError(e)); return; }
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
      if (!this._closed) log('SSE read err: ' + describeError(e));
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
        await this._delay(GET_RETRY_MS);
        continue;
      }
      if (res.status === 405) { res.stream.resume(); return; } // serveur sans flux GET : legitime, on s'en passe
      if (res.status === 404) {
        // MEME evenement normal que sur le POST (cf `send`). ⚠️ Ici on ne « reprend » rien : on
        // reboucle simplement, et le prochain tour ouvrira le GET avec la session toute neuve.
        res.stream.resume();
        if (!(await this._rouvrirSession())) { this._fail('session expiree (404 GET) et reouverture impossible'); return; }
        continue;
      }
      if (res.status < 200 || res.status >= 300 || !(res.headers['content-type'] || '').includes('text/event-stream')) {
        res.stream.resume();
        if (this._closed) return;
        await this._delay(GET_RETRY_MS);
        continue;
      }
      await this._consumeSse(res.stream);
      if (this._closed) return;
      await this._delay(GET_REOPEN_MS); // stream clos par le serveur : petite pause puis re-ouverture
    }
  }

  /**
   * Rejoue le handshake sur CE transport apres un 404 — le MUST de la spec Streamable HTTP.
   *
   * 🛑 POURQUOI LE TRANSPORT, ET PAS LE BACKEND. Une session terminee par le serveur est un fait
   * PUREMENT HTTP : le Backend, qui est AGNOSTIQUE au transport (invariant du depot), n'a pas a en
   * connaitre l'existence. L'ancien comportement remontait ce 404 en `transport error` ⇒ le Backend
   * se croyait mort ⇒ le Manager detruisait tout et respawnait. Ca marchait, mais ca ecrivait un
   * evenement NORMAL comme une PANNE — mensonge de log qui a fait chercher un bug pendant 2 jours.
   *
   * ⚠️ LA REPONSE A CE HANDSHAKE N'EST **JAMAIS** REMISE AU BACKEND, et c'est vital : il a deja
   * resolu son `initialize` il y a longtemps. Lui livrer une seconde reponse portant le MEME id
   * corromprait sa table de correspondance. D'ou l'id INTERNE ci-dessous, hors de son espace.
   * ⚠️ `notifications/initialized` est OBLIGATOIRE apres tout `initialize` (spec) : sans elle, le
   * serveur peut refuser les requetes suivantes — on aurait « repare » la session en la laissant
   * inutilisable, panne d'autant plus penible qu'elle serait intermittente.
   * ⚠️ SERIALISE par `_reouverture` : N requetes en vol prennent le 404 ENSEMBLE. Sans ce partage,
   * chacune ouvrirait sa session et toutes sauf la derniere seraient orphelines.
   * @returns {Promise<boolean>} vrai si la session est rouverte
   */
  _rouvrirSession() {
    if (this._reouverture) return this._reouverture; // une reouverture suffit pour tout le monde
    this._reouverture = (async () => {
      // ⚠️ SANS session-id : c'est litteralement ce que la spec exige (« without a session ID »).
      // Le garder ferait re-refuser la requete par le serveur, en boucle.
      this.sessionId = null;
      if (!this._initialize) return false; // 404 AVANT tout handshake : rien a rejouer, vraie anomalie
      const msg = { ...this._initialize, id: `pw-mcp-reinit-${++this._nReinit}` };
      let res;
      try { res = await this._post(msg); }
      catch (e) { log('reouverture de session: ' + describeError(e)); return false; }
      const sid = res.headers[SESSION_HEADER];
      if (sid) this.sessionId = sid;
      // Le corps est LU PUIS JETE (cf ci-dessus). Le consommer reste obligatoire : un flux non lu
      // retient la socket, et `node:http` finirait par ne plus rien pouvoir envoyer.
      // ⚠️ Le type de corps (JSON ou SSE) est SANS IMPORTANCE ici : on le draine dans les deux cas.
      try { await this._readAll(res.stream); }
      catch { /* SILENCE: le corps est jete de toute facon ; seuls le statut et le session-id comptent */ }
      if (res.status < 200 || res.status >= 300) { log(`reouverture de session refusee: HTTP ${res.status}`); return false; }
      // Notification (pas de reponse attendue) : on la POSTe directement pour ne pas repasser par
      // `send()`, qui la memoriserait et pourrait re-declencher une reouverture en cascade.
      try {
        const r = await this._req(
          'POST',
          this._headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        );
        r.stream.resume();
      } catch (e) { log('notifications/initialized apres reouverture: ' + describeError(e)); }
      log('session HTTP rouverte (404 = fin de session cote serveur, evenement NORMAL de la spec)');
      return true;
    })().finally(() => { this._reouverture = null; });
    return this._reouverture;
  }

  _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  _fail(reason) {
    if (this._closed) return;
    this.emit('error', new Error(reason));
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { this._getAbort?.abort(); } catch { /* SILENCE: annuler un flux deja termine n'est pas une erreur */ }
    // DELETE explicite (SHOULD) : libere la session cote serveur. Best-effort.
    if (this.sessionId) {
      try {
        const res = await this._req('DELETE', this._headers({}));
        res.stream.resume();
      } catch { /* SILENCE: DELETE de session = politesse envers un serveur peut-etre deja parti ; son echec ne change rien pour nous */ }
    }
    this.emit('close');
  }
}
