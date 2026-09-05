// LE DAEMON UNIQUE — refcount tenu par le NOYAU, UNE INSTANCE PAR CLIENT (05/09/2026).
//
// ⚠️ Dépendances INJECTÉES (spawn, kill, port, readiness, coffre) : aucun vrai serveur ni aucun
// disque ici. Ce qui est sous test, c'est la DÉCISION (qui démarre, qui range, qui arrête), pas
// l'I/O — et la décision doit être vérifiable sans dépendre de la charge de la machine.
// Le vrai binaire est couvert par contract-live ; le cycle de vie complet par acceptance-lifecycle ;
// le coffre réel par identity-store.test.js.

import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
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

// Faux enfants : `tuer(pid)` fait ce que fait le NOYAU après un kill — il délivre `exit`. Sans ça
// le daemon attendrait (à raison) un événement qui ne viendrait jamais : il attend le FAIT, pas un délai.
function fauxEnfants(base = 5000) {
  const enfants = new Map();
  const tues = [];
  let pidSeq = base;
  const spawnFn = () => {
    const handlers = {};
    const c = {
      pid: ++pidSeq,
      on(ev, fn) { (handlers[ev] ||= []).push(fn); },
      once(ev, fn) { const w = (...a) => { handlers[ev] = (handlers[ev] || []).filter((h) => h !== w); fn(...a); }; (handlers[ev] ||= []).push(w); },
      mourir(code = 1, sig = null) { for (const h of [...(handlers.exit || [])]) h(code, sig); },
    };
    enfants.set(c.pid, c);
    return c;
  };
  const tuer = (pid) => { tues.push(pid); enfants.get(pid)?.mourir(null, 'SIGKILL'); };
  return { spawnFn, tuer, tues, enfants, dernierPid: () => pidSeq };
}

// Faux coffre : enregistre CHAQUE appel dans l'ordre (c'est l'ordre qui est sous test).
function fauxStore() {
  const appels = [];
  return {
    appels,
    materialiser: async (i) => { appels.push(['materialiser', i.identite, i.instanceId, i.strategie]); return `/inst/${i.instanceId}`; },
    snapshotRetour: async (i) => { appels.push(['snapshotRetour', i.identite, i.instanceDir]); return { ok: true, octets: 1024 * 1024 }; },
    supprimerInstance: (dir) => { appels.push(['supprimerInstance', dir]); },
    // Le vrai `attendreLibre` renomme en `<dir>.fini` quand plus aucun process ne tient le dossier ; le
    // faux le simule sans disque (le daemon doit ranger/supprimer le chemin RENDU, jamais l'original).
    attendreLibre: async (dir) => { appels.push(['attendreLibre', dir]); return `${dir}.fini`; },
    ecrireConfigInstance: (chemin, cfg) => { appels.push(['ecrireConfigInstance', chemin, cfg]); return chemin; },
    supprimerConfigInstance: (chemin) => { appels.push(['supprimerConfigInstance', chemin]); },
  };
}

function faux(overrides = {}) {
  const enf = fauxEnfants(overrides.pidBase);
  const alertes = [];
  const store = overrides.store || fauxStore();
  const d = new ServerDaemon({
    env: env(),
    spawnFn: enf.spawnFn,
    tuer: enf.tuer,
    allouerPort: async () => 10000 + enf.dernierPid() + 1,
    attendre: async () => 'pret',
    budgetMs: 500,
    store,
    alerter: (msg) => alertes.push(msg),
    ...overrides,
  });
  d._tues = enf.tues;
  d._enfants = enf.enfants;
  d._alertes = alertes;
  d._store = store; // ⚠️ meme objet que celui injecte : les appels s'y lisent
  daemons.push(d);
  return d;
}

const INSTANCE = (identite, extra = {}) => ({ identite, strategie: 'snapshot', persist: true, storeDir: '/coffre', instancesDir: '/inst', plafonds: {}, ...extra });

