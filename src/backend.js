// Un Backend = un serveur MCP enfant (ex: @playwright/mcp@latest) lie a UN profil isole.
// Le proxy est CLIENT de ce backend. Bidirectionnel : le backend peut aussi
// envoyer des requetes (server->client) qui remontent jusqu'a Claude.
//
// ⚠️ NE JAMAIS hardcoder ni filtrer la liste de tools ici. Le backend est une boite
// noire : on relaie. C'est ce qui rend le proxy increvable face aux updates Microsoft.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { log } from './logger.js';
import { treeKill } from './prockill.js';

export class Backend extends EventEmitter {
  constructor(profile, spec) {
    super();
    this.profile = profile; // nom du profil
    this.spec = spec; // { command, args, label }
    this.child = null;
    this.ready = false;
    this.initResult = null; // resultat initialize du backend (capabilities/serverInfo/protocolVersion)
    this._idCounter = 0;
    this._internal = new Map(); // id -> {resolve,reject}  (requetes internes du proxy : initialize, tools/list)
    this._forward = new Map(); // backendId -> clientId    (requetes Claude->backend en vol)
    this._startPromise = null;
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
    const onWin = process.platform === 'win32';
    // ⚠️ shell:true UNIQUEMENT pour une commande bare type `npx` (resolue en npx.cmd via PATHEXT).
    // Un binaire absolu (.exe) se spawn SANS shell, sinon un espace dans le chemin
    // ("C:\Program Files\...") casse tout. Detection chirurgicale, NE PAS remettre shell:onWin.
    const needsShell = onWin && !path.isAbsolute(this.spec.command) && !/\.(exe|com)$/i.test(this.spec.command);
    let command = this.spec.command;
    let args = this.spec.args;
    if (needsShell) {
      // cmd.exe : on quote ce qui contient un espace
      command = /\s/.test(command) ? `"${command}"` : command;
      args = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
    }
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
      // POSIX : propre groupe de process (pgid = pid) => treeKill(-pid) tue Chrome (petit-enfant).
      // Windows : inutile, taskkill /T gere l'arbre ; detached y ouvrirait une console.
      detached: !onWin,
    });

    this.child.on('error', (e) => {
      log(`[backend:${this.profile}] spawn error: ${e.message}`);
    });

    this.reader = new NdjsonReader(this.child.stdout);
    this.reader.on('message', (m) => this._onMessage(m));
    this.reader.on('parse_error', (e, line) =>
      log(`[backend:${this.profile}] bad json from backend: ${line.slice(0, 200)}`)
    );

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => log(`[backend:${this.profile}] ${String(d).trimEnd()}`));
    this.child.on('exit', (code, sig) => this._onExit(code, sig));

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
    if (!this.child || !this.child.stdin.writable) {
      log(`[backend:${this.profile}] write on dead backend dropped (${msg.method || 'resp'})`);
      return;
    }
    writeMessage(this.child.stdin, msg);
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
    const pid = this.child?.pid;
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    // ⚠️ OBLIGATOIRE : tuer l'ARBRE. child.kill() ci-dessus ne touche que npx (parent direct) ;
    // le petit-enfant chrome.exe survivrait et garderait le lock --user-data-dir (leak P0,
    // "Browser is already in use"). treeKill = taskkill /T (Win) / kill du groupe (POSIX).
    if (pid) treeKill(pid);
    this.ready = false;
    this._startPromise = null;
  }
}
