#!/usr/bin/env node
// tools/migrer-identite.mjs — MIGRATION v1 → v2 : un dossier de profil FIXE (`userDataDir`) devient une
// IDENTITÉ du coffre (snapshot sans caches). Posé le 05/09/2026 (BACKLOG « PLAN DE CHANTIER SWARM » §4).
//
//   node tools/migrer-identite.mjs <identite> [--from <dossier>] [--config <profiles.json>]
//
// ⚠️ NE RÉIMPLÉMENTE RIEN : la copie est `snapshotRetour` (identity-store.js) — atomique par rename,
// filtrée par la décision pure, REFUSÉE au-dessus du plafond (l'ancien snapshot reste intact).
// ⚠️ REFUS NOMMÉ si un Chrome tient encore le dossier source : une copie de SQLite en cours
// d'écriture est incohérente. La question est posée aux PROCESS (cmdline exacte contenant le
// dossier), jamais à un fichier de verrou (il survit à un crash).
// ⚠️ Le dossier v1 n'est JAMAIS supprimé ici : expand/contract — le retrait de `userDataDir` est
// une étape SÉPARÉE, après preuve que l'identité fonctionne depuis le coffre.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRetour } from '../src/identity-store.js';
import { cheminsCoffre, lirePlafonds, nomIdentiteValide } from '../src/identity-store-pure.js';
import { listProcesses } from '../src/prockill.js';
import { normPath } from '../src/prockill-pure.js';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(nom) {
  const i = process.argv.indexOf(nom);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const identite = process.argv[2];
if (!identite || identite.startsWith('--') || !nomIdentiteValide(identite)) {
  console.error('usage: node tools/migrer-identite.mjs <identite> [--from <dossier>] [--config <profiles.json>]\n(identite = [A-Za-z0-9._-], 1..64)');
  process.exit(2);
}
const cheminConfig = arg('--config') || process.env.PW_MCP_PROFILES || path.join(RACINE, 'profiles.json');
const cfg = JSON.parse(fs.readFileSync(cheminConfig, 'utf8'));
const source = arg('--from') || cfg.profiles?.[identite]?.userDataDir;
if (!source) {
  console.error(`REFUS : aucun dossier source — le profil "${identite}" n'a pas de userDataDir dans ${cheminConfig}, et --from est absent`);
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`REFUS : dossier source introuvable : ${source}`);
  process.exit(2);
}

// Un Chrome tient-il ce dossier ? Fait mesuré sur les PROCESS, jamais inféré d'un verrou.
const aiguille = normPath(source);
const tenu = listProcesses().filter((p) => normPath(p.cmd).includes(aiguille) && /chrome|chromium|msedge/i.test(p.cmd));
if (tenu.length) {
  console.error(`REFUS : ${tenu.length} process Chrome tiennent encore ${source} (pid ${tenu.map((p) => p.pid).join(', ')}). Fermer le navigateur de ce profil d'abord — une copie de SQLite ouvert serait incohérente.`);
  process.exit(3);
}

const { storeDir } = cheminsCoffre(cfg, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join);
const plafonds = lirePlafonds(cfg.identityStore);
console.log(`migration "${identite}" : ${source} → ${path.join(storeDir, identite)} (plafond ${plafonds.maxParIdentiteMo} Mo, caches exclus)`);
const t0 = Date.now();
const r = await snapshotRetour({ identite, storeDir, instanceDir: source, plafonds });
if (!r.ok) {
  console.error(`REFUS : ${r.raison}`);
  process.exit(4);
}
console.log(`OK : ${Math.round(r.octets / 1048576)} Mo dans le coffre en ${((Date.now() - t0) / 1000).toFixed(1)} s. Le dossier v1 est INTACT (retrait = étape séparée).`);