// Un client : se connecte, demande un profil (± une identité), garde la connexion OUVERTE (= il compte).
function client(nomCanal, profil, instance = null, extraSpec = {}) {
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
    sock.write(JSON.stringify(requeteAcquire(profil, { ...SPEC, ...extraSpec }, instance)) + '\n');
  });
}

const ferme = (sock) => new Promise((r) => { sock.on('close', r); sock.destroy(); });

// 🛑 FERMER UNE SOCKET ET ATTENDRE QUE LE DAEMON AIT FINI AVEC L'INSTANCE. Utiliser CECI, jamais
// `ferme` seul, dès qu'on va observer l'état du daemon juste après.
//
// ⚠️ POURQUOI (défaut MESURÉ en CI le 03/08/2026 : 3 tests ROUGES sur ubuntu ET macOS, VERTS sur
// Windows). `ferme` n'attend que le `'close'` de NOTRE extrémité — un objet DIFFÉRENT de la socket
// serveur sur laquelle le daemon décompte. Or la doc Node est explicite : **il n'existe AUCUNE
// garantie d'ordre entre le `close` client et le `close` serveur** (vérifiée à la source le 03/08),
// et **aucune différence documentée entre socket Unix et named pipe** sur ces événements.
// ⇒ Windows ne faisait pas « autrement » : il GAGNAIT la course. Le test pariait sur un hasard.
// ⚠️ NE PAS « corriger » ça par un `setTimeout` ni par un test de plateforme : ce serait figer le
// hasard. On attend le FAIT émis par la seule autorité du ref-count — le daemon lui-même.
// ⚠️ Depuis le 05/09 `'libere'` est émis APRÈS le rangement (kill → exit → snapshot → rm) : après
// lui, l'état est FINAL.
const fermeEtAttend = (d, sock) =>
  Promise.all([new Promise((r) => d.once('libere', r)), ferme(sock)]).then(([ev]) => ev);

afterEach(() => {
  for (const s of socks.splice(0)) { try { s.destroy(); } catch {} }
  for (const d of daemons.splice(0)) { try { d.arreter(); } catch {} }
});

test('un client obtient une URL ET un instanceId, le serveur est démarré UNE fois', async () => {
  const d = faux();
  expect(await d.demarrer()).toBe(true);
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(rep.ok).toBe(true);
  expect(rep.url).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
  expect(rep.instanceId).toBe('vegeta-1');
  expect(d.etat()).toEqual([{ instanceId: 'vegeta-1', profil: 'vegeta', identite: null, port: expect.any(Number), pid: expect.any(Number), dir: null }]);
});

// S2 RÉÉCRIT (05/09/2026) : deux agents sur le MÊME profil = DEUX instances. Mesuré le 04/09 :
// un serveur partagé fait qu'un agent écrase la page de l'autre. Jamais plus de partage.
test('S2 : DEUX clients du même profil => DEUX instances, DEUX URLs, DEUX serveurs', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  expect(b.rep.url, 'jamais la même URL : jamais le même onglet').not.toBe(a.rep.url);
  expect([a.rep.instanceId, b.rep.instanceId]).toEqual(['vegeta-1', 'vegeta-2']);
  expect(d.etat().length).toBe(2);
  expect(d._tues, 'aucun serveur tué').toEqual([]);
});

test('deux demandes SIMULTANÉES du même profil => DEUX spawns (plus aucune sérialisation de partage)', async () => {
  const d = faux({ attendre: async () => { await new Promise((r) => setTimeout(r, 30)); return 'pret'; } });
  await d.demarrer();
  const [a, b] = await Promise.all([client(d.nomCanal, 'perso'), client(d.nomCanal, 'perso')]);
  expect(d._enfants.size, 'un serveur PAR client').toBe(2);
  expect(b.rep.url).not.toBe(a.rep.url);
});

