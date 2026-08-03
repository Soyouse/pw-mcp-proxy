// LE GARDIEN — son contrat, vérifié DIRECTEMENT (et non à travers le daemon).
//
// 🛑 POURQUOI CE FICHIER EXISTE, ET PAS SEULEMENT LE TEST « daemon tué à -9 » :
// ce dernier ne DISCRIMINE PAS sous Windows. Mesuré le 02/08 par negative-check — gardien retiré,
// il reste VERT : Windows place les enfants dans le JOB OBJECT du parent et les tue avec lui, donc
// l'orphelin ne s'y reproduit pas. L'orphelin est un problème **POSIX** (Linux/macOS), où rien
// n'est automatique. Un test qui ne peut pas rougir n'est pas une preuve, c'est une décoration.
// ⇒ ICI on teste le MÉCANISME lui-même — « EOF sur stdin ⇒ l'enfant meurt » — ce qui rougit sur
// TOUS les OS si le lien de vie casse. Le test « -9 » garde sa valeur en CI Linux/macOS (matrice
// 3 OS), là où il devient réellement discriminant.

import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnTracked } from './harness.js'; // ⚠️ SEUL moyen de spawner (marqueur + ratchet)
import { isPidAlive, listProcesses } from '../src/prockill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(__dirname, '..', 'src', 'child-guard.js');

/** Attend un FAIT, borné. La mort d'un process est asynchrone : on la MESURE, on ne la suppose pas. */
async function jusqua(cond, budgetMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > budgetMs) return false;
    await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
  }
}

