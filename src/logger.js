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
let maxBytes = 5 * 1024 * 1024; // 5 Mo par generation
let maxFiles = 3; // file + file.1 + file.2 => borne DURE ~15 Mo

export function initLogger(file, opts = {}) {
  logFile = file;
  if (opts.maxBytes !== undefined) maxBytes = opts.maxBytes;
  if (opts.maxFiles !== undefined) maxFiles = opts.maxFiles;
  enabled = true;
}

// Taille REELLE du fichier. ⚠️ NE JAMAIS remplacer par un compteur d'octets en memoire : le projet
// est MULTI-AGENT et les N proxys ecrivent dans le MEME fichier. Un compteur par process ne voit que
// SES propres octets => chacun se croit sous le plafond alors que le fichier reel vaut la SOMME
// => cap franchi d'un facteur N, EN SILENCE (usure SSD). Le filesystem est la SEULE verite partagee.
// Cout : un statSync par ligne, negligeable (logs = SIGNAL only, quelques lignes/min).
// Absent (une rotation concurrente vient de le renommer) => 0 : la generation repart proprement.
// Scelle par le test « MULTI-AGENT : les octets ecrits par un AUTRE process comptent dans la borne ».
function _realSize() {
  try { return fs.statSync(logFile).size; } catch { return 0; }
}

// Applique le plan de rotation (pur). ⚠️ Windows : renameSync ECHOUE si la destination existe =>
// unlink(to) prealable OBLIGATOIRE. Tout est best-effort : une rotation ratee ne tue jamais le proxy.
function _rotate() {
  const plan = rotationPlan(logFile, maxFiles);
  for (const [from, to] of plan) {
    // Silence DELIBERE (x2) : le logger ne peut pas se logguer lui-meme sans recursion infinie.
    // Un echec ici (course avec un autre proxy, verrou Windows) est RATTRAPE par le filet dur
    // ci-dessous, qui garantit la borne quoi qu'il arrive. Aucune information n'est donc perdue.
    try { if (fs.existsSync(to)) fs.unlinkSync(to); } catch {}
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
  }
  // ⚠️ FILET DUR — NE PAS RETIRER. Si le fichier courant SURVIT au plan, la borne disque serait
  // perdue EN SILENCE (croissance infinie = usure SSD). Deux cas REELS :
  //   - maxFiles<=1 : plan VIDE par construction (aucune archive demandee) ;
  //   - Windows MULTI-AGENT : renameSync REFUSE (EPERM/EBUSY) car un AUTRE proxy tient le fichier
  //     ouvert au meme instant — le catch ci-dessus l'avale, la rotation n'a PAS eu lieu.
  // truncateSync, lui, n'exige pas l'exclusivite : il ramene la generation courante a zero.
  // Le cap devient une borne DURE quel que soit le nombre de proxys concurrents.
  try { if (_realSize() > maxBytes) fs.truncateSync(logFile, 0); } catch {}
}

export function log(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
    '\n';
  // Silence DELIBERE : stderr peut etre ferme/casse (pipe rompu du parent). Un logger qui THROW
  // ferait tomber le proxy — le remede deviendrait la panne. Le fichier reste, lui, disponible.
  try {
    process.stderr.write(line);
  } catch {}
  if (!enabled) return;
  const lineBytes = Buffer.byteLength(line);
  // Silence DELIBERE : disque plein, chemin devenu invalide, course de rotation avec un autre
  // proxy. Logguer l'echec du log = recursion infinie ; le faire remonter = tuer le proxy pour
  // une ligne de journal. Le SIGNAL, lui, est deja parti sur stderr juste au-dessus.
  try {
    if (shouldRotate(_realSize(), lineBytes, maxBytes)) _rotate();
    fs.appendFileSync(logFile, line);
  } catch {}
}