test('profils DIFFÉRENTS => serveurs DIFFÉRENTS (étanchéité des identités)', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'perso');
  expect(b.rep.url).not.toBe(a.rep.url);
  expect(d.etat().map((e) => e.instanceId).sort()).toEqual(['perso-1', 'vegeta-1']);
});

// S5 : un agent part, SON instance est rangée, celle de l'autre continue.
test('S5 : un client part => SON serveur est arrêté, celui de l autre SURVIT intact', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  const pidA = d.etat().find((e) => e.instanceId === 'vegeta-1').pid;
  const ev = await fermeEtAttend(d, a.sock);
  expect(ev).toEqual({ profil: 'vegeta', identite: null, instanceId: 'vegeta-1', restants: 1 });
  expect(d._tues, 'le départ de A tue A, et rien d autre').toEqual([pidA]);
  expect(d.etat().map((e) => e.instanceId)).toEqual(['vegeta-2']);
  expect(b.sock.destroyed).toBe(false);
});

// S6 : le dernier part => plus rien ne vit. ⚠️ Aucun TTL : la fermeture de la socket est un FAIT.
test('S6 : le DERNIER client parti => son serveur est arrêté IMMÉDIATEMENT, plus aucune instance', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  const pids = d.etat().map((e) => e.pid);
  await fermeEtAttend(d, a.sock);
  await fermeEtAttend(d, b.sock);
  expect(d._tues.sort(), 'les deux serveurs arrêtés, sans attendre aucun délai').toEqual(pids.sort());
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
  expect(d._tues, 'le noyau a fermé la socket => instance rangée => serveur arrêté').toEqual([pid]);
});

// ⚠️ NON-RÉGRESSION — défaut trouvé en LIVE le 02/08 : le serveur mourait (kill externe, crash) et
// le daemon continuait à servir son URL MORTE. Le noyau nous le dit : nous sommes le PARENT, son
// `exit` est un FAIT. L'instance est RANGÉE — sans respawn spontané (ce serait une boucle de relance
// que plus aucun client ne justifie) ; le client redemande et obtient une instance NEUVE.
test('serveur MORT sans que personne ne parte => instance rangée, le suivant repart sur un serveur NEUF', async () => {
  const d = faux({ pidBase: 8000 });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const pidMort = d.etat()[0].pid;
  const range = new Promise((r) => d.once('libere', r));
  d._enfants.get(pidMort).mourir(1, null); // crash / kill externe : AUCUNE socket ne s'est fermée
  await range;
  expect(d.etat(), 'l instance n est plus servie : son URL ne vaut plus rien').toEqual([]);
  expect(d._tues, 'déjà mort : on ne tue pas un cadavre').toEqual([]);

  const b = await client(d.nomCanal, 'vegeta');
  expect(b.rep.ok).toBe(true);
  expect(b.rep.url, 'un serveur NEUF, jamais l URL du cadavre').not.toBe(a.rep.url);
  expect(b.rep.instanceId).toBe('vegeta-2');
  expect(d.etat()[0].pid).not.toBe(pidMort);
});

// ⚠️ Événement PÉRIMÉ : l'`exit` d'un serveur DÉJÀ rangé ne doit rien emporter.
test('exit d un serveur DÉJÀ rangé : l instance courante est INTACTE', async () => {
  const d = faux({ pidBase: 9000 });
  await d.demarrer();
  await client(d.nomCanal, 'vegeta');
  const ancien = d._enfants.get(d.etat()[0].pid);
  const range = new Promise((r) => d.once('libere', r));
  ancien.mourir(1, null);
  await range;
  await client(d.nomCanal, 'vegeta'); // remplaçant
  const courant = d.etat()[0].pid;
  ancien.mourir(1, null); // l ancien ré-émet : doit être IGNORÉ
  expect(d.etat()[0]?.pid, 'le remplaçant survit à l événement périmé').toBe(courant);
});

