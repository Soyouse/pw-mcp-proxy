// LE DAEMON UNIQUE — refcount tenu par le NOYAU.
//
// ⚠️ Dépendances INJECTÉES (spawn, kill, port, readiness) : aucun vrai serveur n'est lancé ici.
// Ce qui est sous test, c'est la DÉCISION (qui démarre, qui partage, qui arrête), pas l'I/O — et
// la décision doit être vérifiable sans dépendre de la charge de la machine.
// Le vrai binaire est couvert par contract-live ; le cycle de vie complet par acceptance-lifecycle.

import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ServerDaemon } from '../src/server-daemon.js';
import { requeteAcquire, lireReponse } from '../src/daemon-protocol.js';

const SPEC = { command: 'node', args: ['--version'] };
let seq = 0;
const daemons = [];
const socks = [];

// Canal UNIQUE par test : deux tests concurrents ne doivent jamais se disputer le même nom.
function env() {
  return { platform: process.platform, tmpdir: os.tmpdir(), userInfo: { username: `t${process.pid}x${++seq}` } };
}

function faux(overrides = {}) {
  const tues = [];
  let pidSeq = 5000;
  const d = new ServerDaemon({
    env: env(),
    spawnFn: () => ({ pid: ++pidSeq, on() {} }),
    tuer: (pid) => tues.push(pid),
    allouerPort: async () => 10000 + pidSeq,
    attendre: async () => 'pret',
    budgetMs: 500,
    ...overrides,
  });
  d._tues = tues;
  daemons.push(d);
  return d;
}

// Un client : se connecte, demande un profil, garde la connexion OUVERTE (= il compte).
function client(nomCanal, profil) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(nomCanal);
    socks.push(sock);
    let buf = '';
    sock.on('error', reject);
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const rep = lireReponse(JSON.parse(buf.slice(0, nl)));
      resolve({ sock, rep });
    });
    sock.write(JSON.stringify(requeteAcquire(profil, SPEC)) + '\n');
  });
}

const ferme = (sock) => new Promise((r) => { sock.on('close', r); sock.destroy(); });

// 🛑 FERMER UNE SOCKET ET ATTENDRE QUE LE DAEMON L'AIT ACTÉ. Utiliser CECI, jamais `ferme` seul,
// dès qu'on va observer l'état du daemon juste après.
//
// ⚠️ POURQUOI (défaut MESURÉ en CI le 03/08/2026 : 3 tests ROUGES sur ubuntu ET macOS, VERTS sur
// Windows). `ferme` n'attend que le `'close'` de NOTRE extrémité — un objet DIFFÉRENT de la socket
// serveur sur laquelle le daemon décompte. Or la doc Node est explicite : **il n'existe AUCUNE
// garantie d'ordre entre le `close` client et le `close` serveur** (vérifiée à la source le 03/08),
// et **aucune différence documentée entre socket Unix et named pipe** sur ces événements.
// ⇒ Windows ne faisait pas « autrement » : il GAGNAIT la course. Le test pariait sur un hasard.
// ⚠️ NE PAS « corriger » ça par un `setTimeout` ni par un test de plateforme : ce serait figer le
// hasard. On attend le FAIT émis par la seule autorité du ref-count — le daemon lui-même.
const fermeEtAttend = (d, sock) =>
  Promise.all([new Promise((r) => d.once('libere', r)), ferme(sock)]);

afterEach(() => {
  for (const s of socks.splice(0)) { try { s.destroy(); } catch {} }
  for (const d of daemons.splice(0)) { try { d.arreter(); } catch {} }
});

test('un client obtient une URL, le serveur est démarré UNE fois', async () => {
  const d = faux();
  expect(await d.demarrer()).toBe(true);
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(rep.ok).toBe(true);
  expect(rep.url).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
  expect(d.etat()).toEqual([{ profil: 'vegeta', port: expect.any(Number), pid: expect.any(Number), clients: 1 }]);
});

