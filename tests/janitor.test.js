// LE CONCIERGE — la brique qui remplace le geste humain (posée le 03/08/2026).
//
// 🛑 CE QU'ON TESTE VRAIMENT ICI, ce n'est pas « ça nettoie » : c'est **ça ne nettoie JAMAIS chez
// les autres**. Un concierge trop zélé est infiniment pire que pas de concierge — il fermerait le
// Chrome PERSONNEL de l'utilisateur, ou le serveur d'un agent en plein travail (régression
// P0-inverse, déjà vécue avec le boot-sweep large). Les tests négatifs ci-dessous comptent donc
// plus que les positifs, et c'est volontaire.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { victimesConcierge } from '../src/janitor-pure.js';
import { daemonVivant } from '../src/janitor.js';
import { planInstallation } from '../src/janitor-main.js';

const UDD = ['C:/Users/theo/.pw-profiles/vegeta', '/home/theo/.pw-profiles/perso'];
const p = (pid, cmd) => ({ pid, cmd });

// ── LA GARDE PRINCIPALE ───────────────────────────────────────────────────────────────────────
test('🛑 DAEMON VIVANT ⇒ ZÉRO victime, quoi qu il y ait sur la machine', () => {
  const machine = [
    p(1, 'node child-guard.js npx @playwright/mcp --user-data-dir C:/Users/theo/.pw-profiles/vegeta'),
    p(2, 'chrome.exe --user-data-dir=C:/Users/theo/.pw-profiles/vegeta'),
  ];
  expect(victimesConcierge({ daemonVivant: true, processus: machine, uddNeedles: UDD }),
    "un daemon vivant peut être le propriétaire LÉGITIME de tout ça : sans le lien de parenté " +
    "(illisible de façon portable), tuer serait une action destructive derrière une INFÉRENCE").toEqual([]);
});

test('daemon MORT ⇒ nos serveurs et nos gardiens n ont plus AUCUN propriétaire possible', () => {
  const machine = [
    p(1, 'node child-guard.js npx @playwright/mcp --port 123'),
    p(2, 'chrome.exe --user-data-dir=C:/Users/theo/.pw-profiles/vegeta --type=renderer'),
    p(3, 'node /home/theo/proj/src/child-guard.js'),
  ];
  expect(victimesConcierge({ daemonVivant: false, processus: machine, uddNeedles: UDD })).toEqual([1, 2, 3]);
});

