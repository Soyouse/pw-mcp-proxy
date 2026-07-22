// Logs -> stderr + fichier. JAMAIS stdout (reserve au JSON-RPC, invariant sacre).
// ⚠️ Ecriture SYNCHRONE (appendFileSync) et NON un WriteStream : le volume est faible (SIGNAL only —
// cycle de vie + erreurs, JAMAIS le trafic par-requete/ping), et le sync ELIMINE la course
// "renommer le fichier pendant qu'un flush async traine" au moment de la rotation.
// ⚠️ ROTATION PAR TAILLE OBLIGATOIRE (built-to-last) : sans elle le fichier croit sans borne =
// fuite disque silencieuse. Decision = log-rotate.js (PUR, mutation-teste) ; ICI = l'I/O.
import fs from 'node:fs';
import { shouldRotate, rotationPlan } from './log-rotate.js';

let logFile = null;
let enabled = false;
let bytesWritten = 0;
let maxBytes = 5 * 1024 * 1024; // 5 Mo par generation
let maxFiles = 3; // file + file.1 + file.2 => borne DURE ~15 Mo

export function initLogger(file, opts = {}) {
  logFile = file;
  if (opts.maxBytes !== undefined) maxBytes = opts.maxBytes;
  if (opts.maxFiles !== undefined) maxFiles = opts.maxFiles;
  try {
    bytesWritten = fs.existsSync(file) ? fs.statSync(file).size : 0;
    enabled = true;
  } catch {
    enabled = false; // best-effort : un log casse ne doit JAMAIS tuer le proxy
  }
}

// Applique le plan de rotation (pur). ⚠️ Windows : renameSync ECHOUE si la destination existe =>
// unlink(to) prealable OBLIGATOIRE. Tout est best-effort : une rotation ratee ne tue jamais le proxy.
function _rotate() {
  const plan = rotationPlan(logFile, maxFiles);
  if (plan.length === 0) {
    try { fs.truncateSync(logFile, 0); } catch {} // maxFiles<=1 : pas d'archive => repart a zero
    bytesWritten = 0;
    return;
  }
  for (const [from, to] of plan) {
    try { if (fs.existsSync(to)) fs.unlinkSync(to); } catch {}
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
  }
  bytesWritten = 0;
}

export function log(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
    '\n';
  try {
    process.stderr.write(line);
  } catch {}
  if (!enabled) return;
  const lineBytes = Buffer.byteLength(line);
  try {
    if (shouldRotate(bytesWritten, lineBytes, maxBytes)) _rotate();
    fs.appendFileSync(logFile, line);
    bytesWritten += lineBytes;
  } catch {}
}