// S2 + S3 : plusieurs agents sur le MÊME profil partagent le MÊME navigateur.
test('DEUX clients du même profil PARTAGENT un seul serveur (jamais un 2e navigateur)', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  expect(b.rep.url, 'même URL pour les deux agents').toBe(a.rep.url);
  expect(d.etat()[0].clients, 'le refcount vaut 2').toBe(2);
  expect(d._tues, 'aucun serveur tué').toEqual([]);
});

// ⚠️ LA course qui compte : deux agents demandent le même profil AU MÊME INSTANT. Sans
// sérialisation, deux spawns pour un seul --user-data-dir ⇒ « browser is already in use ».
test('COURSE : deux demandes SIMULTANÉES du même profil => UN SEUL spawn', async () => {
  let spawns = 0;
  const d = faux({
    spawnFn: () => { spawns++; return { pid: 7000 + spawns, on() {} }; },
    // readiness lente : élargit la fenêtre de course pour la rendre observable
    attendre: async () => { await new Promise((r) => setTimeout(r, 60)); return 'pret'; },
  });
  await d.demarrer();
  const [a, b] = await Promise.all([client(d.nomCanal, 'perso'), client(d.nomCanal, 'perso')]);
  expect(spawns, 'UN seul serveur pour deux demandes concurrentes').toBe(1);
  expect(b.rep.url).toBe(a.rep.url);
});

test('profils DIFFÉRENTS => serveurs DIFFÉRENTS (étanchéité des identités)', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'perso');
  expect(b.rep.url).not.toBe(a.rep.url);
  expect(d.etat().length).toBe(2);
});

// S5 : un agent part, les autres continuent.
test('S5 : un client part, le serveur SURVIT pour les autres', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  await client(d.nomCanal, 'vegeta');
  await fermeEtAttend(d, a.sock);
  expect(d._tues, 'le départ d un client ne tue RIEN tant qu un autre est là').toEqual([]);
  expect(d.etat()[0].clients).toBe(1);
});

// S6 : le dernier part => le serveur s'arrête. ⚠️ Aucun TTL : `clients.size === 0` est un FAIT.
test('S6 : le DERNIER client parti => le serveur est arrêté IMMÉDIATEMENT', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  const pid = d.etat()[0].pid;
  await fermeEtAttend(d, a.sock);
  await fermeEtAttend(d, b.sock);
  expect(d._tues, 'le serveur du profil est arrêté, sans attendre aucun délai').toEqual([pid]);
  expect(d.etat()).toEqual([]);
});

// ⚠️ Un proxy tué brutalement (kill -9) ne ferme rien proprement — c'est le NOYAU qui ferme la
// socket. C'est toute la raison d'être du refcount par connexion : il n'y a RIEN à nettoyer.
test('un client TUÉ BRUTALEMENT est décompté quand même (le noyau ferme la socket)', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const pid = d.etat()[0].pid;
  // ⚠️ MÊME PIÈGE que `fermeEtAttend` : un `setTimeout(50)` ici PARIAIT sur la vitesse de la
  // machine (et le pari se perd en CI chargée). On attend le FAIT émis par le daemon.
  const acte = new Promise((r) => d.once('libere', r));
  a.sock.destroy(); // aucun message d'adieu, comme un kill -9
  await acte;
  expect(d._tues, 'le noyau a fermé la socket => refcount à 0 => serveur arrêté').toEqual([pid]);
});