// ── CE QU'IL NE DOIT JAMAIS TOUCHER ───────────────────────────────────────────────────────────
test('🛑 le Chrome PERSONNEL n est JAMAIS touché, même daemon mort', () => {
  const perso = [
    p(10, 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    p(11, 'chrome.exe --user-data-dir=C:/Users/theo/AppData/Local/Google/Chrome/User Data'),
    p(12, '/usr/bin/firefox'),
    p(13, 'node server.js'), // un projet Node quelconque de l utilisateur
    p(14, 'npx some-other-mcp'),
  ];
  expect(victimesConcierge({ daemonVivant: false, processus: perso, uddNeedles: UDD }),
    "AUCUN de ces process ne porte un de NOS user-data-dir ni notre gardien : ils ne sont pas à nous, " +
    "on n a rien à en faire. C est la seule faute du projet dont les dégâts sortiraient de son périmètre.")
    .toEqual([]);
});

test('sans user-data-dir connu (config illisible) ⇒ SEULS nos propres gardiens sont visés', () => {
  const machine = [p(1, 'chrome.exe --user-data-dir=C:/Users/theo/.pw-profiles/vegeta'), p(2, 'node child-guard.js x')];
  expect(victimesConcierge({ daemonVivant: false, processus: machine, uddNeedles: [] }),
    'une config perdue ne doit pas élargir la cible — elle doit la RÉTRÉCIR').toEqual([2]);
});

test('le concierge ne se tue jamais lui-même', () => {
  const machine = [p(42, 'node janitor-main.js child-guard.js')];
  expect(victimesConcierge({ daemonVivant: false, processus: machine, uddNeedles: UDD, selfPid: 42 })).toEqual([]);
});

test('cross-OS : un needle en / matche une cmdline en \\ (et réciproquement)', () => {
  // ⚠️ Chrome écrit `--user-data-dir=C:/…` mais son crashpad-handler enfant écrit `C:\…`.
  // Sans normalisation, le crashpad survivrait et garderait le lock — le bug d origine du dépôt.
  const machine = [p(1, 'crashpad_handler --database=C:\\Users\\theo\\.pw-profiles\\vegeta\\Crashpad')];
  expect(victimesConcierge({ daemonVivant: false, processus: machine, uddNeedles: UDD })).toEqual([1]);
});

// ── ENTRÉES MALFORMÉES — révélées par la MUTATION (78 % → tous ces cas étaient AVEUGLES) ──────
//
// 🛑 CHAQUE `test()` CI-DESSOUS TUE UN MUTANT QUI A SURVÉCU LE 03/08. Ce ne sont pas des cas
// « théoriques » : `victimesConcierge` est appelée avec des faits venant d'une énumération de
// process de l'OS et d'un `profiles.json` édité à la main. Un champ absent, une entrée nulle, un
// pid non numérique — tout ça ARRIVE. Et comme la fonction décide de TUER, chaque défaut d'entrée
// non couvert est un défaut sur un chemin destructeur.

test('AUCUN fait fourni ⇒ INACTION (fails-closed jusque dans la signature)', () => {
  // ⚠️ Mutant `daemonVivant = true` → `false` : un appel malformé DÉCLENCHERAIT le balayage.
  // C'est le pire mutant possible sur ce fichier, et rien ne le tuait.
  expect(victimesConcierge()).toEqual([]);
  expect(victimesConcierge({})).toEqual([]);
  expect(victimesConcierge(null)).toEqual([]);

  // 🛑 LE CAS QUI COMPTE VRAIMENT, et que les trois lignes ci-dessus NE COUVRENT PAS : des process
  // sont fournis, mais `daemonVivant` est OMIS. Avec une liste vide, la valeur par défaut est
  // indétectable (le résultat vaut `[]` dans les deux cas) — la mutation l'a prouvé en survivant.
  // Ici, si le défaut basculait à `false`, on BALAIERAIT sur un appel incomplet.
  const machine = [p(1, 'node child-guard.js'), p(2, 'chrome --user-data-dir=C:/Users/theo/.pw-profiles/vegeta')];
  expect(victimesConcierge({ processus: machine, uddNeedles: UDD }),
    "`daemonVivant` OMIS doit valoir VIVANT (donc inaction) : un appel incomplet ne doit JAMAIS " +
    "autoriser un balayage. C'est le fails-closed porté par la signature elle-même.").toEqual([]);
});

test('champs ABSENTS ou null ⇒ listes vides, jamais une cible inventée', () => {
  // ⚠️ Mutants `processus = []` / `uddNeedles = []` → `["Stryker was here"]` : un défaut de valeur
  // par défaut ferait naître une aiguille FANTÔME, donc potentiellement une victime étrangère.
  expect(victimesConcierge({ daemonVivant: false })).toEqual([]);
  expect(victimesConcierge({ daemonVivant: false, processus: null, uddNeedles: null })).toEqual([]);
  expect(victimesConcierge({ daemonVivant: false, uddNeedles: UDD })).toEqual([]);
});

test('aiguilles VIDES filtrées — sinon une chaîne vide matcherait TOUT process', () => {
  // 🛑 LE MUTANT LE PLUS DANGEREUX DU FICHIER : retirer `.filter(Boolean)`. Une entrée vide dans
  // `userDataDir` (champ oublié dans profiles.json) donnerait `''`, et `c.includes('')` est
  // TOUJOURS vrai ⇒ **tous les process de la machine deviendraient des victimes**.
  const machine = [p(1, 'C:/Program Files/Google/Chrome/Application/chrome.exe'), p(2, '/usr/bin/firefox')];
  expect(victimesConcierge({ daemonVivant: false, processus: machine, uddNeedles: ['', null, undefined] }),
    "une aiguille vide ne doit JAMAIS matcher — ce serait un massacre silencieux").toEqual([]);
});

test('entrées de process INVALIDES ignorées (null, pid non numérique)', () => {
  // ⚠️ Mutants sur `!p` et `typeof p.pid !== 'number'` : sans ces gardes, une énumération partielle
  // de l'OS ferait THROW la fonction — or elle DOIT être totale (un concierge qui tombe laisse la
  // machine sale sans le dire).
  const sales = [null, undefined, { cmd: 'child-guard.js' }, { pid: 'abc', cmd: 'child-guard.js' }, p(7, 'node child-guard.js')];
  expect(victimesConcierge({ daemonVivant: false, processus: sales, uddNeedles: UDD }),
    'seule l entrée BIEN FORMÉE est retenue').toEqual([7]);
});

test('PID DUPLIQUÉ ⇒ une seule victime (on ne tue jamais deux fois le même process)', () => {
  // ⚠️ Mutant sur `vus.has(p.pid)` : la déduplication existait sans qu'AUCUN test ne l'exerce.
  // Un `treeKill` rejoué sur un pid déjà mort peut viser un pid RÉATTRIBUÉ entre-temps — donc un
  // process ÉTRANGER. La dédup n'est pas de l'hygiène, c'est une protection.
  const doublons = [p(5, 'node child-guard.js a'), p(5, 'node child-guard.js a'), p(6, 'chrome --user-data-dir=C:/Users/theo/.pw-profiles/vegeta')];
  expect(victimesConcierge({ daemonVivant: false, processus: doublons, uddNeedles: UDD })).toEqual([5, 6]);
});

// ── PROPRIÉTÉS (invariants forts, pas des exemples) ───────────────────────────────────────────
test('PROPRIÉTÉ : daemon vivant ⇒ ensemble de victimes VIDE, pour toute machine imaginable', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ pid: fc.integer({ min: 1, max: 99999 }), cmd: fc.string() })),
    fc.array(fc.string()),
    (procs, needles) => victimesConcierge({ daemonVivant: true, processus: procs, uddNeedles: needles }).length === 0,
  ));
});

