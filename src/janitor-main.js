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
 * Les commandes/unités d'installation, PAR PLATEFORME. Fonction PURE (rend du texte, n'exécute
 * rien) : `--print` permet de LIRE ce qu'on s'apprête à faire à la machine avant de le faire.
 * ⚠️ Un installateur qu'on ne peut pas inspecter est un installateur qu'on n'ose pas lancer.
 * @param {string} plateforme
 * @param {string} node chemin ABSOLU de l'exécutable node (jamais « node » nu : le PATH d'une
 *   tâche planifiée n'est PAS celui du shell de l'utilisateur — cause classique de tâche qui ne
 *   tourne jamais, en silence)
 */
export function planInstallation(plateforme, node = process.execPath, script = MOI) {
  if (plateforme === 'win32') {
    // ⚠️ DEUX tâches, car un déclencheur `ONSTART` et un déclencheur d'ÉVÉNEMENT ne peuvent pas
    // coexister dans un `schtasks /create` unique.
    // ⚠️ `/RL LIMITED` : le concierge n'a AUCUN besoin d'élévation (il ne tue que des process de
    // l'utilisateur courant). Demander l'admin serait un privilège gratuit — donc une faute.
    const commande = `"${node}" "${script}"`;
    return {
      type: 'schtasks',
      commandes: [
        ['/create', '/f', '/tn', `${NOM_TACHE}-boot`, '/sc', 'onstart', '/rl', 'limited', '/tr', commande],
        // ID 1 de Power-Troubleshooter = « sortie de veille » (journal Système). Événement OFFICIEL.
        ['/create', '/f', '/tn', `${NOM_TACHE}-reveil`, '/rl', 'limited', '/tr', commande,
          '/sc', 'onevent', '/ec', 'System',
          '/mo', "*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]"],
      ],
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
    if (plan.type === 'schtasks') {
      for (const c of plan.commandes) {
        const r = spawnSync('schtasks', c, { encoding: 'utf8', windowsHide: true });
        // ⚠️ On NE MASQUE PAS un échec d'installation : une tâche non créée = un concierge qui ne
        // tournera jamais, et personne ne s'en apercevrait avant la prochaine panne.
        if (r.status !== 0) { process.stderr.write(`schtasks ECHEC (${r.status}): ${r.stderr || r.stdout}\n`); process.exitCode = 1; }
      }
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
