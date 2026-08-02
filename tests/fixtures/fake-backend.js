#!/usr/bin/env node
// Faux serveur MCP pour les tests d'integration du proxy (zero dependance).
//
// 🛑 DEUX TRANSPORTS, UN SEUL COMPORTEMENT. `--port` present => Streamable HTTP (le mode de la
// PROD) ; sinon stdio ndjson. Le `handle()` plus bas est PARTAGE mot pour mot par les deux : c'est
// ce qui permet de faire tourner LA MEME suite d'integration sur les deux transports sans en
// dupliquer une seule assertion. Un comportement duplique divergerait, et la matrice ne prouverait
// plus rien. ⚠️ NE JAMAIS forker ce fichier en deux fixtures.
// `--tag X` distingue deux backends.
// Tools exposes : echo_<tag>, notify_<tag> (emet une notif), ask_<tag> (requete server->client).

import process from 'node:process';
import { exigerSousTest } from './sous-test.js';

// 🛑 FAILS-CLOSED, EN TOUT PREMIER : rien n'est ouvert avant cette ligne, donc rien a nettoyer
// si on refuse. Une fixture lancee hors harnais echappe au ratchet et survit indefiniment.
exigerSousTest('tests/fixtures/fake-backend.js');

const tagIdx = process.argv.indexOf('--tag');
const TAG = tagIdx !== -1 ? process.argv[tagIdx + 1] : 'X';
// Simule le gating par capability : --caps=storage debloque un outil supplementaire.
const capsArg = process.argv.find((a) => a.startsWith('--caps='));
const CAPS = capsArg ? capsArg.slice('--caps='.length).split(',') : [];
// --collide : simule une update backend qui exposerait un tool du MEME nom qu'un tool maison
// (ici switch_profile) -> exerce la garde anti-collision du router.
const COLLIDE = process.argv.includes('--collide');

// --host/--port sont ajoutes par le DAEMON en mode HTTP (comme au vrai @playwright/mcp).
const iPort = process.argv.indexOf('--port');
const PORT = iPort !== -1 ? Number(process.argv[iPort + 1]) : null;
const iHost = process.argv.indexOf('--host');
const HOST = iHost !== -1 ? process.argv[iHost + 1] : 'localhost';

// ---------------------------------------------------------------------------
// MODE HTTP (prod) — n'existe que si --port est passe.
// ---------------------------------------------------------------------------
if (PORT) {
  const http = await import('node:http');
  /** id de requete client -> reponse HTTP en attente (le POST reste OUVERT tant qu'on n'a pas repondu) */
  const enAttente = new Map();
  let fluxGet = null; // flux SSE serveur->client (ouvert par le proxy)
  let sessions = 0;

  // ⚠️ `send` a la MEME signature qu'en stdio : c'est ce qui rend `handle()` reutilisable tel quel.
  send = (msg) => {
    const estReponse = msg.id !== undefined && msg.method === undefined;
    if (estReponse) {
      const res = enAttente.get(msg.id);
      if (res) {
        enAttente.delete(msg.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(msg));
        return;
      }
    }
    // Notification, OU requete serveur->client (ask_) : par le flux GET, seule voie descendante.
    if (fluxGet) fluxGet.write(`data: ${JSON.stringify(msg)}

`);
  };

  const serveur = http.createServer((req, res) => {
    // ⚠️ Handlers d'erreur socket OBLIGATOIRES (cf doc tests) : un RST apres reponse complete
    // remonte sur la SOCKET, pas sur req/res => uncaughtException => fixture morte en silence.
    req.on('error', () => {});
    res.on('error', () => {});

    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 🛑 FLUSH IMMEDIAT DES EN-TETES — sans ca, Node les GARDE tant que rien n'est ecrit, et un
      // flux SSE peut rester muet longtemps. La sonde de readiness (GET /mcp) n'obtenait alors
      // JAMAIS de reponse : port OUVERT mais serveur declare « VIVANT mais silencieux » au bout de
      // 20 s. Mesure du 02/08 — c'est ce qui a fait echouer toute la passe HTTP de la matrice.
      res.flushHeaders();
      fluxGet = res;
      req.on('close', () => { if (fluxGet === res) fluxGet = null; });
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      const estRequete = msg.id !== undefined && msg.method !== undefined;
      if (!estRequete) { res.writeHead(202); res.end(); handle(msg); return; } // notif / reponse du client
      if (msg.method === 'initialize') {
        // Session-Id : le proxy DOIT le renvoyer ensuite (spec Streamable HTTP).
        enAttente.set(msg.id, Object.assign(res, { _sid: true }));
        res.setHeader('mcp-session-id', 'sess-' + ++sessions);
      } else {
        enAttente.set(msg.id, res);
      }
      handle(msg);
    });
  });
  serveur.on('clientError', (e, sock) => sock.destroy());
  serveur.on('connection', (sock) => sock.on('error', () => {}));
  serveur.listen(PORT, HOST);
}

let buf = '';
if (!PORT) process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let askCounter = 0;
const pendingAsks = new Map(); // id requete server->client -> id du tools/call a resoudre

function handle(m) {
  // reponse du client a une requete server->client (test reverse routing)
  if (m.id !== undefined && m.method === undefined && (m.result !== undefined || m.error !== undefined)) {
    const callId = pendingAsks.get(m.id);
    if (callId !== undefined) {
      pendingAsks.delete(m.id);
      send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: `client a repondu: ${JSON.stringify(m.result)}` }], isError: false } });
    }
    return;
  }
  if (m.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true }, logging: {} },
        serverInfo: { name: `fake-${TAG}`, version: '0.0.1' },
        instructions: `fake backend ${TAG}`,
      },
    });
    return;
  }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'ping') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
    return;
  }
  if (m.method === 'tools/list') {
    const tools = [
      { name: `echo_${TAG}`, description: `echo ${TAG}`, inputSchema: { type: 'object', properties: { v: { type: 'string' } } } },
      { name: `notify_${TAG}`, description: `emet une notif ${TAG}`, inputSchema: { type: 'object' } },
      { name: `ask_${TAG}`, description: `requete server->client ${TAG}`, inputSchema: { type: 'object' } },
    ];
    if (CAPS.includes('storage')) tools.push({ name: `storage_${TAG}`, description: `cap storage ${TAG}`, inputSchema: { type: 'object' } });
    if (COLLIDE) tools.push({ name: 'switch_profile', description: `tool backend homonyme ${TAG}`, inputSchema: { type: 'object' } });
    send({ jsonrpc: '2.0', id: m.id, result: { tools } });
    return;
  }
  if (m.method === 'tools/call') {
    const name = m.params?.name;
    const args = m.params?.arguments || {};
    if (name === `echo_${TAG}`) {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${TAG}:${args.v ?? ''}` }], isError: false } });
      return;
    }
    if (name === `notify_${TAG}`) {
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `hello from ${TAG}` } });
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'notified' }], isError: false } });
      return;
    }
    if (name === `ask_${TAG}`) {
      const reqId = `srv${TAG}.${++askCounter}`;
      pendingAsks.set(reqId, m.id);
      send({ jsonrpc: '2.0', id: reqId, method: 'roots/list', params: {} });
      return;
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
    return;
  }
  // methode inconnue (test passthrough) : echo de la methode
  if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: { ok: true, method: m.method, tag: TAG } });
  }
}
