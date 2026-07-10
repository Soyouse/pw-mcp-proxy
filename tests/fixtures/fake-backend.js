#!/usr/bin/env node
// Faux serveur MCP pour les tests d'integration du proxy (zero dependance).
// Parle le protocole MCP sur stdio ndjson. `--tag X` distingue deux backends.
// Tools exposes : echo_<tag>, notify_<tag> (emet une notif), ask_<tag> (requete server->client).

import process from 'node:process';

const tagIdx = process.argv.indexOf('--tag');
const TAG = tagIdx !== -1 ? process.argv[tagIdx + 1] : 'X';
// Simule le gating par capability : --caps=storage debloque un outil supplementaire.
const capsArg = process.argv.find((a) => a.startsWith('--caps='));
const CAPS = capsArg ? capsArg.slice('--caps='.length).split(',') : [];
// --collide : simule une update backend qui exposerait un tool du MEME nom qu'un tool maison
// (ici switch_profile) -> exerce la garde anti-collision du router.
const COLLIDE = process.argv.includes('--collide');

let buf = '';
process.stdin.setEncoding('utf8');
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
