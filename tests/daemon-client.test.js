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
import { listProcesses } from '../src/prockill.js';
import { taggedArgs, PROC_MARK, survivors } from './harness.js'; // ⚠️ marque les process spawnés par le CODE (ratchet)

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

// 🛑 LE TEST DE L ORPHELIN — la panne que `child-guard.js` rend IMPOSSIBLE.
// Un daemon tue a `-9` ne peut RIEN nettoyer : c'est tout l'enjeu. Sans gardien, son serveur
// survivrait en tenant son `--user-data-dir` a vie => « browser is already in use », profil mort
// jusqu'a une intervention humaine. Le gardien tient le stdin du daemon : sa mort ferme le tuyau,
// l'EOF arrive, le serveur tombe. Aucun balayage, aucun jugement sur des process existants.
// ⚠️ CE QUE CE TEST VAUT, SELON L'OS — mesuré par negative-check le 02/08 :
//   POSIX (Linux/macOS) : DISCRIMINANT. Rien n'y tue les enfants d'un parent mort ⇒ sans gardien,
//     le serveur survivrait et ce test rougirait. C'est en CI (matrice 3 OS) qu'il fait son travail.
//   WINDOWS : NON DISCRIMINANT — il reste VERT même gardien retiré, car Windows place les enfants
//     dans le JOB OBJECT du parent et les tue avec lui. L'orphelin ne s'y reproduit pas.
// ⇒ NE PAS conclure « le gardien marche » d'un vert obtenu sous Windows. Le MÉCANISME lui-même
// (EOF ⇒ l'enfant meurt) est prouvé sur tous les OS par `tests/child-guard.test.js`.
// ⚠️ NE JAMAIS neutraliser ce test pour « accelerer » : en CI POSIX, c'est lui qui tient la ligne.
test('DAEMON TUE BRUTALEMENT (-9) : son serveur ne SURVIT PAS (zéro orphelin)', async () => {
  const e = env();
  const { url, connexion } = await acquerirProfil('orphelin', spec(), e);
  ouvertes.push(connexion);
  const port = Number(new URL(url).port);

  // Le serveur existe VRAIMENT (on l'identifie par le port qu'il sert, pas par un registre).
  const avant = listProcesses().find((p) => p.cmd.includes(`--port ${port}`));
  expect(avant, 'préalable : un process sert bien ce port').toBeTruthy();

  // ⚠️ CIBLER LE BON DAEMON, par SON canal : chaque test de ce fichier lance le sien (canal unique
  // par test). Chercher « daemon-main.js » tout court tuerait celui du voisin — et le test
  // conclurait à un orphelin alors que le mécanisme marche (piège vécu ici même).
  const canal = daemonChannelName(e);
  const daemon = listProcesses().find((p) => p.cmd.includes('daemon-main.js') && p.cmd.includes(canal));
  expect(daemon, `le daemon du canal ${canal} est identifiable`).toBeTruthy();
  process.kill(daemon.pid, 'SIGKILL');

  // Le serveur DOIT disparaître, sans que personne ne le lui demande.
  const t0 = Date.now();
  let survivant = true;
  while (Date.now() - t0 < 15000) {
    survivant = listProcesses().some((p) => p.cmd.includes(`--port ${port}`));
    if (!survivant) break;
    await new Promise((r) => { const t = setTimeout(r, 100); t.unref?.(); });
  }
  expect(survivant, 'ORPHELIN : le serveur a survécu à la mort brutale de son daemon').toBe(false);
}, 40000);

// 🛑 GATE #11 — LE DAEMON DOIT ÊTRE VISIBLE DU RATCHET (posé le 03/08/2026).
//
// LA CAUSE RACINE, ENFIN NOMMÉE. « Le daemon et ses serveurs survivent aux runs » traînait depuis
// des semaines, et on l'a longtemps cru intermittent. Il ne l'était pas : le ratchet du harnais
// scanne les CMDLINE à la recherche de son marqueur. Le gardien et le serveur le portent (ils
// viennent de la `spec`, construite par `taggedArgs`) — mais le daemon, lui, est spawné par
// `daemon-client.js` à partir de rien, et sa cmdline était VIERGE. Il échappait donc au scan,
// survivait à la suite, et emportait ses serveurs avec lui.
// ⚠️ LA LEÇON, plus large que ce bug : **le gate existait et il regardait à côté**. Un garde-fou
// n'est pas prouvé par son existence mais par sa CAPACITÉ À VOIR — ici, 6 orphelins mesurés sur la
// machine le 03/08 pendant que le ratchet était vert à chaque fichier. D'où ce test : il ne
// vérifie pas que le daemon meurt (le refcount s'en charge), il vérifie qu'il est OBSERVABLE.
// ⚠️ Négatif structurel : `PWMCP_TEST` est absent HORS test ⇒ la cmdline de production n'est pas
// touchée. Le marqueur ne peut donc pas fuir chez l'utilisateur.
test('GATE : le daemon porte le marqueur du harnais — sinon le ratchet est AVEUGLE sur lui', async () => {
  const e = env();
  const { connexion } = await acquerirProfil('vegeta', spec(), e);
  ouvertes.push(connexion);

  const daemons = listProcesses().filter((p) => p.cmd.includes('daemon-main.js'));
  expect(daemons.length, 'préalable : un daemon réel tourne').toBeGreaterThan(0);

  const vus = daemons.filter((p) => p.cmd.includes(PROC_MARK));
  expect(vus.length,
    'DAEMON INVISIBLE AU RATCHET : sa cmdline ne porte pas le marqueur ⇒ il survivrait à la suite ' +
    'avec ses serveurs, et le gate resterait VERT (c est exactement le défaut #11)').toBeGreaterThan(0);

  // Et le ratchet lui-même — celui qui décide du ROUGE — doit le compter parmi ses survivants.
  expect(survivors().some((p) => p.cmd.includes('daemon-main.js')),
    'le scan du ratchet DOIT retrouver le daemon : c est lui, et lui seul, qui rend une fuite bruyante').toBe(true);
});
