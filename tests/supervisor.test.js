// Integration supervisor.js (I/O reel : spawn du faux serveur HTTP, verrou fichier, reap tree-kill).
// Prouve le cycle de vie MULTI-AGENT : un serveur partage par profil, adopte par les proxys suivants,
// garde tant qu'un client bat le coeur, reape (tue) quand plus personne.

import { test, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.js';
import { isPidAlive } from '../src/prockill.js';
import { serverEntry } from '../src/server-registry.js';
import { taggedArgs } from './harness.js'; // ⚠️ marque les serveurs spawnés par le CODE => ratchet anti-fuite
import { acquireLaunchChannel } from '../src/launch-channel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-http-server.js');
// Le SUPERVISEUR spawne ces serveurs (détachés, par design) ; taggedArgs y injecte le marqueur de suite
// pour que le ratchet du harnais les retrouve et échoue ROUGE si l'un survit (cause de la fuite 9639/9698).
const SPEC = { command: process.execPath, args: taggedArgs([FAKE]) };

let cfgPath;
const spawned = [];

function newSup(opts) {
  // ⚠️ Patience de readiness COURTE en test : borne le pire cas (SPAWN_ATTEMPTS x patience) bien sous
  // la limite du test. Un port filtre par la machine ne doit JAMAIS faire rougir la suite au hasard.
  const s = new Supervisor(cfgPath, { readyTimeoutMs: 6000, ...opts });
  spawned.push(s);
  return s;
}
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
function readReg(s) {
  try { return JSON.parse(fs.readFileSync(s.registryPath, 'utf8')); } catch { return { servers: {} }; }
}
// ⚠️ ISOLATION DE PORT : le port d'un profil est DÉTERMINISTE (derivePort, hash du nom). Réutiliser le
// MÊME nom de profil entre tests => MÊME port => un fixture agonisant (run précédent / test précédent)
// squatte le port au boot du suivant => _pollReady voit l'ancien répondre => pid mort enregistré (flake
// intermittent du 1er ensureServer). Un NOM UNIQUE par test => port unique => zéro collision (intra ET
// inter-run). NE JAMAIS revenir à un littéral de profil partagé dans un test qui spawn un serveur.
let profSeq = 0;
const prof = () => `sup${process.pid}-${++profSeq}`;

beforeAll(() => { cfgPath = path.join(os.tmpdir(), `pw-mcp-sup-${process.pid}.json`); });
beforeEach(() => {
  // registre/verrou propres a chaque test (isolation)
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});
afterAll(async () => {
  // Kill des serveurs DÉTACHÉS + assertion zéro survivant = garantis par le ratchet du harnais
  // (les serveurs portent le marqueur via taggedArgs). Ici : ref-count + fichiers temp seulement.
  for (const s of spawned) { try { await s.shutdown(); } catch {} }
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});

test('ensureServer : spawn un serveur, il repond, il est enregistre', async () => {
  const P = prof();
  const sup = newSup();
  const url = await sup.ensureServer(P, SPEC);
  expect(url).toMatch(/^http:\/\/localhost:\d+\/mcp$/); // URL client documentee (localhost)
  const entry = serverEntry(readReg(sup), P);
  expect(entry && isPidAlive(entry.pid), 'pid enregistre et vivant').toBeTruthy();
  expect(await sup._probeReady(entry.port), 'le serveur repond').toBe(true);
});

test('ensureServer : 2e appel (autre proxy) ADOPTE le meme serveur (zero 2e spawn)', async () => {
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const urlA = await a.ensureServer(P, SPEC);
  const pidA = serverEntry(readReg(a), P).pid;
  const urlB = await b.ensureServer(P, SPEC);
  const pidB = serverEntry(readReg(b), P).pid;
  expect(urlA, 'meme URL').toBe(urlB);
  expect(pidA, 'MEME serveur (pid inchange) : adoption, pas de 2e spawn').toBe(pidB);
});

test('ensureServer concurrent (2 proxys en parallele) => UN SEUL serveur', async () => {
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });
  const [u1, u2] = await Promise.all([a.ensureServer(P, SPEC), b.ensureServer(P, SPEC)]);
  expect(u1, 'course serialisee par le verrou : une seule URL').toBe(u2);
  const entry = serverEntry(readReg(a), P);
  expect(entry && isPidAlive(entry.pid)).toBeTruthy();
});

