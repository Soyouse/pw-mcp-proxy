// ACCEPTATION S5 & S6 — cycle de vie du serveur partagé (skill §COMPORTEMENT ATTENDU).
//
// ⚠️ CES TESTS SONT ÉCRITS EN TERMES DE COMPORTEMENT, JAMAIS DE MÉCANISME. C'est délibéré et
// c'est la condition pour qu'ils SURVIVENT au refactor (daemon/refcount) : ils doivent juger le
// nouveau système sans avoir été écrits pour l'ancien. Un test qui dit « le reaper a retiré
// l'entrée du registre » interdit de supprimer le reaper ; un test qui dit « le serveur s'est
// arrêté » reste vrai quel que soit QUI l'a arrêté.
//
// Tout le « comment » d'aujourd'hui est confiné dans `laisserConverger()` ci-dessous : c'est le
// SEUL endroit à toucher le jour où le daemon remplace heartbeat+TTL+reaper. Les deux `test()`
// eux-mêmes ne doivent PAS changer d'une ligne.
//
// S5 : un agent se termine  => les autres continuent SANS interruption
// S6 : le DERNIER client part => le serveur ET son navigateur s'arrêtent (zéro process qui traîne)

import { test, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.js';
import { isPidAlive } from '../src/prockill.js';
import { serverEntry } from '../src/server-registry.js';
import { taggedArgs } from './harness.js'; // ⚠️ marque les process spawnés par le CODE => ratchet anti-fuite

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-http-server.js');
const SPEC = { command: process.execPath, args: taggedArgs([FAKE]) };

let cfgPath;
const vivants = [];
let seq = 0;
const prof = () => `acc${process.pid}-${++seq}`; // nom UNIQUE par test (isolation de port)

// Horloge de test contrôlée : `os.uptime()` a une résolution d'UNE SECONDE sur macOS, un TTL de
// quelques ms n'y déclencherait jamais rien. On avance le temps EXPLICITEMENT.
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function newSup(opts) {
  const s = new Supervisor(cfgPath, { readyTimeoutMs: 6000, ...opts });
  vivants.push(s);
  return s;
}

// Le serveur répond-il VRAIMENT ? (question posée au noyau, jamais au registre : le registre est
// une trace, la connexion est un fait — et c'est le registre qui disparaîtra au refactor.)
// ⚠️ SE CONNECTER SUR `localhost`, JAMAIS `127.0.0.1` — invariant du projet, valable AUSSI dans
// les tests : le superviseur bind sur `--host localhost`, qui peut résoudre en `::1` (IPv6). Un
// test qui tape 127.0.0.1 mesure une interface où PERSONNE n'écoute et conclut « serveur mort ».
// Piège vécu ici même le 02/08 : les deux tests rouges au premier jet, pour cette seule raison.
function repond(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const fin = (v) => { sock.destroy(); resolve(v); };
    sock.on('connect', () => fin(true));
    sock.on('error', () => fin(false));
  });
}

/**
 * ⚠️ SEUL POINT DE COUPLAGE AU MÉCANISME ACTUEL — à réécrire au refactor, et RIEN D'AUTRE.
 *
 * « Laisser le système converger » signifie : le temps passe, et pendant ce temps les agents
 * ENCORE VIVANTS continuent de manifester leur présence. Aujourd'hui ça se traduit par
 * horloge + battements + passe de reaper ; avec le daemon, la seule fermeture de la dernière
 * connexion suffira et ce helper deviendra un no-op.
 *
 * ⚠️ Faire battre `actifs` n'est PAS une complaisance envers l'implémentation : c'est ce que fait
 * réellement leur `setInterval` de heartbeat. L'omettre simule des agents vivants mais MUETS —
 * un état qui n'existe pas en production, et qui ferait échouer le test pour une mauvaise raison
 * (piège vécu le 02/08 : S5 rouge deux fois de suite, le code avait raison à chaque fois).
 */
async function laisserConverger(observateur, clock, actifs = []) {
  clock.advance(10_000); // au-delà du ttl court des tests
  for (const a of actifs) await a._touch(a._heartbeats.keys().next().value);
  await observateur.reap();
}

/**
 * Un agent COMMENCE à utiliser un profil — exactement ce que fait `manager._makeTransport()`.
 * ⚠️ `ensureServer` NE SUFFIT PAS : il garantit que le serveur EXISTE ; c'est `registerClient` qui
 * déclare « JE m'en sers ». Les enchaîner est le contrat réel du manager. Un test qui n'appelle que
 * le premier décrit un agent FANTÔME — le serveur n'a alors aucun client, donc il est reapé à
 * raison, et le test accuse le code à tort (piège vécu le 02/08).
 */
async function agentUtilise(sup, profil) {
  const url = await sup.ensureServer(profil, SPEC);
  sup.registerClient(profil);
  return url;
}

