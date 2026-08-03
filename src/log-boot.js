// log-boot.js — POINT UNIQUE d'amorcage du journal. Pose le 03/08/2026.
//
// 🛑 POURQUOI CE FICHIER EXISTE. Les TROIS entrypoints du systeme (`index.js` le proxy,
// `daemon-main.js` le daemon, `child-guard.js` le gardien) ecrivent dans le MEME journal — c'est
// voulu : un incident se lit sur UNE seule chronologie. Chacun recopiait donc la meme resolution
// `PW_MCP_LOG || <racine>/pw-mcp-proxy.log`. Trois copies d'une meme verite = la definition du
// couplage implicite : en changer une seule fait ecrire un process AILLEURS que les deux autres,
// et l'incident devient illisible SANS qu'aucun test ne rougisse. (Invisible a `jscpd`, qui cherche
// des BLOCS dupliques, jamais une expression repetee dans trois fichiers — meme angle mort que
// `PROTOCOL_FALLBACK`, corrige la veille.)
//
// 🛑 ET C'EST AUSSI LE SEUL ENDROIT OU LE CRI DE PERTE SE CABLE. `logger.js` compte ses ecritures
// perdues mais ne peut PAS appeler `alert()` lui-meme : `notify.js` importe deja `logger.js`, et le
// depot interdit tout cycle d'import (`no-circular` = ERROR dans `.dependency-cruiser.cjs`, cliquet
// a zero). L'injection depuis ce module — qui, lui, peut importer les deux — est la seule forme qui
// garde le graphe acyclique. ⚠️ NE JAMAIS « simplifier » en important `notify` depuis `logger` :
// le gate d'architecture rougira, et pour une bonne raison.

import path from 'node:path';
import process from 'node:process';
import { initLogger } from './logger.js';
import { alert } from './notify.js';

/**
 * Amorce le journal du process courant et rend le chemin retenu.
 * ⚠️ `racine` = la RACINE DU DEPOT, pas `src/` : les trois entrypoints n'y vivent pas au meme
 * niveau, seul l'appelant sait la calculer. Il la passe ; on ne la devine pas ici.
 * @param {string} racine
 * @param {{maxBytes?:number, maxFiles?:number}} [opts]
 * @returns {string} le chemin du journal
 */
export function bootLogger(racine, opts = {}) {
  const fichier = process.env.PW_MCP_LOG || path.join(racine, 'pw-mcp-proxy.log');
  // ⚠️ `onPerte` = `alert` DIRECTEMENT (pas une lambda qui reformule) : `notify.js` est deja
  // best-effort STRICT (jamais bloquant, jamais throw). Ajouter une couche ne ferait qu'un endroit
  // de plus ou une exception pourrait naitre, dans le chemin exact ou le journal ne marche plus.
  initLogger(fichier, { ...opts, onPerte: alert });
  return fichier;
}
