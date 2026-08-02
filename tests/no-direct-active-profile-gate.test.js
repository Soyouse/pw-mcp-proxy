// GATE STATIQUE fails-closed : `X.activeProfile = ...` est INTERDIT hors de manager.js.
//
// ⚠️ Ne PAS assouplir. Ne du BUG LIVE 2026-08-02 07:15 (boucle de spawn : un serveur
// @playwright/mcp + son Chrome relances toutes les ~15 s jusqu'a saturer la machine).
// router._handleSwitch faisait `await manager.get(t); manager.activeProfile = t;` — la bascule
// SANS la liberation de l'ancien profil. Le backend quitte restait dans le pool, transport HTTP
// vivant, alors que son serveur venait d'etre reape « idle » => il tapait dans le vide => exited
// => « purge du cadavre + respawn » => boucle.
//
// Le contrat est desormais porte par UNE methode : manager.setActiveProfile(target), qui fait
// get() PUIS libere le precedent. Toute reecriture directe de la propriete court-circuite cette
// liberation et REINTRODUIT la panne — d'ou ce gate, plutot qu'un commentaire qu'on n'ouvre jamais.
//
// ⚠️ DETECTION PAR AST (ast-grep), JAMAIS par regex : `manager.activeProfile = x` cite dans un
// COMMENTAIRE (il y en a un, volontaire, dans manager.js) ferait crier une regex a tort.
// ⚠️ `ast-grep run` sort en code NON-ZERO des qu'il trouve (normal pour un linter) => le JSON se
// lit dans `err.stdout`, sinon le gate echouerait TOUJOURS.

import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = path.join(ROOT, 'rules', 'no-direct-active-profile.yml');

// SEUL fichier autorise a porter l'etat : c'est lui qui expose setActiveProfile().
const PROPRIETAIRE = 'manager.js';

function binAstGrep() {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(ROOT, 'node_modules', '.bin', `ast-grep${ext}`);
  return fs.existsSync(local) ? local : `npx${ext}`;
}

// ⚠️ Le pattern vit dans le FICHIER DE REGLE, jamais en argument de ligne de commande : sur Windows
// l'invocation passe par cmd.exe (shell:true, impose par le .cmd de npm) qui DECOUPE le pattern a
// l'espace — `$X.activeProfile = $Y` y devenait `$X.activeProfile`, donc les LECTURES matchaient
// aussi (4 faux positifs mesures le 02/08 : index.js:70, router.js:53/249/331). Le YAML supprime
// tout quoting. Meme mecanisme que no-inference-gate.
function scan(dir) {
  const bin = binAstGrep();
  const base = bin.startsWith('npx') ? ['ast-grep'] : [];
  const opts = { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' };
  let out;
  try {
    out = execFileSync(bin, [...base, 'scan', '-r', RULE, dir, '--json=compact'], opts);
  } catch (err) {
    // Code non-zero = des occurrences ont ete trouvees : le JSON est sur stdout, pas une panne.
    if (typeof err.stdout !== 'string') throw err; // vrai echec (binaire absent, regle invalide)
    out = err.stdout;
  }
  return JSON.parse(out || '[]');
}

test('aucune affectation directe de activeProfile hors de manager.js (sinon : bascule sans liberation)', () => {
  const hits = scan('src');
  const interdits = hits.filter((h) => path.basename(h.file) !== PROPRIETAIRE);
  const details = interdits.map((h) => `${h.file}:${h.range.start.line + 1}  ${h.text}`);
  expect(
    details,
    `Affectation directe de activeProfile hors de ${PROPRIETAIRE} — utiliser manager.setActiveProfile(), ` +
      `qui LIBERE l'ancien profil (cf entete de ce test, incident 02/08) :\n  ${details.join('\n  ')}`
  ).toEqual([]);
});

// ⚠️ NEGATIVE-CHECK OBLIGATOIRE (anti-gate-creux) : un gate qui ne rougit JAMAIS ne prouve rien.
// On ecrit un fichier fautif dans src/, on verifie qu'il est bien vu, on le retire.
test('NEGATIVE-CHECK : le gate DETECTE une violation introduite (il n est pas creux)', () => {
  const leurre = path.join(ROOT, 'src', '__gate_probe_active_profile.js');
  fs.writeFileSync(leurre, 'export function bad(m) {\n  m.activeProfile = "x";\n}\n');
  try {
    const hits = scan('src');
    const vu = hits.some((h) => path.basename(h.file) === '__gate_probe_active_profile.js');
    expect(vu, 'le gate DOIT voir une affectation directe introduite dans src/').toBe(true);
  } finally {
    fs.unlinkSync(leurre);
  }
});
