// Transport MCP stdio = JSON-RPC delimite par newline (ndjson).
// ⚠️ INVARIANT SACRE : un message = une ligne JSON, JAMAIS de newline embarque.
// Ce module ne connait RIEN du contenu des messages (transparence totale du proxy).

import { EventEmitter } from 'node:events';

// Lit un flux (stdin / stdout d'un child) et emet un objet par ligne JSON complete.
export class NdjsonReader extends EventEmitter {
  constructor(stream) {
    super();
    this._buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => this._onData(chunk));
    stream.on('close', () => this.emit('close'));
    stream.on('end', () => this.emit('close'));
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit('parse_error', e, line);
        continue;
      }
      this.emit('message', msg);
    }
  }
}

// Ecrit un message JSON-RPC sur un flux (newline-delimited).
// ⚠️ stdout du proxy = JSON-RPC PUR. Aucun autre write dessus (logs -> stderr/fichier).
export function writeMessage(stream, msg) {
  stream.write(JSON.stringify(msg) + '\n');
}