test('LANCEUR MORT + 2 proxys concurrents => UN SEUL serveur, sans aucun vol de verrou', async () => {
  // REMPLACE l'ancien test « verrou PERIME + vol serialise » (supprime avec le verrou fichier).
  // Ce scenario est celui qui a produit la panne de ~5 h du 31/07→01/08 : un detenteur disparu,
  // et des concurrents qui devaient DEVINER que le verrou etait mort pour le voler.
  //
  // ⚠️ Avec le canal nomme, la situation testee ici n'a plus d'equivalent « perime » : le noyau
  //    detruit le canal a la mort du processus, donc un detenteur fantome ne peut PAS exister.
  //    Il n'y a plus ni peremption, ni vol, ni meta-verrou — donc plus rien a serialiser a la main.
  //    Ce test prouve que la CLASSE DE PANNE a disparu, pas seulement que le bug est corrige.
  const P = prof();
  const a = newSup({ clientId: 'A' });
  const b = newSup({ clientId: 'B' });

  // Un lanceur precedent prend le canal puis MEURT (close = disparition du processus cote noyau).
  const zombie = await acquireLaunchChannel(P);
  expect(zombie.role).toBe('leader');
  zombie.close();

  // Les deux proxys foncent en meme temps sur un canal qui vient d'etre libere.
  const [u1, u2] = await Promise.all([a.ensureServer(P, SPEC), b.ensureServer(P, SPEC)]);
  expect(u1, 'course serialisee par le noyau : une seule URL').toBe(u2);
  const entry = serverEntry(readReg(a), P);
  expect(entry && isPidAlive(entry.pid), 'un seul serveur vivant enregistre').toBeTruthy();

  // ⚠️ Le VERROU FICHIER n'est plus touche du tout par ensureServer : sa seule absence de creation
  // est la preuve que le chemin de lancement ne repose plus dessus.
  expect(fs.existsSync(a.lockPath), 'plus aucun verrou fichier sur le chemin de lancement').toBe(false);
});

test('reap : serveur SANS client vivant (ttl court) est tue et retire', async () => {
  const P = prof();
  const sup = newSup({ ttl: 1, clientId: 'solo' }); // ttl=1ms => idle immediat
  await sup.ensureServer(P, SPEC);
  const entry = serverEntry(readReg(sup), P);
  await new Promise((r) => setTimeout(r, 20)); // depasse le ttl
  await sup.reap();
  expect(serverEntry(readReg(sup), P), 'retire du registre').toBe(null);
  expect(await waitFor(async () => !isPidAlive(entry.pid)), 'process tue (tree-kill)').toBeTruthy();
});

test('PID RECYCLE : le reap REFUSE de tuer un process qui n est plus le notre', async () => {
  // LA faille du 2026-08-01 (trouvee par simulation, degats HORS perimetre du projet) : un PID est
  // un numero reutilisable. Sur une machine qui tourne des semaines, celui d'un serveur mort est
  // reattribue — et `treeKill(entry.pid)` tuait alors le process de QUELQU'UN D'AUTRE.
  //
  // On reproduit exactement ca : un pid VIVANT dont l'identite enregistree ne correspond plus
  // (c'est la signature d'un recyclage). Le reap DOIT s'abstenir.
  const P = prof();
  const sup = newSup({ ttl: 1, clientId: 'recycle' }); // ttl=1ms => le reap voudra le tuer
  await sup.ensureServer(P, SPEC);
  const entry = serverEntry(readReg(sup), P);
  expect(isPidAlive(entry.pid), 'serveur bien demarre').toBe(true);

  // Le pid reste vivant, mais l'identite enregistree devient celle d'un AUTRE process.
  const reg = readReg(sup);
  reg.servers[P].identity = 'identite-d-un-process-disparu';
  fs.writeFileSync(sup.registryPath, JSON.stringify(reg));

  await new Promise((r) => setTimeout(r, 20)); // depasse le ttl : le reap le considere idle
  await sup.reap();

  expect(isPidAlive(entry.pid), 'process EPARGNE : absence de preuve = pas de kill').toBe(true);
});