// ⚠️ NON-RÉGRESSION — défaut trouvé en LIVE le 02/08 : le serveur mourait (kill externe, crash) et
// le daemon continuait à servir son URL MORTE à tout nouvel agent, indéfiniment. Le noyau nous le
// dit pourtant : nous sommes le PARENT, son `exit` est un FAIT. On OUBLIE l'entrée — sans respawn
// spontané (ce serait une boucle de relance que plus aucun client ne justifie).
test('serveur MORT sans que personne ne parte => entrée retirée, le suivant repart sur un serveur NEUF', async () => {
  const enfants = [];
  let pidSeq = 8000;
  const d = faux({
    spawnFn: () => {
      const handlers = {};
      const c = { pid: ++pidSeq, on(ev, fn) { handlers[ev] = fn; }, mourir: () => handlers.exit?.(1, null) };
      enfants.push(c);
      return c;
    },
    // ⚠️ Port DISTINCT à chaque spawn : sinon l'URL du serveur neuf serait identique à celle du
    // cadavre et le test ne pourrait plus les distinguer (il passerait pour de mauvaises raisons).
    allouerPort: async () => 20000 + pidSeq,
  });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const pidMort = d.etat()[0].pid;

  enfants[0].mourir(); // crash / kill externe : AUCUNE socket ne s'est fermée
  expect(d.etat(), 'le profil n est plus servi : son URL ne vaut plus rien').toEqual([]);

  const b = await client(d.nomCanal, 'vegeta');
  expect(b.rep.ok).toBe(true);
  expect(b.rep.url, 'un serveur NEUF, jamais l URL du cadavre').not.toBe(a.rep.url);
  expect(d.etat()[0].pid).not.toBe(pidMort);
});

// ⚠️ Événement PÉRIMÉ : l'`exit` du serveur REMPLACÉ ne doit pas emporter le nouveau.
test('exit d un serveur DÉJÀ remplacé : le serveur courant est INTACT', async () => {
  const enfants = [];
  let pidSeq = 9000;
  const d = faux({
    spawnFn: () => {
      const handlers = {};
      const c = { pid: ++pidSeq, on(ev, fn) { handlers[ev] = fn; }, mourir: () => handlers.exit?.(1, null) };
      enfants.push(c);
      return c;
    },
  });
  await d.demarrer();
  await client(d.nomCanal, 'vegeta');
  enfants[0].mourir();
  await client(d.nomCanal, 'vegeta'); // remplacant
  const courant = d.etat()[0].pid;
  enfants[0].mourir(); // l ancien re-emet : doit etre IGNORE
  expect(d.etat()[0]?.pid, 'le remplacant survit a l evenement perime').toBe(courant);
});

test('EADDRINUSE : un SECOND daemon refuse de démarrer (fait exact du noyau)', async () => {
  const e = env();
  const d1 = new ServerDaemon({ env: e, spawnFn: () => ({ pid: 1, on() {} }), tuer() {}, allouerPort: async () => 1, attendre: async () => 'pret' });
  const d2 = new ServerDaemon({ env: e, spawnFn: () => ({ pid: 2, on() {} }), tuer() {}, allouerPort: async () => 2, attendre: async () => 'pret' });
  daemons.push(d1, d2);
  expect(await d1.demarrer(), 'le premier prend le canal').toBe(true);
  expect(await d2.demarrer(), 'le second constate qu il est en trop').toBe(false);
});

// ⚠️ Le daemon sert N agents : un message hostile de l'un ne doit pas les priver tous.
test('requête INVALIDE : refus nommé, le daemon reste debout', async () => {
  const d = faux();
  await d.demarrer();
  const rep = await new Promise((resolve) => {
    const sock = net.connect(d.nomCanal);
    socks.push(sock);
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(lireReponse(JSON.parse(buf.slice(0, nl))));
    });
    sock.write(JSON.stringify({ op: 'acquire', profile: '', spec: SPEC }) + '\n');
  });
  expect(rep.ok).toBe(false);
  expect(rep.erreur).toMatch(/profile/);
  // toujours vivant : un client valide passe derrière
  const bon = await client(d.nomCanal, 'vegeta');
  expect(bon.rep.ok).toBe(true);
});

test('serveur qui ne démarre pas : erreur NOMMÉE, et le pid est tué (zéro fuite)', async () => {
  const d = faux({ attendre: async () => 'mort' });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(rep.ok).toBe(false);
  expect(rep.erreur, 'distingue « mort » de « muet » — jamais accuser le réseau').toMatch(/ARRÊTÉ avant d/);
  expect(d._tues.length, 'le process avorté est tué, pas laissé derrière').toBe(1);
  expect(d.etat(), 'rien n est inscrit pour un serveur qui n a jamais servi').toEqual([]);
});
