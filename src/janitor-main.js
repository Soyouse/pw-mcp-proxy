#!/usr/bin/env node
// janitor-main.js — le concierge en tant que PROCESS, et son INSTALLATION dans l'OS. 03/08/2026.
//
// 🛑 LE DÉCLENCHEUR EST CELUI DE L'OS, JAMAIS UNE BOUCLE À NOUS. C'est la même règle que partout
// dans ce dépôt : « le noyau/le système SAIT, on ne devine pas ». Un `setInterval` qui vérifierait
// toutes les N minutes serait de l'inférence déguisée (« il s'est peut-être passé quelque chose »),
// consommerait la machine en continu, et manquerait quand même la fenêtre juste après un réveil.
// Les trois systèmes savent DIRE « je viens de démarrer » et « je viens de sortir de veille » —
// on s'abonne à ce fait, on ne le cherche pas.
//
//   Windows : Planificateur de tâches — `ONSTART` (démarrage) + déclencheur sur ÉVÉNEMENT
//             `Microsoft-Windows-Power-Troubleshooter` / **ID 1**, qui est l'événement officiel
//             « le système est sorti d'un état de veille » (journal Système). Rien à écrire nous-mêmes.
//   Linux   : systemd — `WantedBy=multi-user.target` (boot) ET `WantedBy=suspend.target
//             hibernate.target sleep.target` avec `After=` : systemd lance l'unité APRÈS le réveil.
//             C'est le point d'extension documenté, pas un contournement.
//   macOS   : launchd — `RunAtLoad` (chargement/boot) UNIQUEMENT.
//             🛑 **launchd N'A AUCUN DÉCLENCHEUR DE RÉVEIL, et ce n'est pas un oubli de notre part**
//             (re-vérifié le 03/08/2026 : Apple ne fournit aucune clé de ce type ; les notifications
//             de veille/réveil ne sont exposées que par `IOKit`, donc via du code NATIF). La réponse
//             communautaire universelle est l'utilitaire tiers `sleepwatcher` — 🛑 **REFUSÉ ICI** :
//             le dépôt est à ZÉRO dépendance runtime, et imposer un `brew install` à qui clone le
//             projet romprait ce contrat pour un seul OS.
//             ⇒ COUVERTURE macOS ASSUMÉE ET NOMMÉE : boot oui, réveil non (le ménage se fait au
//             démarrage suivant). ⚠️ NE PAS « combler » avec un sondage périodique : on échangerait
//             une couverture partielle HONNÊTE contre une inférence permanente, ce que toute la
//             doctrine du dépôt interdit. Si Apple publie un jour une clé de réveil, c'est ICI
//             qu'elle se branche — et nulle part ailleurs.
//
// USAGE :
//   node src/janitor-main.js            → UNE passe, puis sort (c'est ce que l'OS appelle)
//   node src/janitor-main.js --install  → enregistre les déclencheurs natifs ci-dessus
//   node src/janitor-main.js --print    → écrit sur stdout l'unité/la commande, sans rien installer

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bootLogger } from './log-boot.js';
import { log } from './logger.js';
import { passeConcierge } from './janitor.js';
import { describeError, stackOf } from './error-detail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const racine = path.join(__dirname, '..');
bootLogger(racine);

process.on('uncaughtException', (e) => log('concierge uncaughtException: ' + describeError(e) + ' | ' + stackOf(e)));
process.on('unhandledRejection', (e) => log('concierge unhandledRejection: ' + describeError(e) + ' | ' + stackOf(e)));

const MOI = path.join(__dirname, 'janitor-main.js');
const NOM_TACHE = 'pw-mcp-proxy-concierge';

/**
 * L'utilisateur pour qui la tâche est créée (Windows).
 * ⚠️ `os.userInfo()` JETTE quand l'uid n'a pas d'entrée passwd — même piège que `channel-name.js`,
 * qui l'a déjà payé. On rend `''` : `planInstallation` reste une fonction TOTALE, et l'échec
 * éventuel viendra de `schtasks`, bruyamment, jamais d'une exception dans un installateur.
 */
function utilisateurCourant() {
  try { return os.userInfo().username || ''; } catch { return ''; }
}

/**
 * Les commandes/unités d'installation, PAR PLATEFORME. Fonction PURE (rend du texte, n'exécute
 * rien) : `--print` permet de LIRE ce qu'on s'apprête à faire à la machine avant de le faire.
 * ⚠️ Un installateur qu'on ne peut pas inspecter est un installateur qu'on n'ose pas lancer.
 * @param {string} plateforme
 * @param {string} node chemin ABSOLU de l'exécutable node (jamais « node » nu : le PATH d'une
 *   tâche planifiée n'est PAS celui du shell de l'utilisateur — cause classique de tâche qui ne
 *   tourne jamais, en silence)
 */
