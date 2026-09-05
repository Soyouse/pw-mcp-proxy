// ACCEPTATION S5 & S6 — cycle de vie du serveur partagé (skill §COMPORTEMENT ATTENDU).
//
// ⚠️ CES TESTS SONT ÉCRITS EN TERMES DE COMPORTEMENT, JAMAIS DE MÉCANISME. C'est ce qui leur a
// permis de SURVIVRE au refactor : écrits contre le superviseur (registre + heartbeat + TTL +
// reaper), ils jugent aujourd'hui le daemon sans avoir été écrits pour lui. Un test qui aurait dit
// « le reaper a retiré l'entrée du registre » aurait interdit de supprimer le reaper.
//
// PORTÉ AU DAEMON le 02/08 : seuls les HELPERS ci-dessous ont changé — « un agent utilise un
// profil » et « un agent s'en va » — plus les deux tests de readiness, qui appellent désormais la
// source unique `readiness.js`. Les assertions de S5 et S6 sont MOT POUR MOT les mêmes.
// `laisserConverger()` a disparu : c'était le prix de l'ancien mécanisme (avancer une horloge,
// faire battre les vivants, déclencher une passe de reaper). Avec le refcount du noyau, la
// fermeture de la dernière connexion SUFFIT — il n'y a plus rien à faire converger.
//
// S5 : un agent se termine  => les autres continuent SANS interruption
// S6 : le DERNIER client part => le serveur ET son navigateur s'arrêtent (zéro process qui traîne)

import { test, afterEach, expect } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive, listProcesses } from '../src/prockill.js';
import { acquerirProfil } from '../src/daemon-client.js';
import { attendreReady } from '../src/readiness.js'; // SOURCE UNIQUE de la readiness
import { taggedArgs } from './harness.js'; // ⚠️ marque les process spawnés par le CODE => ratchet anti-fuite

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fixtures', 'fake-http-server.js');
const SPEC = { command: process.execPath, args: taggedArgs([FAKE]) };

const agents = [];
let seq = 0;
const prof = () => `acc${process.pid}-${++seq}`; // nom UNIQUE par test (isolation de port)

// Le serveur répond-il VRAIMENT ? (question posée au noyau, jamais à un registre : un registre est
// une trace, la connexion est un fait — et c'est bien le registre qui a disparu.)
// ⚠️ SE CONNECTER SUR `localhost`, JAMAIS `127.0.0.1` — invariant du projet, valable AUSSI dans
// les tests : le serveur bind sur `--host localhost`, qui peut résoudre en `::1` (IPv6). Un test
// qui tape 127.0.0.1 mesure une interface où PERSONNE n'écoute et conclut « serveur mort ».
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
 * Attend qu'un FAIT devienne vrai, en le RE-MESURANT (jamais un délai fixe « au cas où »).
 * ⚠️ Nécessaire parce que le daemon est un AUTRE PROCESS : la fermeture de notre socket lui est
 * notifiée par le noyau, et rien ici ne peut observer cet instant. C'est le seul point du fichier
 * où le temps intervient, et c'est une BORNE d'échec, jamais une attente consommée en entier.
 */
async function jusqua(condition, budgetMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
  }
}

/** Le pid du serveur qui sert ce port — observé sur le PROCESS, jamais lu dans un fichier d'état. */
function pidDuPort(port) {
  return listProcesses().find((p) => p.cmd.includes(`--port ${port}`))?.pid;
}

function nouvelAgent() {
  const a = { connexions: new Map() };
  agents.push(a);
  return a;
}

/**
 * Un agent COMMENCE à utiliser un profil — exactement ce que fait `manager._makeTransport()`.
 * ⚠️ La connexion rendue EST la déclaration « JE m'en sers » : la garder ouverte est le contrat.
 * Auparavant il fallait DEUX appels (`ensureServer` + `registerClient`) et en oublier un décrivait
 * un agent FANTÔME dont le serveur était reapé à raison (piège vécu le 02/08). Ce piège n'existe
 * plus : il n'y a qu'un seul geste, et c'est le noyau qui le compte.
 */
async function agentUtilise(agent, profil) {
  const { url, connexion } = await acquerirProfil(profil, SPEC, {});
  const precedente = agent.connexions.get(profil);
  agent.connexions.set(profil, connexion);
  if (precedente) precedente.destroy(); // acquérir AVANT de lâcher : jamais de trou de refcount
  return url;
}

/** L'agent s'en va (fin de session Claude, fenêtre fermée, crash…). Ses sockets tombent. */
function agentPart(agent) {
  for (const c of agent.connexions.values()) { try { c.destroy(); } catch {} }
  agent.connexions.clear();
}

afterEach(() => { for (const a of agents.splice(0)) agentPart(a); });

