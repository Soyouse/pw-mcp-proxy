#!/usr/bin/env node
// Gate de vérification formelle du VERROU FICHIER (supervisor.js _lock / _tryStealStale).
// Lance TLC sur les DEUX configs et FAILS-CLOSED :
//   - Buggy.cfg  (protocole = unlink inconditionnel, code d'AVANT le fix) => TLC DOIT trouver une
//     violation de MutualExclusion. Vert ici = spec creuse (negative-check) => on ÉCHOUE.
//   - Fixed.cfg  (protocole = vol sérialisé, code ACTUEL) => TLC DOIT prouver l'exclusion (aucun
//     contre-exemple). Rouge ici = régression du protocole => on ÉCHOUE.
// ⚠️ Ce gate est l'exigence doctrine « locks distribués → TLA+ + trace validation + negative-check ».
// tla2tools.jar est téléchargé à la demande (non versionné). CI : setup-java fournit le JDK.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JAR = path.join(HERE, 'tla2tools.jar');
const MODULE = 'SupervisorLock.tla';

function resolveJava() {
  if (process.env.JAVA_HOME) {
    const j = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (existsSync(j)) return j;
  }
  // Windows dev : JDK scoop (fallback pratique hors CI). Sinon `java` du PATH.
  const scoop = path.join(process.env.USERPROFILE || process.env.HOME || '', 'scoop', 'apps', 'temurin17-jdk', 'current', 'bin', 'java.exe');
  if (process.platform === 'win32' && existsSync(scoop)) return scoop;
  return 'java';
}

function runTlc(cfg) {
  const res = spawnSync(resolveJava(), ['-cp', JAR, 'tlc2.TLC', '-deadlock', '-config', cfg, MODULE], {
    cwd: HERE, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  return { out, violated: /Invariant \w+ is violated/.test(out), clean: /No error has been found/.test(out) };
}

function cleanupArtifacts() {
  // TLC dépose des artefacts de trace/état à côté du module : on les balaie (non versionnés).
  for (const f of readdirSync(HERE)) {
    if (/_TTrace_.*\.(tla|bin)$/.test(f) || /\.st$/.test(f)) { try { unlinkSync(path.join(HERE, f)); } catch {} }
  }
}

if (!existsSync(JAR)) {
  console.error(`[spec] tla2tools.jar absent (${JAR}).`);
  console.error('[spec] Téléchargez-le : curl -sL -o spec/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar');
  process.exit(2);
}

let ok = true;

const buggy = runTlc('Buggy.cfg');
if (buggy.violated) {
  console.log('✅ negative-check (Buggy)  : violation détectée comme attendu (la spec a des dents).');
} else {
  ok = false;
  console.error('❌ negative-check (Buggy)  : AUCUNE violation → spec creuse ou protocole buggé rendu sûr par erreur.');
  console.error(buggy.out.split('\n').slice(-15).join('\n'));
}

const fixed = runTlc('Fixed.cfg');
if (fixed.clean) {
  console.log('✅ preuve (Fixed)          : exclusion mutuelle prouvée, aucun contre-exemple.');
} else {
  ok = false;
  console.error('❌ preuve (Fixed)          : contre-exemple trouvé → RÉGRESSION du protocole de verrou.');
  console.error(fixed.out.split('\n').slice(-25).join('\n'));
}

cleanupArtifacts();
if (!ok) process.exit(1);
console.log('✅ spec/SupervisorLock.tla : verrou fichier formellement vérifié (TLC).');