export function planInstallation(plateforme, node = process.execPath, script = MOI, utilisateur = utilisateurCourant()) {
  if (plateforme === 'win32') {
    // 🛑 INSTALLATION PAR **XML** (`schtasks /create /xml`), ET NON PAR LES RACCOURCIS `/sc`.
    // Les raccourcis ont été essayés, et la doc officielle explique pourquoi ils ne peuvent PAS
    // convenir ici (learn.microsoft.com « schtasks create », lu le 03/08/2026) :
    //   · `/sc ONSTART` s'exécute « every time the system starts », donc HORS session ⇒ droits
    //     machine exigés. Nos process n'existent QUE dans la session de l'utilisateur : c'est SON
    //     `--user-data-dir`, SON Chrome, SON daemon. Le privilège serait gratuit, donc fautif.
    //   · `/sc ONLOGON` sans `/ru` vaut « whenever a user (**any user**) logs on » ⇒ machine-wide,
    //     même refus. Et AVEC `/ru`, la doc est explicite : « Schtasks **always prompts for a
    //     password** unless you provide one, **even when you schedule a task on the local computer
    //     using the current user account**. » Sans terminal interactif — notre cas TOUJOURS — la
    //     création échoue. ⚠️ `/np` ne suffit pas (MESURÉ : l'invite apparaît quand même).
    //   · Et deux déclencheurs ne peuvent pas coexister dans un `/sc` unique ⇒ il aurait fallu
    //     DEUX tâches, donc deux définitions à maintenir en phase. Duplication par contrainte d'outil.
    //
    // ✅ Le XML est la surface COMPLÈTE du Planificateur (`/xml <xmlfile>` est documenté au même
    // endroit), et il règle les trois points d'un coup :
    //   · `<LogonTrigger><UserId>` — l'ouverture de session de CET utilisateur, pas de « any user » ;
    //   · `<EventTrigger>` — le réveil, MÊME tâche, aucune duplication ;
    //   · `<LogonType>InteractiveToken</LogonType>` — la tâche s'exécute avec le jeton de la session
    //     déjà ouverte ⇒ **AUCUN mot de passe demandé, AUCUN secret stocké, AUCUNE élévation**.
    //     C'est le mécanisme prévu par Windows pour exactement ce besoin.
    // ⚠️ NE PAS « simplifier » en revenant à `/sc` : on retomberait sur les refus ci-dessus.
    const compte = utilisateur ? `${process.env.USERDOMAIN || '.'}\\${utilisateur}` : utilisateur;
    return {
      type: 'schtasks-xml',
      nom: NOM_TACHE,
      // ⚠️ UTF-16 : `schtasks /xml` REFUSE un fichier en UTF-8 avec BOM ou en ANSI selon les
      // versions ; le Planificateur exporte lui-même en UTF-16. On écrit donc dans le format qu'il
      // produit, jamais dans celui qui « devrait marcher ».
      encodage: /** @type {BufferEncoding} */ ('utf16le'),
      // 🛑 `﻿` = LA MARQUE D'ORDRE D'OCTETS (BOM), ET ELLE EST OBLIGATOIRE. Node écrit
      // l'UTF-16LE SANS BOM ; sans elle, le parseur de `schtasks` lit le fichier comme de l'ANSI et
      // rend « Le code XML de la tâche est mal formé — (1,2) un élément racine » (MESURÉ 03/08).
      // Le message accuse le XML, alors que le XML est valide : c'est l'ENCODAGE qui n'est pas
      // reconnu. Piège classique, et diagnostic trompeur — d'où ce commentaire.
      contenu: `﻿<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pw-mcp-proxy : supprime les serveurs sans proprietaire (ouverture de session + sortie de veille)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${compte}</UserId></LogonTrigger>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="System"&gt;&lt;Select Path="System"&gt;*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${compte}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${node}</Command>
      <Arguments>"${script}"</Arguments>
    </Exec>
  </Actions>
</Task>
`,
    };
  }
  if (plateforme === 'darwin') {
    return {
      type: 'launchd',
      chemin: path.join(process.env.HOME || '~', 'Library', 'LaunchAgents', `${NOM_TACHE}.plist`),
      contenu: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${NOM_TACHE}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
      // ⚠️ Voir l'en-tête : la veille n'est PAS couverte sur macOS, et c'est assumé, pas ignoré.
      note: 'macOS : boot seulement (launchd n expose aucun declencheur de reveil public).',
    };
  }
  return {
    type: 'systemd',
    chemin: path.join(process.env.HOME || '~', '.config', 'systemd', 'user', `${NOM_TACHE}.service`),
    contenu: `[Unit]
Description=pw-mcp-proxy — concierge (supprime les serveurs sans proprietaire)
# ⚠️ After= sur les cibles de veille : systemd lance l'unite APRES le reveil, jamais avant.
After=suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target

[Service]
Type=oneshot
ExecStart=${node} ${script}

[Install]
WantedBy=default.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target
`,
  };
}