test('EADDRINUSE : un SECOND daemon refuse de démarrer (fait exact du noyau)', async () => {
  const e = env();
  const d1 = new ServerDaemon({ env: e, spawnFn: () => ({ pid: 1, on() {}, once() {} }), tuer() {}, allouerPort: async () => 1, attendre: async () => 'pret' });
  const d2 = new ServerDaemon({ env: e, spawnFn: () => ({ pid: 2, on() {}, once() {} }), tuer() {}, allouerPort: async () => 2, attendre: async () => 'pret' });
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

// ═══ IDENTITÉS (profil v2) : matérialiser → servir → RANGER, dans cet ordre, jamais un délai ═══

test('identité : materialiser AVANT le spawn, --user-data-dir = le dossier d instance (valeur RUNTIME)', async () => {
  let argsVus = null;
  const enf = fauxEnfants(6000);
  const d = faux({ spawnFn: (cmd, args, opts) => { argsVus = args; return enf.spawnFn(cmd, args, opts); }, tuer: enf.tuer });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  expect(rep.instanceId).toBe('vegeta-1');
  expect(d._store.appels).toEqual([['materialiser', 'vegeta', 'vegeta-1', 'snapshot']]);
  const i = argsVus.indexOf('--user-data-dir');
  expect(i, 'le dossier d instance est passé au serveur').toBeGreaterThan(0);
  expect(argsVus[i + 1]).toBe('/inst/vegeta-1');
  expect(d.etat()[0]).toMatchObject({ identite: 'vegeta', dir: '/inst/vegeta-1' });
});

test('identité persist:true : au départ => kill → exit → snapshotRetour → supprimerInstance, dans CET ordre', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  const pid = d.etat()[0].pid;
  const ev = await fermeEtAttend(d, a.sock);
  expect(ev).toEqual({ profil: 'vegeta', identite: 'vegeta', instanceId: 'vegeta-1', restants: 0 });
  expect(d._tues).toEqual([pid]);
  expect(d._store.appels).toEqual([
    ['materialiser', 'vegeta', 'vegeta-1', 'snapshot'],
    ['attendreLibre', '/inst/vegeta-1'],
    ['snapshotRetour', 'vegeta', '/inst/vegeta-1.fini'],
    ['supprimerInstance', '/inst/vegeta-1.fini'],
  ]);
  expect(d._alertes).toEqual([]);
});

test('identité persist:false : au départ => PAS de snapshotRetour, instance supprimée quand même', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'job', INSTANCE('job', { persist: false }));
  await fermeEtAttend(d, a.sock);
  expect(d._store.appels).toEqual([['materialiser', 'job', 'job-1', 'snapshot'], ['attendreLibre', '/inst/job-1'], ['supprimerInstance', '/inst/job-1.fini']]);
});

// ⚠️ Chrome est un PETIT-ENFANT : aucun événement ne nous dit qu'il a lâché ses fichiers. Si le dossier
// reste verrouillé au-delà du budget, on ne range PAS et on ne supprime PAS : on CRIE, rien n'est perdu.
test('identité : dossier toujours VERROUILLÉ après le budget => ni snapshot ni rm, opérateur ALERTÉ', async () => {
  const store = fauxStore();
  store.attendreLibre = async (dir) => { store.appels.push(['attendreLibre', dir]); return null; };
  const d = faux({ store });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  await fermeEtAttend(d, a.sock);
  expect(d._store.appels).toEqual([['materialiser', 'vegeta', 'vegeta-1', 'snapshot'], ['attendreLibre', '/inst/vegeta-1']]);
  expect(d._alertes.length).toBe(1);
  expect(d._alertes[0]).toMatch(/VERROUILLE/);
  expect(d.etat(), 'l instance est retirée quand même (le client est parti)').toEqual([]);
});