test('S5 : un agent se termine, les AUTRES continuent sans interruption', async () => {
  const p = prof();
  const agentA = nouvelAgent();
  const agentB = nouvelAgent();

  // Deux agents utilisent le même profil : depuis le 05/09/2026 chacun a SON instance (mesuré
  // le 04/09 : un serveur partagé fait qu'un agent écrase la page de l'autre).
  const urlA = await agentUtilise(agentA, p);
  const urlB = await agentUtilise(agentB, p);
  expect(urlB, 'deux agents = deux serveurs (jamais le même onglet)').not.toBe(urlA);
  const uA = new URL(urlA);
  const uB = new URL(urlB);
  const pidA = pidDuPort(uA.port);
  const pidB = pidDuPort(uB.port);
  expect(pidA && pidB, 'préalable : un process sert bien chaque port').toBeTruthy();

  // L'agent A s'en va (fin de session Claude, fermeture d'onglet, crash de sa fenêtre…).
  agentPart(agentA);
  // Son instance est rangée : le daemon tue SON serveur (fait du noyau, on le constate).
  expect(await jusqua(async () => !isPidAlive(pidA)), 'le serveur de A est arrêté').toBe(true);

  // ⚠️ C'est PRÉCISÉMENT le moment où un mécanisme trop zélé tuerait le serveur de B.
  // B n'a rien demandé et ne doit RIEN subir.
  expect(await repond(uB.hostname, Number(uB.port)), 'S5 VIOLÉ : le départ de A a coupé le navigateur de B').toBe(true);
  expect(isPidAlive(pidB), 'le process du serveur de B est toujours vivant').toBe(true);
}, 60000);

test('S6 : le DERNIER client parti, le serveur s arrête (zéro process qui traîne)', async () => {
  const p = prof();
  const agentA = nouvelAgent();
  const agentB = nouvelAgent();

  const urlA = await agentUtilise(agentA, p);
  const urlB = await agentUtilise(agentB, p);
  const uA = new URL(urlA);
  const uB = new URL(urlB);
  const pidA = pidDuPort(uA.port);
  const pidB = pidDuPort(uB.port);
  expect(await repond(uA.hostname, Number(uA.port)), 'préalable : le serveur de A répond').toBe(true);
  expect(await repond(uB.hostname, Number(uB.port)), 'préalable : le serveur de B répond').toBe(true);

  // Les DEUX agents s'en vont. Plus personne n'a besoin de ce profil.
  agentPart(agentA);
  agentPart(agentB);

  // ⚠️ Aucun tiers n'a rien à déclencher : plus de reaper, plus de passe, plus d'horloge à avancer.
  // On attend seulement que le daemon reçoive du noyau la fermeture de chaque socket.
  const arreteA = await jusqua(async () => !isPidAlive(pidA));
  const arreteB = await jusqua(async () => !isPidAlive(pidB));
  expect(arreteA && arreteB, 'S6 VIOLÉ : un serveur survit alors que plus AUCUN client ne l utilise — fuite de navigateur').toBe(true);
  // ⚠️ Le port se libère APRÈS la mort du process (le noyau démonte la socket d'écoute), pas au
  // même instant. On RE-MESURE, borné : une vraie fuite resterait donc ROUGE au bout du budget.
  const libereA = await jusqua(async () => !(await repond(uA.hostname, Number(uA.port))));
  const libereB = await jusqua(async () => !(await repond(uB.hostname, Number(uB.port))));
  expect(libereA && libereB, 'les ports sont libérés').toBe(true);
}, 60000);

// ⚠️ ANTI-RÉGRESSION « la charge n'est pas une panne » (refonte 02/08, objection de Théo).
// L'ancienne boucle de readiness sondait jusqu'à épuisement d'un chronomètre SANS jamais demander
// si le process vivait. Conséquences, toutes deux vécues le 02/08 :
//   - machine chargée (84 serveurs MCP en fond) => `node` lent à démarrer => déclaré CASSÉ ;
//   - process mort à la seconde => on attendait quand même le budget ENTIER pour rien.
// Le budget est désormais un FILET (cas indécidable : vivant mais muet), jamais un couperet.
// Modèle systemd `Type=notify` : le service SIGNALE, `TimeoutStartSec` n'est qu'un dernier recours.
test('READINESS : un process MORT est constaté IMMÉDIATEMENT, sans consommer le budget', async () => {
  const t0 = Date.now();
  // Budget volontairement ÉNORME : si le verdict attendait le chronomètre, ce test durerait 60 s.
  const verdict = await attendreReady(1, { budgetMs: 60000, pid: 999999 });
  const ecoule = Date.now() - t0;

  expect(verdict, 'le noyau SAIT que ce pid n existe pas — c est un FAIT, pas une supposition').toBe('mort');
  expect(ecoule, `constat immédiat attendu, ${ecoule}ms écoulés sur un budget de 60000`).toBeLessThan(5000);
}, 90000);

test('READINESS : un process VIVANT mais muet rend « muet » (indécidable), jamais « mort »', async () => {
  // NOTRE propre process : vivant, et n'écoute certainement pas sur le port 1.
  const verdict = await attendreReady(1, { budgetMs: 700, pid: process.pid });
  expect(verdict, 'vivant sans écouter = le seul cas réellement indécidable').toBe('muet');
}, 30000);
