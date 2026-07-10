// Logs -> stderr + fichier. JAMAIS stdout (reserve au JSON-RPC, invariant sacre).
import fs from 'node:fs';

let logStream = null;

export function initLogger(file) {
  try {
    logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    logStream = null; // best-effort : un log casse ne doit jamais tuer le proxy
  }
}

export function log(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
    '\n';
  try {
    process.stderr.write(line);
  } catch {}
  if (logStream) {
    try {
      logStream.write(line);
    } catch {}
  }
}