// ═══ bindHost : l'adresse d'écoute est une DONNÉE, transmise TELLE QUELLE au serveur ═══
test('bindHost absent => --host localhost, SANS --allowed-hosts ; URL en localhost', async () => {
  let argsVus = null;
  const enf = fauxEnfants(6100);
  const d = faux({ spawnFn: (cmd, args, opts) => { argsVus = args; return enf.spawnFn(cmd, args, opts); }, tuer: enf.tuer });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(argsVus[argsVus.indexOf('--host') + 1]).toBe('localhost');
  expect(argsVus.includes('--allowed-hosts')).toBe(false);
  expect(rep.url).toMatch(/^http:\/\/localhost:/);
});

// ⚠️ PAS de `--allowed-hosts` : la couche MCP (0.0.80, `installHttpTransport`) compare l'en-tête Host
// ENTIER (`hote:port`) à sa liste, dont le DÉFAUT est déjà l'hôte lié avec son port. Le passer sans
// port remplaçait ce défaut par une liste fausse ⇒ 403 (mesuré en live le 05/09).
test('bindHost hors loopback => --host <h> SANS --allowed-hosts, URL sur <h>, port alloué sur <h>', async () => {
  let argsVus = null, hoteAlloc = null;
  const enf = fauxEnfants(6200);
  const d = faux({
    bindHost: '169.254.29.100',
    spawnFn: (cmd, args, opts) => { argsVus = args; return enf.spawnFn(cmd, args, opts); },
    tuer: enf.tuer,
    allouerPort: async (h) => { hoteAlloc = h; return 40000 + enf.dernierPid(); },
  });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(argsVus[argsVus.indexOf('--host') + 1]).toBe('169.254.29.100');
  expect(argsVus.includes('--allowed-hosts'), 'le défaut du serveur (hôte lié:port) est le seul juste').toBe(false);
  expect(hoteAlloc, 'le port est alloué sur la MÊME chaîne que le --host (double pile)').toBe('169.254.29.100');
  expect(rep.url).toMatch(/^http:\/\/169\.254\.29\.100:\d+\/mcp$/);
});

test('identité inplace : aucune copie retour, RIEN n est supprimé (le dossier EST le coffre)', async () => {
  const store = fauxStore();
  store.materialiser = async (i) => { store.appels.push(['materialiser', i.identite, i.instanceId, i.strategie]); return '/coffre/vegeta'; };
  const d = faux({ store });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta', { strategie: 'inplace' }));
  await fermeEtAttend(d, a.sock);
  expect(d._store.appels).toEqual([['materialiser', 'vegeta', 'vegeta-1', 'inplace']]);
});

test('identité : snapshotRetour REFUSÉ (plafond) => l opérateur est ALERTÉ, l instance est quand même supprimée', async () => {
  const store = fauxStore();
  store.snapshotRetour = async () => ({ ok: false, raison: 'snapshot de 400 Mo > plafond' });
  const d = faux({ store });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  await fermeEtAttend(d, a.sock);
  expect(d._alertes.length).toBe(1);
  expect(d._alertes[0]).toMatch(/NON rangée/);
  expect(d._alertes[0]).toMatch(/plafond/);
  expect(d._store.appels.at(-1)).toEqual(['supprimerInstance', '/inst/vegeta-1.fini']);
});

test('identité : serveur MORT (crash) => rangement quand même (snapshot puis rm), sans tuer un cadavre', async () => {
  const d = faux({ pidBase: 7000 });
  await d.demarrer();
  await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  const pid = d.etat()[0].pid;
  const range = new Promise((r) => d.once('libere', r));
  d._enfants.get(pid).mourir(139, null);
  await range;
  expect(d._tues).toEqual([]);
  expect(d._store.appels.slice(1)).toEqual([['attendreLibre', '/inst/vegeta-1'], ['snapshotRetour', 'vegeta', '/inst/vegeta-1.fini'], ['supprimerInstance', '/inst/vegeta-1.fini']]);
});