beforeAll(() => { cfgPath = path.join(os.tmpdir(), `pw-mcp-acc-${process.pid}.json`); });
beforeEach(() => {
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});
afterAll(async () => {
  for (const s of vivants) { try { await s.shutdown(); } catch {} }
  const s = new Supervisor(cfgPath);
  try { fs.unlinkSync(s.registryPath); } catch {}
  try { fs.unlinkSync(s.lockPath); } catch {}
});

test('S5 : un agent se termine, les AUTRES continuent sans interruption', async () => {
  const p = prof();
  const clock = fakeClock();
  const agentA = newSup({ ttl: 5000, clock });
  const agentB = newSup({ ttl: 5000, clock });

  // Deux agents utilisent le même profil : le second ADOPTE le serveur du premier.
  const urlA = await agentUtilise(agentA, p);
  const urlB = await agentUtilise(agentB, p);
  expect(urlB, 'les deux agents parlent au MÊME serveur (jamais un 2e navigateur)').toBe(urlA);
  const u = new URL(urlA);
  const pid = serverEntry(agentA._read(), p).pid;

  // L'agent A s'en va (fin de session Claude, fermeture d'onglet, crash de sa fenêtre…).
  await agentA.shutdown();

  // ⚠️ On laisse le système converger : c'est PRÉCISÉMENT le moment où un reaper trop zélé
  // tuerait le serveur de B. B n'a rien demandé et ne doit RIEN subir.
  await laisserConverger(agentB, clock, [agentB]);

  expect(await repond(u.hostname, Number(u.port)), 'S5 VIOLÉ : le départ de A a coupé le navigateur de B').toBe(true);
  expect(isPidAlive(pid), 'le process du serveur est toujours vivant').toBe(true);

  // Et B doit pouvoir continuer à travailler : re-demander le profil ne respawn rien.
  const urlB2 = await agentUtilise(agentB, p);
  expect(urlB2, 'B retrouve SON serveur, aucun redémarrage').toBe(urlA);
}, 60000);

test('S6 : le DERNIER client parti, le serveur s arrête (zéro process qui traîne)', async () => {
  const p = prof();
  const clock = fakeClock();
  const agentA = newSup({ ttl: 5000, clock });
  const agentB = newSup({ ttl: 5000, clock });

  const url = await agentUtilise(agentA, p);
  await agentUtilise(agentB, p);
  const u = new URL(url);
  const pid = serverEntry(agentA._read(), p).pid;
  expect(await repond(u.hostname, Number(u.port)), 'préalable : le serveur répond').toBe(true);

  // Les DEUX agents s'en vont. Plus personne n'a besoin de ce profil.
  await agentA.shutdown();
  await agentB.shutdown();

  // Un 3e observateur déclenche la convergence (au refactor : plus personne n'aura à le faire).
  const observateur = newSup({ ttl: 5000, clock });
  await laisserConverger(observateur, clock, []); // plus AUCUN actif

  expect(isPidAlive(pid), 'S6 VIOLÉ : le serveur survit alors que plus AUCUN client ne l utilise — fuite de navigateur').toBe(false);
  expect(await repond(u.hostname, Number(u.port)), 'le port est libéré').toBe(false);
}, 60000);

// ⚠️ ANTI-RÉGRESSION « la charge n'est pas une panne » (refonte 02/08, objection de Théo).
// L'ancienne boucle de readiness sondait jusqu'à épuisement d'un chronomètre SANS jamais demander
// si le process vivait. Conséquences, toutes deux vécues le 02/08 :
//   - machine chargée (84 serveurs MCP en fond) => `node` lent à démarrer => déclaré CASSÉ ;
//   - process mort à la seconde => on attendait quand même le budget ENTIER pour rien.
// Le budget est désormais un FILET (cas indécidable : vivant mais muet), jamais un couperet.
// Modèle systemd `Type=notify` : le service SIGNALE, `TimeoutStartSec` n'est qu'un dernier recours.
test('READINESS : un process MORT est constaté IMMÉDIATEMENT, sans consommer le budget', async () => {
  const sup = newSup({ ttl: 5000 });
  const t0 = Date.now();
  // Budget volontairement ÉNORME : si le verdict attendait le chronomètre, ce test durerait 60 s.
  const verdict = await sup._pollReady(1, 60000, 999999); // pid inexistant => 'mort'
  const ecoule = Date.now() - t0;

  expect(verdict, 'le noyau SAIT que ce pid n existe pas — c est un FAIT, pas une supposition').toBe('mort');
  expect(ecoule, `constat immédiat attendu, ${ecoule}ms écoulés sur un budget de 60000`).toBeLessThan(5000);
}, 90000);

test('READINESS : un process VIVANT mais muet rend « muet » (indécidable), jamais « mort »', async () => {
  const sup = newSup({ ttl: 5000 });
  // NOTRE propre process : vivant, et n'écoute certainement pas sur le port 1.
  const verdict = await sup._pollReady(1, 700, process.pid);
  expect(verdict, 'vivant sans écouter = le seul cas réellement indécidable').toBe('muet');
}, 30000);