test('reap : serveur AVEC heartbeat frais est GARDE', async () => {
  const P = prof();
  const sup = newSup({ ttl: 60000, clientId: 'live' });
  await sup.ensureServer(P, SPEC);
  const entry = serverEntry(readReg(sup), P);
  sup.registerClient(P); // heartbeat frais
  await sup.reap();
  // ⚠️ Si ROUGE ici avec pid mort : le fixture s'est auto-terminé (socket reset du probe non géré = crash).
  // Cf fake-http-server (handlers d'erreur socket). Le reap ne fait que constater un pid déjà mort.
  expect(serverEntry(readReg(sup), P), `garde dans le registre (pid=${entry.pid} alive=${isPidAlive(entry.pid)})`).toBeTruthy();
  expect(isPidAlive(entry.pid), 'toujours vivant').toBe(true);
  await sup.unregisterClient(P);
});

test('boot-reap : entree au pid MORT est purgee', async () => {
  const sup = newSup({ ttl: 60000 });
  // injecte une entree fantome (pid mort quasi-sur) directement dans le registre
  const dead = { servers: { ghost: { port: 9999, pid: 999999, spawnedAt: 0, clients: { x: Date.now() } } } };
  fs.writeFileSync(sup.registryPath, JSON.stringify(dead));
  await sup.reap();
  expect(serverEntry(readReg(sup), 'ghost'), 'entree morte retiree au boot-reap').toBe(null);
});

test('unregisterClient : retire mon heartbeat du registre', async () => {
  const P = prof();
  const sup = newSup({ ttl: 60000, clientId: 'me' });
  await sup.ensureServer(P, SPEC);
  sup.registerClient(P);
  expect(serverEntry(readReg(sup), P).clients.me, 'enregistre').toBeTruthy();
  await sup.unregisterClient(P);
  expect(serverEntry(readReg(sup), P).clients.me, 'retire').toBeUndefined();
});

// ⚠️ LE RISQUE ASSUME DE LA REFONTE « PORT ALLOUE PAR L'OS » (2026-07-31) — scelle ici.
// Avec l'ancien port CALCULE, un agent retrouvait le serveur meme si le registre disparaissait : il
// recalculait le meme numero. Ce filet-la n'existe plus (le port n'est plus devinable), donc la
// question posee — a juste titre — etait : « et si le registre est efface alors qu'un serveur tourne ? »
// Reponse EXIGEE, verifiee ici plutot qu'affirmee : le superviseur s'en sort SEUL, sans humain.
// (En prod, l'ancien serveur tenant un --user-data-dir est en plus reclame par le self-heal cible.)
test('registre EFFACE sous un serveur vivant => ensureServer se retablit SEUL (aucun blocage)', async () => {
  const P = prof();
  const sup = newSup();
  const url1 = await sup.ensureServer(P, SPEC);
  const pid1 = serverEntry(readReg(sup), P).pid;
  expect(isPidAlive(pid1), 'serveur #1 bien vivant').toBe(true);

  // Sabotage : le registre disparait (crash disque, nettoyage de /tmp, bug d'un tiers).
  fs.unlinkSync(sup.registryPath);
  expect(readReg(sup).servers, 'registre bien vide').toEqual({});

  // ⚠️ L'INVARIANT : un agent qui arrive apres le sinistre DOIT repartir. Un throw ici signifierait
  // qu'une machine se retrouve sans navigateur jusqu'a intervention humaine = exactement le 31/07.
  const url2 = await sup.ensureServer(P, SPEC);
  expect(url2).toMatch(/^http:\/\/localhost:\d+\/mcp$/);
  const e2 = serverEntry(readReg(sup), P);
  expect(e2 && isPidAlive(e2.pid), 'un serveur utilisable est de nouveau enregistre').toBeTruthy();
  expect(await sup._probeReady(e2.port), 'et il repond vraiment').toBe(true);
  // Le port peut differer (nouveau serveur) OU non (meme serveur re-adopte) : les DEUX sont corrects.
  // On n'assert donc PAS l'egalite des URLs — ce serait figer un detail d'implementation, pas l'invariant.
  expect(typeof url1).toBe('string');
});
