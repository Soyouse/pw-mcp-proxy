#!/usr/bin/env node
// tools/basculer-v2.mjs — BASCULE de profiles.json du schéma v1 (userDataDir) au schéma v2 (identity).
// Posé le 05/09/2026 (BACKLOG « PLAN DE CHANTIER SWARM » §4, expand/contract).
//
//   node tools/basculer-v2.mjs [--config <profiles.json>] [--dry-run]
//
// CE QU'IL FAIT, dans cet ordre, et rien d'autre :
//   1. lit profiles.json ; pour CHAQUE profil `userDataDir` : REFUSE si l'identité n'est pas encore
//      dans le coffre (migrer-identite.mjs d'abord) — jamais une bascule vers une identité vide ;
//   2. écrit `profiles.v1.bak.json` (retour arrière = le recopier sur profiles.json) ;
//   3. réécrit profiles.json : `identity`/`persist`/`strategie` à la place de `userDataDir`, les
//      profils `isolated` de campagne (`job1..N`) remplacés par UN profil `job` persistant vierge
//      (`persist:false`), backend épinglé 0.0.80, `identityStore`/`instances` déclarés avec plafonds ;
//   4. ARRÊTE l'ancien daemon (il porte l'ANCIEN code : serveur partagé) — identifié par sa ligne de
//      commande EXACTE (`daemon-main.js` + le canal de CET utilisateur), jamais « un node qui traîne ».
//      Ses serveurs meurent avec lui (gardien) ; les proxys vivants portent AUSSI l'ancien code et
//      DOIVENT être redémarrés (sessions Claude Code / autres harnais) : c'est imprimé, pas caché.
//
// ⚠️ IDEMPOTENT : relancé sur une config déjà v2, il ne change rien et ne tue rien.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cheminsCoffre } from '../src/identity-store-pure.js';
import { daemonChannelName } from '../src/channel-name.js';
import { listProcesses, treeKill } from '../src/prockill.js';
import { normPath } from '../src/prockill-pure.js';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const iCfg = process.argv.indexOf('--config');
const cheminConfig = iCfg >= 0 ? process.argv[iCfg + 1] : (process.env.PW_MCP_PROFILES || path.join(RACINE, 'profiles.json'));

const cfg = JSON.parse(fs.readFileSync(cheminConfig, 'utf8'));
const { storeDir, instancesDir } = cheminsCoffre(cfg, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join);

// 1. Chaque identité à basculer doit EXISTER dans le coffre.
const manquantes = [];
const profils = {};
let nbV1 = 0, nbIsoles = 0;
for (const [nom, p] of Object.entries(cfg.profiles || {})) {
  if (p.identity !== undefined) { profils[nom] = p; continue; } // déjà v2
  if (p.userDataDir) {
    nbV1++;
    if (!fs.existsSync(path.join(storeDir, nom))) manquantes.push(nom);
    profils[nom] = { identity: nom, persist: true, strategie: 'snapshot', label: p.label || nom, ...(p.caps ? { caps: p.caps } : {}), ...(p.args ? { args: p.args } : {}), ...(p.proxyServer ? { proxyServer: p.proxyServer } : {}) };
    continue;
  }
  if (p.isolated) { nbIsoles++; continue; } // les profils jetables isolés de campagne sont REMPLACÉS par `job`
  profils[nom] = p; // stdio/custom : inchangé
}
if (manquantes.length) {
  console.error(`REFUS : identité(s) absente(s) du coffre ${storeDir} : ${manquantes.join(', ')}\n→ node tools/migrer-identite.mjs <identite> pour chacune, puis relancer.`);
  process.exit(3);
}
if (nbIsoles > 0 && !profils.job) {
  profils.job = { identity: 'job', persist: false, strategie: 'snapshot', label: 'Candidatures - identite vierge persistante, une instance neuve par agent, rien de sauve (jamais --isolated : detecte comme navigation privee)' };
}

const nouvelle = {
  ...cfg,
  backend: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.80'] },
  // 500 Mo et non les 300 de Steel : `perso` mesure DÉJÀ 276 Mo sans caches (05/09/2026) — un plafond
  // à 24 Mo de la réalité refuserait le rangement au premier mois. Le plafond est un CHOIX déclaré ici,
  // le défaut du module pur (300) reste la référence de l'industrie pour un coffre neuf.
  identityStore: { dir: storeDir, maxParIdentiteMo: cfg.identityStore?.maxParIdentiteMo ?? 500, maxTotalMo: cfg.identityStore?.maxTotalMo ?? 6000, retentionJours: cfg.identityStore?.retentionJours ?? 30 },
  instances: { dir: instancesDir },
  profiles: profils,
};
if (!nouvelle.profiles[nouvelle.defaultProfile]) nouvelle.defaultProfile = Object.keys(profils)[0];

const identique = JSON.stringify(nouvelle) === JSON.stringify(cfg);
console.log(`${nbV1} profil(s) v1 → v2, ${nbIsoles} profil(s) isolé(s) remplacé(s) par "job", backend 0.0.80, coffre ${storeDir}, instances ${instancesDir}`);
if (identique) { console.log('config déjà v2 : rien à faire'); process.exit(0); }
if (dryRun) { console.log(JSON.stringify(nouvelle, null, 2)); process.exit(0); }

// 2 + 3. Sauvegarde puis écriture (atomique : fichier temporaire + rename).
const bak = cheminConfig.replace(/\.json$/, '.v1.bak.json');
fs.copyFileSync(cheminConfig, bak);
const tmp = cheminConfig + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(nouvelle, null, 2) + '\n');
fs.renameSync(tmp, cheminConfig);
console.log(`profiles.json réécrit (sauvegarde : ${bak})`);

// 4. L'ancien daemon porte l'ancien code : il doit sortir. Cible EXACTE = notre daemon-main.js sur
// NOTRE canal (nom dérivé de l'utilisateur, même calcul que le client).
const canal = normPath(daemonChannelName(process.env));
const daemons = listProcesses().filter((p) => normPath(p.cmd).includes('daemon-main.js') && normPath(p.cmd).includes(canal));
for (const d of daemons) {
  try { treeKill(d.pid); console.log(`ancien daemon arrêté (pid ${d.pid}) — ses serveurs meurent avec lui (gardien)`); }
  catch (e) { console.error(`arrêt du daemon ${d.pid} impossible : ${e?.code || e}`); }
}
if (!daemons.length) console.log('aucun ancien daemon vivant sur ce canal');
console.log('\n⚠️ À FAIRE PAR L\'OPÉRATEUR : redémarrer les sessions qui tiennent un proxy `browser` (Claude Code, Codex, Gemini…) — un proxy vivant porte encore l\'ANCIEN code et ne se reconnecte jamais seul.');