async function principal() {
  const args = process.argv.slice(2);

  if (args.includes('--print')) {
    const plan = planInstallation(process.platform);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }

  if (args.includes('--install')) {
    const plan = planInstallation(process.platform);
    if (plan.type === 'schtasks-xml') {
      const fs = await import('node:fs');
      // Fichier TEMPORAIRE : le XML n'est qu'un véhicule, la vérité vit ensuite dans le
      // Planificateur. Le laisser traîner créerait une 2e source qui pourrait diverger.
      const tmp = path.join(os.tmpdir(), `${plan.nom}.xml`);
      fs.writeFileSync(tmp, plan.contenu, plan.encodage);
      // ⚠️ `/f` : ré-installer doit être IDEMPOTENT (remplace sans demander). Un installateur qu'on
      // n'ose pas relancer est un installateur qu'on ne relance pas — donc qui dérive.
      const r = spawnSync('schtasks', ['/create', '/f', '/tn', plan.nom, '/xml', tmp], { encoding: 'utf8', windowsHide: true });
      try { fs.unlinkSync(tmp); } catch { /* SILENCE: nettoyage best-effort d'un fichier temporaire */ }
      // ⚠️ On NE MASQUE PAS un échec d'installation : une tâche non créée = un concierge qui ne
      // tournera jamais, et personne ne s'en apercevrait avant la prochaine panne.
      if (r.status !== 0) { process.stderr.write(`schtasks ECHEC (${r.status}): ${r.stderr || r.stdout}\n`); process.exitCode = 1; }
    } else {
      const fs = await import('node:fs');
      fs.mkdirSync(path.dirname(plan.chemin), { recursive: true });
      fs.writeFileSync(plan.chemin, plan.contenu);
      if (plan.type === 'systemd') {
        spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
        const r = spawnSync('systemctl', ['--user', 'enable', `${NOM_TACHE}.service`], { encoding: 'utf8' });
        if (r.status !== 0) { process.stderr.write(`systemctl ECHEC: ${r.stderr}\n`); process.exitCode = 1; }
      } else {
        spawnSync('launchctl', ['load', '-w', plan.chemin], { encoding: 'utf8' });
      }
    }
    // 🛑 NE JAMAIS ANNONCER UN SUCCES QU'ON N'A PAS. Mesuré sur soi-même le 03/08 : une des deux
    // tâches avait échoué (« Accès refusé ») et cette ligne écrivait quand même « concierge
    // installé ». Un installateur qui ment sur son résultat produit exactement la panne que tout ce
    // fichier existe pour supprimer : on croit protégé un système qui ne l'est pas.
    if (process.exitCode) { process.stderr.write(`concierge NON installe (${plan.type}) — cf erreurs ci-dessus\n`); return; }
    process.stdout.write(`concierge installe (${plan.type})\n`);
    return;
  }

  // Mode NOMINAL : une passe, puis on sort. Aucun process résident — le concierge n'a rien à
  // surveiller entre deux réveils, et un résident de plus serait un orphelin potentiel de plus.
  const cheminConfig = process.env.PW_MCP_PROFILES || path.join(racine, 'profiles.json');
  const { daemon, tues } = await passeConcierge({ cheminConfig });
  if (tues.length) log(`[concierge] passe terminee : ${tues.length} process supprime(s)`);
  else if (daemon) log('[concierge] daemon vivant — rien a faire (cas nominal)');
}

// ⚠️ `await` de TOP-LEVEL sous try/catch (règle du dépôt) : une exception y avorte le module et le
// process meurt SANS RIEN JOURNALISER — `uncaughtException` ne la voit pas.
try { await principal(); } catch (e) { log('concierge FATAL: ' + describeError(e) + ' | ' + stackOf(e)); process.exitCode = 1; }