test('PROPRIÉTÉ : toute victime porte une signature À NOUS — jamais un process étranger', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ pid: fc.integer({ min: 1, max: 99999 }), cmd: fc.string() })),
    (procs) => {
      const v = victimesConcierge({ daemonVivant: false, processus: procs, uddNeedles: UDD });
      return v.every((pid) => {
        const c = (procs.find((x) => x.pid === pid)?.cmd || '').replace(/\\/g, '/');
        return c.includes('child-guard.js') || UDD.some((n) => c.includes(n));
      });
    },
  ));
});

test('PROPRIÉTÉ : IDEMPOTENT — rejouer sur la même machine rend la même décision', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ pid: fc.integer({ min: 1, max: 999 }), cmd: fc.string() })),
    fc.boolean(),
    (procs, vivant) => {
      const faits = { daemonVivant: vivant, processus: procs, uddNeedles: UDD };
      return JSON.stringify(victimesConcierge(faits)) === JSON.stringify(victimesConcierge(faits));
    },
  ));
});

// ── L'OBSERVATION DU NOYAU ────────────────────────────────────────────────────────────────────
// 🛑 On teste ici que la question « le daemon vit-il ? » est posée AU NOYAU et rend un FAIT.
test('VIVANT = quelqu un écoute VRAIMENT sur le canal (question posée au noyau)', async () => {
  const canal = process.platform === 'win32'
    ? `\\\\.\\pipe\\pw-mcp-test-${process.pid}`
    : path.join(os.tmpdir(), `pw-mcp-test-${process.pid}.sock`);
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(canal, r));
  expect(await daemonVivant(canal), 'un serveur écoute : le connect aboutit').toBe(true);
  await new Promise((r) => srv.close(r));
  expect(await daemonVivant(canal),
    "plus personne n'écoute : ECONNREFUSED/ENOENT est un FAIT du noyau, pas une supposition").toBe(false);
});