/** Lance le gardien sur un enfant qui ne meurt JAMAIS seul (sinon le test se prouverait tout seul). */
function lancerGardien(marqueur) {
  const proc = spawnTracked([GUARD, process.execPath, '-e', `/*${marqueur}*/setInterval(()=>{},1000)`], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return proc;
}

const enfantDe = (marqueur) => listProcesses().filter((p) => p.cmd.includes(marqueur) && !p.cmd.includes('child-guard'));

test('CONTRAT : EOF sur stdin (= mort du parent) ⇒ le gardien TUE son enfant et sort', async () => {
  const marqueur = `guard${process.pid}a`;
  const g = lancerGardien(marqueur);

  expect(await jusqua(async () => enfantDe(marqueur).length > 0), 'préalable : l enfant tourne').toBe(true);

  // ⚠️ C'EST TOUT LE MÉCANISME : fermer le tuyau = ce que fait le NOYAU quand le parent meurt,
  // quelle que soit la cause (kill -9, OOM, coupure). Aucun message, aucun signal applicatif.
  g.stdin.destroy();

  expect(await jusqua(async () => enfantDe(marqueur).length === 0),
    'LIEN DE VIE ROMPU : l enfant a survécu à la fermeture du tuyau').toBe(true);
  expect(await jusqua(async () => !isPidAlive(g.pid)), 'le gardien sort aussi (il n a plus d objet)').toBe(true);
}, 40000);

test('SYMÉTRIE : l enfant meurt de lui-même ⇒ le gardien sort (jamais un process qui traîne)', async () => {
  // L'enfant sort tout seul : le gardien n'a plus rien à garder. S'il restait, le daemon croirait
  // le serveur vivant (il surveille le pid du GARDIEN) — un mensonge dont personne ne sortirait.
  const g = spawnTracked([GUARD, process.execPath, '-e', 'process.exit(0)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  expect(await jusqua(async () => !isPidAlive(g.pid)), 'le gardien doit suivre son enfant dans la mort').toBe(true);
}, 40000);

test('commande INLANÇABLE : le gardien SORT, il ne reste jamais un process qui ne garde rien', async () => {
  // ⚠️ `spawnTracked` ajoute TOUJOURS son marqueur en argv (harnais) : le gardien reçoit donc ici
  // une « commande » inlançable plutôt qu'aucune. C'est le cas le plus utile de toute façon —
  // l'invariant qui compte n'est pas le NUMÉRO de sortie, c'est qu'il ne survive pas à vide.
  const g = spawnTracked([GUARD], { stdio: ['pipe', 'ignore', 'ignore'] });
  const code = await new Promise((r) => g.on('exit', r));
  expect(code, 'sortie NON NULLE : l échec est visible, jamais avalé').not.toBe(0);
  expect(isPidAlive(g.pid), 'aucun process fantôme derrière').toBe(false);
}, 20000);

// 🛑 FUITE DE DESCRIPTEUR — la seule facon dont ce mecanisme peut mourir en silence.
// L'EOF n'arrive QUE si personne d'autre ne detient l'extremite d'ECRITURE du stdin du gardien.
// Si un descripteur fuit (enfant lance en 'inherit', ou pipe partage entre deux gardiens), l'EOF
// n'arrive JAMAIS et l'orphelin revient — sans le moindre message d'erreur.
// Ce test lance DEUX gardiens depuis le MEME process : si les tuyaux fuitaient de l'un a l'autre,
// fermer le premier ne suffirait pas, ou fermer les deux n'en tuerait qu'un.
test('DEUX gardiens : chaque tuyau est INDEPENDANT (aucune fuite de descripteur)', async () => {
  const m1 = `guard${process.pid}b1`;
  const m2 = `guard${process.pid}b2`;
  const g1 = lancerGardien(m1);
  const g2 = lancerGardien(m2);
  expect(await jusqua(async () => enfantDe(m1).length > 0 && enfantDe(m2).length > 0),
    'préalable : les deux enfants tournent').toBe(true);

  // On ne ferme QUE le premier tuyau.
  g1.stdin.destroy();
  expect(await jusqua(async () => enfantDe(m1).length === 0), 'l enfant 1 doit tomber').toBe(true);
  expect(enfantDe(m2).length, "l enfant 2 ne doit RIEN subir : les tuyaux sont independants").toBeGreaterThan(0);

  // Puis le second : il doit tomber AUSSI (donc son EOF n était pas retenu par le premier).
  g2.stdin.destroy();
  expect(await jusqua(async () => enfantDe(m2).length === 0),
    'FUITE DE DESCRIPTEUR : l enfant 2 n a jamais recu son EOF').toBe(true);
}, 60000);

// GATE STATIQUE — DEUX invariants opposés, et il faut les DEUX (03/08/2026).
//
// 🛑 CE GATE EXIGEAIT L'INVERSE DE CE QU'IL FALLAIT, ET C'EST LA LEÇON. Il imposait
// `stdio:'ignore'` GLOBAL, en croyant protéger le lien de vie. Or ce lien tient à **fd 0 seul** :
// fd 1 et 2 sont des extrémités d'ÉCRITURE que le gardien CRÉE, elles ne peuvent structurellement
// pas retenir l'EOF de son propre stdin. Le gate ne protégeait donc rien de plus qu'un
// `stdio[0]='ignore'` — mais il SCELLAIT en prime la perte de toute la sortie du serveur, c'est-à-dire
// la panne muette n°1 du projet. ⚠️ Un gate trop LARGE ne se contente pas d'être imprécis : il rend
// le défaut qu'il couvre par accident **impossible à corriger sans passer pour une régression**.
// Un garde-fou se pose sur la cause EXACTE, jamais sur une sur-approximation « pour être sûr ».
function optionsDuSpawn() {
  const src = readFileSync(new URL('../src/child-guard.js', import.meta.url), 'utf8');
  return /spawn\(command, args, \{([^}]*)\}/.exec(src)?.[1] || '';
}
/** Le `stdio: [...]` du spawn, découpé en ses 3 positions. */
function positionsStdio(opts) {
  const tableau = /stdio:\s*\[([^\]]*)\]/.exec(opts)?.[1];
  return tableau ? tableau.split(',').map((s) => s.trim().replace(/['"]/g, '')) : null;
}

test('GATE : fd 0 reste ignore — le LIEN DE VIE ne fuit vers aucun enfant', () => {
  const opts = optionsDuSpawn();
  expect(opts, 'le spawn de l enfant doit être trouvable').not.toBe('');
  const fds = positionsStdio(opts);
  expect(fds, "stdio DOIT être un tableau [fd0, fd1, fd2] — un raccourci global masque la position 0").not.toBe(null);
  expect(fds?.[0], "fd 0 = 'ignore' OBLIGATOIRE : 'inherit'/'pipe' feraient hériter le tuyau de vie ⇒ EOF jamais reçu ⇒ orphelin SILENCIEUX")
    .toBe('ignore');
});

test('GATE : fd 1 et 2 sont CAPTURÉS — jeter la sortie du serveur = la panne muette n°1', () => {
  // 🛑 Le serveur gardé est `@playwright/mcp` : Chrome vautré, profil verrouillé, veille qui casse
  // la session — la cause EXACTE est écrite par LUI, sur ses flux. Les jeter ne laisse que
  // « serveur MORT (code=1) », qui n'est pas un diagnostic. Le mode stdio les capturait déjà ;
  // c'est le mode HTTP — LA PRODUCTION — qui les perdait, d'où l'invisibilité pendant tout le projet.
  const fds = positionsStdio(optionsDuSpawn());
  expect(fds?.[1], "fd 1 jeté : la sortie du serveur doit être relayée au journal").not.toBe('ignore');
  expect(fds?.[2], "fd 2 jeté : l ERREUR du serveur doit être relayée au journal").not.toBe('ignore');
  // Et elle doit finir DANS LE JOURNAL, pas simplement être lue puis perdue.
  const src = readFileSync(new URL('../src/child-guard.js', import.meta.url), 'utf8');
  expect(src, 'les flux doivent être relayés vers log()').toMatch(/log\(`\[serveur:/);
});

// NEGATIVE-CHECK — les deux règles doivent RESTER capables de rougir.
test('NEGATIVE-CHECK : les formes fautives sont bien détectées par les deux gates', () => {
  expect(positionsStdio("stdio: 'ignore', windowsHide: true"), "le raccourci global doit être REFUSÉ (aucune position lisible)").toBe(null);
  expect(positionsStdio("stdio: ['pipe', 'pipe', 'pipe']")?.[0], 'fd0 pipe = fuite du lien de vie').toBe('pipe');
  expect(positionsStdio("stdio: ['ignore', 'ignore', 'ignore']")?.[2], 'fd2 ignore = sortie jetée').toBe('ignore');
  // Et la forme CORRECTE passe les deux règles — sinon le gate serait un mur qu'on contournerait.
  const bon = positionsStdio("stdio: ['ignore', 'pipe', 'pipe']");
  expect(bon?.[0]).toBe('ignore');
  expect(bon?.[1]).not.toBe('ignore');
  expect(bon?.[2]).not.toBe('ignore');
});

// ⚠️ ANTI-RÉGRESSION D'OBSERVABILITÉ — le gate statique ci-dessus ne prouve que la FORME du spawn.
// Ici on prouve le FAIT : ce que le serveur écrit atterrit réellement dans le journal.
test('OBSERVABILITÉ : ce que le serveur écrit sur stderr ARRIVE dans le journal', async () => {
  const marqueur = `guardout${process.pid}`;
  const journal = path.join(os.tmpdir(), `pw-mcp-test-${marqueur}.log`);
  const cri = `CHROME-A-EXPLOSE-${marqueur}`;
  // Un « serveur » qui crie sa cause sur stderr puis reste vivant : exactement ce que fait
  // `@playwright/mcp` quand son navigateur refuse de démarrer.
  const g = spawnTracked(
    [GUARD, process.execPath, '-e', `/*${marqueur}*/console.error(${JSON.stringify(cri)});setInterval(()=>{},1000)`],
    { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, PW_MCP_LOG: journal } },
  );

  const lu = () => { try { return readFileSync(journal, 'utf8'); } catch { return ''; } };
  expect(await jusqua(async () => lu().includes(cri)),
    "LA CAUSE EST PERDUE : le serveur a écrit sur stderr et le journal ne le sait pas").toBe(true);
  expect(lu(), 'la ligne doit être attribuable au serveur (une chronologie mêle 3 écrivains)')
    .toMatch(/\[serveur:err\]/);

  g.stdin.destroy();
  expect(await jusqua(async () => !isPidAlive(g.pid)), 'le gardien sort après EOF').toBe(true);
  try { unlinkSync(journal); } catch { /* nettoyage best-effort */ }
}, 40000);

// ⚠️ ANTI-RÉGRESSION D'OBSERVABILITÉ (posé le 03/08/2026, après audit du système de log).
//
// 🛑 LE GARDIEN ÉTAIT TOTALEMENT MUET. Il tuait un serveur — l'action de sécurité la plus
// importante du design — sans laisser la moindre trace, NULLE PART. Et personne ne pouvait la
// laisser à sa place : le daemon qui aurait pu la journaliser est justement celui qui vient de
// mourir. Symptôme utilisateur possible : « mon navigateur s'est fermé tout seul », indiagnosticable.
//
// ⚠️ CE TEST VÉRIFIE LE FICHIER, PAS stderr — et ce n'est pas un détail : le daemon lance le
// gardien en `stdio[1,2]='ignore'`, donc tout `stderr.write` part au néant. Écrire dans le fichier
// est la SEULE façon pour lui de laisser une trace. Un test sur stderr passerait au vert tout en
// prouvant l'inverse de ce qui compte.
// ⚠️ `PW_MCP_LOG` INJECTÉ vers un fichier jetable : ne JAMAIS écrire dans le log de PROD depuis un
// test (il est partagé avec les proxys réels de l'utilisateur, et la rotation est multi-écrivains).
test('OBSERVABILITÉ : le gardien ÉCRIT pourquoi il a tué (sinon l incident est muet)', async () => {
  const marqueur = `guardlog${process.pid}`;
  const journal = path.join(os.tmpdir(), `pw-mcp-test-${marqueur}.log`);
  const g = spawnTracked([GUARD, process.execPath, '-e', `/*${marqueur}*/setInterval(()=>{},1000)`], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, PW_MCP_LOG: journal },
  });

  expect(await jusqua(async () => enfantDe(marqueur).length > 0), 'préalable : l enfant tourne').toBe(true);
  g.stdin.destroy(); // = ce que fait le noyau à la mort du daemon
  expect(await jusqua(async () => enfantDe(marqueur).length === 0), 'préalable : l enfant est tué').toBe(true);

  const lu = () => { try { return readFileSync(journal, 'utf8'); } catch { return ''; } };
  expect(await jusqua(async () => /\[gardien\]/.test(lu())), 'le gardien DOIT écrire une ligne').toBe(true);

  const trace = lu();
  // La trace doit dire POURQUOI — un « [gardien] quelque chose » ne vaudrait rien en incident.
  expect(trace, 'la trace doit NOMMER la cause (mort du parent)').toMatch(/parent/i);
  expect(trace, 'la trace doit porter le pid du serveur arrêté').toMatch(/pid=\d+/);

  try { unlinkSync(journal); } catch { /* nettoyage best-effort */ }
}, 40000);
