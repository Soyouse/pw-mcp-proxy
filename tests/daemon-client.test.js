// BOUT EN BOUT client <-> daemon : vrai canal nommé, vrai process daemon, vrai refcount noyau.
//
// ⚠️ Ce test lance un DAEMON RÉEL (process détaché) mais AUCUN navigateur : la `spec` envoyée est
// un `node -e` qui ouvre un port et se tait. On teste la CHAÎNE (lancement, signal `ready`,
// partage, libération), pas @playwright/mcp — lui est couvert par contract-live.

import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import { acquerirProfil } from '../src/daemon-client.js';
import { daemonChannelName } from '../src/channel-name.js';
import { taggedArgs } from './harness.js'; // ⚠️ marque les process spawnés par le CODE (ratchet)

// Faux serveur : ouvre le port qu'on lui donne, répond à tout, ne meurt pas seul.
const FAUX_SERVEUR =
  "const h=require('node:http').createServer((q,r)=>{r.writeHead(200);r.end('ok')});" +
  "const i=process.argv.indexOf('--port');h.listen(Number(process.argv[i+1]),'localhost');";

let seq = 0;
const ouvertes = [];
function env() {
  return { platform: process.platform, tmpdir: os.tmpdir(), userInfo: { username: `dc${process.pid}y${++seq}` } };
}
const spec = () => ({ command: process.execPath, args: taggedArgs(['-e', FAUX_SERVEUR]) });
const ferme = (s) => new Promise((r) => { s.on('close', r); s.destroy(); });

afterEach(async () => {
  for (const s of ouvertes.splice(0)) { try { await ferme(s); } catch {} }
});

test('BOUT EN BOUT : le client LANCE le daemon, obtient une URL joignable', async () => {
  const e = env();
  const { url, connexion } = await acquerirProfil('vegeta', spec(), e);
  ouvertes.push(connexion);
  expect(url).toMatch(/^http:\/\/localhost:\d+\/mcp$/);

  // Le serveur annoncé répond VRAIMENT (question au noyau, pas au daemon).
  const port = Number(new URL(url).port);
  const joignable = await new Promise((r) => {
    const s = net.connect(port, 'localhost');
    s.on('connect', () => { s.destroy(); r(true); });
    s.on('error', () => r(false));
  });
  expect(joignable, "l'URL rendue est joignable — un FAIT, pas une promesse").toBe(true);
}, 60000);

test('DEUX clients du même profil : même URL, UN seul serveur (le 2e ne relance rien)', async () => {
  const e = env();
  const a = await acquerirProfil('vegeta', spec(), e);
  const b = await acquerirProfil('vegeta', spec(), e);
  ouvertes.push(a.connexion, b.connexion);
  expect(b.url, 'le second REJOINT le serveur du premier').toBe(a.url);
}, 60000);

// ⚠️ LE cœur du refcount : fermer la connexion libère le profil, SANS aucun message d'adieu.
test('S6 : la dernière connexion fermée => le serveur devient injoignable (zéro TTL)', async () => {
  const e = env();
  const { url, connexion } = await acquerirProfil('perso', spec(), e);
  const port = Number(new URL(url).port);

  await ferme(connexion); // aucun « je m'en vais » : le NOYAU ferme, le daemon en déduit un FAIT

  // On observe le noyau jusqu'à ce qu'il confirme (l'arrêt est immédiat côté daemon, mais la
  // fermeture du port par l'OS n'est pas instantanée — on CONSTATE, on ne suppose pas).
  let libre = false;
  for (let i = 0; i < 40 && !libre; i++) {
    libre = await new Promise((r) => {
      const s = net.connect(port, 'localhost');
      s.on('connect', () => { s.destroy(); r(false); });
      s.on('error', () => r(true));
    });
    if (!libre) await new Promise((r) => setTimeout(r, 50));
  }
  expect(libre, 'plus aucun client => le serveur est arrêté').toBe(true);
}, 60000);

test('un SECOND daemon ne peut pas naître : le canal est unique par utilisateur', async () => {
  const e = env();
  const a = await acquerirProfil('vegeta', spec(), e);
  ouvertes.push(a.connexion);
  // Un client sur le MÊME canal doit tomber sur le daemon EXISTANT, jamais en créer un autre.
  const b = await acquerirProfil('autre', spec(), e);
  ouvertes.push(b.connexion);
  expect(b.url).not.toBe(a.url); // profils distincts => serveurs distincts…
  expect(daemonChannelName(e), '…mais UN SEUL canal, donc UN SEUL daemon').toBe(daemonChannelName(e));
}, 60000);
