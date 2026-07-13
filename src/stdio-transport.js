// stdio-transport.js — I/O : transport MCP sur STDIO (spawn d'un serveur MCP enfant, ndjson).
// Extrait de backend.js pour que Backend soit AGNOSTIQUE au transport (stdio OU http-transport.js).
// Interface commune des transports : start() · send(msg) · close() · events 'message'|'exit'|'error'.
//
// ⚠️ shell:true UNIQUEMENT pour une commande bare (`npx`) ; binaire absolu (.exe) => shell:false
// (un espace dans le chemin casse sinon). NE PAS remettre shell:onWin. ⚠️ close() = treeKill
// OBLIGATOIRE (pas child.kill() seul) : sinon le petit-enfant chrome.exe survit et garde le lock
// --user-data-dir (leak P0). detached POSIX => groupe tuable en bloc.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NdjsonReader, writeMessage } from './jsonrpc.js';
import { log } from './logger.js';
import { treeKill } from './prockill.js';
import { resolveShellSpawn } from './spawn-cmd.js';

export class StdioTransport extends EventEmitter {
  constructor(profile, spec) {
    super();
    this.profile = profile;
    this.spec = spec; // { command, args, label }
    this.child = null;
  }

  get pid() {
    return this.child?.pid;
  }

  async start() {
    // Resolution cross-OS centralisee (spawn-cmd.js) : shell:true + quoting pour une commande bare
    // (`npx`) sur Windows, sinon shell:false. SOURCE UNIQUE partagee avec supervisor.js.
    const { command, args, shell } = resolveShellSpawn(this.spec.command, this.spec.args);
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
      detached: process.platform !== 'win32', // POSIX : pgid = pid => treeKill(-pid) tue Chrome (petit-enfant)
    });

    this.child.on('error', (e) => log(`[backend:${this.profile}] spawn error: ${e.message}`));

    this.reader = new NdjsonReader(this.child.stdout);
    this.reader.on('message', (m) => this.emit('message', m));
    this.reader.on('parse_error', (e, line) =>
      log(`[backend:${this.profile}] bad json from backend: ${String(line).slice(0, 200)}`)
    );

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => log(`[backend:${this.profile}] ${String(d).trimEnd()}`));
    this.child.on('exit', (code, sig) => this.emit('exit', code, sig));
  }

  send(msg) {
    if (!this.child || !this.child.stdin.writable) {
      log(`[backend:${this.profile}] write on dead backend dropped (${msg.method || 'resp'})`);
      return;
    }
    writeMessage(this.child.stdin, msg);
  }

  async close() {
    const pid = this.child?.pid;
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
    // ⚠️ OBLIGATOIRE : tuer l'ARBRE (cf en-tete). child.kill() ne touche que le parent direct.
    if (pid) treeKill(pid);
  }
}
