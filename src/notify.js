// notify.js — alerte operateur best-effort, ZERO dependance (node:http/https).
// Sert a SIGNALER un evenement rare qui reclame un humain (ex: collision de nom de tool suite
// a une update @playwright/mcp). Toujours logue ; POST NTFY EN PLUS si PW_MCP_NTFY_URL est defini.
// ⚠️ Best-effort STRICT : jamais bloquant, jamais throw, timeout court — un proxy stdio ne doit
// JAMAIS pendre ni crasher a cause d'une alerte. stdout reste JSON-RPC pur (on n'ecrit rien dessus).

import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { log } from './logger.js';
// ⚠️ SOURCE UNIQUE des delais (budget.js) — NE JAMAIS redeclarer une duree ici.
import { ALERT_TIMEOUT_MS } from './budget.js';
import { describeError } from './error-detail.js';

// url = résolu CONFIG-FIRST (profiles.json `ntfyUrl`) puis env `PW_MCP_NTFY_URL`. Rien de hardcodé :
// aucune URL/topic en dur (projet open-source → tout vient de la config de l'utilisateur).
export function alert(message, url) {
  const msg = String(message || '').slice(0, 2000);
  log('ALERT: ' + msg);
  const target = url || process.env.PW_MCP_NTFY_URL; // ex: https://ntfy.sh/mon-topic
  if (!target) return;
  return sendNtfy(target, msg);
}

function sendNtfy(url, msg) {
  try {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.request(url, { method: 'POST', timeout: ALERT_TIMEOUT_MS, headers: { Title: 'pw-mcp-proxy' } }, (res) => res.resume());
    req.on('error', (e) => log('NTFY err: ' + describeError(e)));
    req.on('timeout', () => req.destroy());
    req.end(msg);
  } catch (e) {
    log('NTFY exception: ' + describeError(e));
  }
}