test('identité : serveur qui ne démarre pas => le dossier matérialisé est supprimé (rien ne traîne)', async () => {
  const d = faux({ attendre: async () => 'muet' });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  expect(rep.ok).toBe(false);
  expect(rep.erreur).toMatch(/silencieux/);
  expect(d._store.appels).toEqual([['materialiser', 'vegeta', 'vegeta-1', 'snapshot'], ['supprimerInstance', '/inst/vegeta-1']]);
});

// Browserbase : « Avoid having multiple sessions using the same Context at once. Sites may force a
// log out. » ⇒ on AVERTIT (nommé, crié), on n'interdit pas : la décision est à l'opérateur.
test('identité DÉJÀ tenue : une 2e instance démarre quand même, et l opérateur est AVERTI (jamais refusé)', async () => {
  const d = faux();
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  const b = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'));
  expect(b.rep.ok).toBe(true);
  expect(b.rep.instanceId).toBe('vegeta-2');
  expect(a.rep.url).not.toBe(b.rep.url);
  expect(d._alertes.length).toBe(1);
  expect(d._alertes[0]).toMatch(/"vegeta" déjà tenue par 1 instance/);
  expect(d._alertes[0]).toMatch(/déconnecter/);
});

// ⚠️ Deux clients de la MÊME identité au même instant : materialiser ne doit pas CHEVAUCHER un
// snapshotRetour de cette identité (rename en cours = dossier en mouvement). Sérialisé par identité.
test('identité : les opérations sur le coffre d une MÊME identité sont SÉRIALISÉES, identités différentes en parallèle', async () => {
  const journal = [];
  let enCours = 0, maxEnCours = 0;
  const store = fauxStore();
  store.materialiser = async (i) => {
    enCours++; maxEnCours = Math.max(maxEnCours, enCours);
    journal.push(`debut ${i.instanceId}`);
    await new Promise((r) => setTimeout(r, 20)); // simule une copie disque
    journal.push(`fin ${i.instanceId}`);
    enCours--;
    return `/inst/${i.instanceId}`;
  };
  const d = faux({ store });
  await d.demarrer();
  await Promise.all([client(d.nomCanal, 'vegeta', INSTANCE('vegeta')), client(d.nomCanal, 'vegeta', INSTANCE('vegeta'))]);
  expect(journal, 'la 2e copie de vegeta ne commence qu après la fin de la 1re').toEqual(['debut vegeta-1', 'fin vegeta-1', 'debut vegeta-2', 'fin vegeta-2']);
  journal.length = 0; maxEnCours = 0; enCours = 0;
  await Promise.all([client(d.nomCanal, 'perso', INSTANCE('perso')), client(d.nomCanal, 'job', INSTANCE('job'))]);
  expect(maxEnCours, 'deux identités DIFFÉRENTES se copient en parallèle').toBe(2);
});

// ═══ NŒUD DISTANT : canal TCP + jeton (05/09/2026) ═══
// Un client TCP : même protocole, même framing (la spec MCP le veut), un jeton en plus.
function clientTcp(port, profil, token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    socks.push(sock);
    let buf = '';
    sock.on('error', reject);
    sock.on('close', () => resolve({ sock, rep: null, ferme: true }));
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      resolve({ sock, rep: lireReponse(JSON.parse(buf.slice(0, nl))), ferme: false });
    });
    sock.write(JSON.stringify(requeteAcquire(profil, SPEC, null, token)) + '\n');
  });
}

test('TCP sans jeton = REFUSÉ au démarrage (un canal réseau sans jeton offrirait les navigateurs au réseau)', () => {
  expect(() => new ServerDaemon({ env: env(), listen: { host: '127.0.0.1', port: 0 }, spawnFn: () => ({ pid: 1, on() {}, once() {} }), tuer() {}, allouerPort: async () => 1, attendre: async () => 'pret' }))
    .toThrow(/sans jeton/);
});