test('MORT = canal qui n a JAMAIS existé (aucun fichier, aucun pipe)', async () => {
  const inexistant = process.platform === 'win32'
    ? `\\\\.\\pipe\\pw-mcp-jamais-${process.pid}`
    : path.join(os.tmpdir(), `pw-mcp-jamais-${process.pid}.sock`);
  expect(await daemonVivant(inexistant)).toBe(false);
});

// ── LE DÉCLENCHEUR EST CELUI DE L'OS ──────────────────────────────────────────────────────────
// ⚠️ Ce test scelle une DÉCISION D'ARCHITECTURE, pas une chaîne de caractères : le concierge
// s'abonne à un fait que le système SAIT déjà annoncer. Une régression vers un `setInterval` de
// surveillance rendrait ce fichier rouge, et c'est exactement le but.
test('DÉCLENCHEURS NATIFS : boot ET réveil, via le mécanisme officiel de chaque OS', () => {
  const win = planInstallation('win32', 'C:/node.exe', 'C:/p/janitor-main.js', 'moi');
  // 🛑 Installation par XML : les raccourcis `/sc` ont TOUS été refusés sur une machine réelle
  // (ONSTART = droits machine · ONLOGON sans /ru = « any user » donc machine aussi · ONLOGON avec
  // /ru = invite de mot de passe, que `/np` ne supprime pas). Le XML est la surface complète.
  expect(win.type).toBe('schtasks-xml');
  expect(win.contenu, 'ouverture de session de CET utilisateur, jamais « any user »').toMatch(/<LogonTrigger>[\s\S]*<UserId>[^<]*moi<\/UserId>/);
  expect(win.contenu, 'le réveil est l événement OFFICIEL Power-Troubleshooter ID 1 — jamais un sondage')
    .toContain("Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1");
  // 🛑 CE QUI REND L'INSTALLATION POSSIBLE SANS RIEN DEMANDER À PERSONNE.
  expect(win.contenu, 'InteractiveToken = jeton de la session déjà ouverte ⇒ AUCUN mot de passe, AUCUN secret stocké').toContain('InteractiveToken');
  expect(win.contenu, 'LeastPrivilege : le concierge n a aucun besoin d élévation — la demander serait une faute').toContain('LeastPrivilege');
  // ⚠️ BOM UTF-16 : sans elle `schtasks` rend « XML mal formé (1,2) », un message qui accuse le XML
  // alors que c est l ENCODAGE. Diagnostic trompeur, mesuré — donc scellé.
  expect(win.contenu.charCodeAt(0), 'BOM UTF-16 obligatoire en TÊTE de fichier').toBe(0xfeff);
  expect(win.encodage).toBe('utf16le');
  // Les deux déclencheurs dans UNE tâche : pas deux définitions à maintenir en phase.
  expect((win.contenu.match(/<(LogonTrigger|EventTrigger)>/g) || []).length, 'DEUX déclencheurs, UNE tâche').toBe(2);

  const linux = planInstallation('linux', '/usr/bin/node', '/p/janitor-main.js');
  expect(linux.contenu, 'systemd lance l unité APRÈS le réveil').toContain('After=suspend.target');
  expect(linux.contenu, 'et elle est accrochée aux cibles de veille ET au boot').toMatch(/WantedBy=.*suspend\.target/);

  const mac = planInstallation('darwin', '/usr/bin/node', '/p/janitor-main.js');
  expect(mac.contenu, 'macOS : au chargement').toContain('RunAtLoad');
  expect(mac.note, "et le trou macOS est NOMMÉ dans le plan lui-même, jamais passé sous silence").toMatch(/reveil/i);

  // ⚠️ Chemin ABSOLU de node : le PATH d une tâche planifiée n est PAS celui du shell. Un « node »
  // nu produit une tâche qui ne tourne JAMAIS, en silence — la panne muette parfaite.
  expect(win.contenu).toContain('C:/node.exe');
  expect(linux.contenu).toContain('/usr/bin/node');
});
