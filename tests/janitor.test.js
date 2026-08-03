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
  const win = planInstallation('win32', 'C:/node.exe', 'C:/p/janitor-main.js');
  expect(win.commandes.some((c) => c.includes('onstart')), 'Windows : démarrage').toBe(true);
  expect(win.commandes.flat().join(' '),
    'Windows : le réveil est l événement OFFICIEL Power-Troubleshooter ID 1 — jamais un sondage')
    .toContain("Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1");
  expect(win.commandes.flat().join(' '), 'aucune élévation demandée : le concierge n en a pas besoin').toContain('limited');

  const linux = planInstallation('linux', '/usr/bin/node', '/p/janitor-main.js');
  expect(linux.contenu, 'systemd lance l unité APRÈS le réveil').toContain('After=suspend.target');
  expect(linux.contenu, 'et elle est accrochée aux cibles de veille ET au boot').toMatch(/WantedBy=.*suspend\.target/);

  const mac = planInstallation('darwin', '/usr/bin/node', '/p/janitor-main.js');
  expect(mac.contenu, 'macOS : au chargement').toContain('RunAtLoad');
  expect(mac.note, "et le trou macOS est NOMMÉ dans le plan lui-même, jamais passé sous silence").toMatch(/reveil/i);

  // ⚠️ Chemin ABSOLU de node : le PATH d une tâche planifiée n est PAS celui du shell. Un « node »
  // nu produit une tâche qui ne tourne JAMAIS, en silence — la panne muette parfaite.
  expect(win.commandes.flat().join(' ')).toContain('C:/node.exe');
  expect(linux.contenu).toContain('/usr/bin/node');
});