test('TCP + jeton : bon jeton ⇒ instance servie ; mauvais ou absent ⇒ refus NOMMÉ et socket DÉTRUITE', async () => {
  const d = faux({ listen: { host: '127.0.0.1', port: 0 }, token: 'jeton-de-test' });
  expect(await d.demarrer()).toBe(true);
  const port = d._serveur.address().port;
  const ok = await clientTcp(port, 'vegeta', 'jeton-de-test');
  expect(ok.rep.ok).toBe(true);
  expect(ok.rep.url).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
  const mauvais = await clientTcp(port, 'vegeta', 'jeton-faux');
  expect(mauvais.rep?.ok ?? false).toBe(false);
  if (mauvais.rep) expect(mauvais.rep.erreur).toMatch(/jeton invalide ou absent/);
  const absent = await clientTcp(port, 'vegeta', null);
  expect(absent.rep?.ok ?? false).toBe(false);
  expect(d.etat().length, 'UNE seule instance : les refusés n ont rien obtenu').toBe(1);
});

test('tuyau local (pas de listen) : un jeton envoyé est IGNORÉ, l OS protège (aucune régression)', async () => {
  const d = faux();
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'vegeta');
  expect(rep.ok).toBe(true);
});

// ═══ maxBrowsers compte les INSTANCES (chaque instance = un navigateur) ═══
test('maxBrowsers : la limite compte les instances — même profil ou pas — et REFUSE sans rien évincer', async () => {
  const d = faux({ limite: 1 });
  await d.demarrer();
  const a = await client(d.nomCanal, 'vegeta');
  const b = await client(d.nomCanal, 'vegeta');
  expect(b.rep.ok).toBe(false);
  expect(b.rep.erreur).toMatch(/maxBrowsers=1 atteinte \(1 instances vivantes\)/);
  expect(d._tues, 'aucun navigateur existant touché').toEqual([]);
  expect(d.etat().length).toBe(1);
  await fermeEtAttend(d, a.sock);
  const c = await client(d.nomCanal, 'perso');
  expect(c.rep.ok, 'place libérée => acceptée').toBe(true);
});


// ═══ playwrightConfig ⇒ fichier --config ECRIT avant le spawn, a cote de l instance, SUPPRIME au rangement ═══
test('configuration : --config <dir>.config.json ecrit AVANT le spawn, supprime APRES le rangement', async () => {
  let argsVus = null;
  const enf = fauxEnfants(7000);
  const d = faux({ spawnFn: (cmd, args, opts) => { argsVus = args; return enf.spawnFn(cmd, args, opts); }, tuer: enf.tuer });
  await d.demarrer();
  const cfg = { browser: { contextOptions: { locale: 'fr-FR' } } };
  const { rep, sock } = await client(d.nomCanal, 'vegeta', INSTANCE('vegeta'), { configuration: cfg });
  expect(rep.instanceId).toBe('vegeta-1');
  const i = argsVus.indexOf('--config');
  expect(i, '--config passe au serveur').toBeGreaterThan(0);
  expect(argsVus[i + 1]).toBe('/inst/vegeta-1.config.json');
  expect(d._store.appels[1]).toEqual(['ecrireConfigInstance', '/inst/vegeta-1.config.json', cfg]);
  await fermeEtAttend(d, sock);
  expect(d._store.appels.at(-1)).toEqual(['supprimerConfigInstance', '/inst/vegeta-1.config.json']);
});

test('configuration sans identite (profil isole) : fichier dans le dossier d instances par defaut, sous l id', async () => {
  let argsVus = null;
  const enf = fauxEnfants(7100);
  const d = faux({ spawnFn: (cmd, args, opts) => { argsVus = args; return enf.spawnFn(cmd, args, opts); }, tuer: enf.tuer });
  await d.demarrer();
  const { rep } = await client(d.nomCanal, 'anon', null, { configuration: { timeouts: { action: 1000 } } });
  const i = argsVus.indexOf('--config');
  expect(i).toBeGreaterThan(0);
  expect(argsVus[i + 1].replace(/\\/g, '/').endsWith(`/pw-mcp-instances/${rep.instanceId}.config.json`)).toBe(true);
});
