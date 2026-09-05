// spec.js — construction de la commande backend d'un profil. PUR => testable + mutable.
// C'est la DECISION « quels args passer a @playwright/mcp » (caps, isolated, user-data-dir v1,
// proxy-server, override backend, args libres). Isolee de toute I/O (spawn) pour passer au crible Stryker.
//
// ⚠️ NE construit PAS --host/--port : ce sont des valeurs RUNTIME. Le port est ALLOUE PAR L'OS
// (`port-alloc.js`) puis ajoute aux args par le DAEMON (`server-daemon.js`), qui est le seul a le
// connaitre — il le garde en memoire, il n'y a plus aucun registre. buildSpec = tout SAUF le port.
//
// ⚠️ NE construit PAS NON PLUS le `--user-data-dir` d'une INSTANCE (profil v2 `identity`) : le
// dossier d'instance est lui aussi une valeur RUNTIME — il n'existe qu'une fois que le daemon a
// MATERIALISE l'identite (copie du snapshot vers un dossier neuf, cf `identity-store.js`). Le
// daemon l'ajoute exactement comme il ajoute le port. Seul le profil v1 (`userDataDir`, dossier
// FIXE connu d'avance) le porte ici, pour que le transport stdio (tests, client unique) reste
// utilisable sans daemon.

export const DEFAULT_BACKEND = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };

// 🛑 TOUJOURS PRESENTE : les outils `browser_storage_state` / `browser_set_storage_state` sont
// opt-in cote @playwright/mcp (`--caps=storage`, doc 0.0.78 §Storage) et ce sont EUX qui font
// naitre/exporter une identite. Un serveur sans cette cap ne peut ni sauver ni charger un compte.
// Mesure le 04/09/2026 : le proxy tournait en `caps: []` et les outils d'identite etaient
// simplement ABSENTS de la surface — invisible tant qu'on n'en avait pas besoin.
export const CAP_OBLIGATOIRE = 'storage';

// Ordre des args VOLONTAIRE et STABLE : base backend, --caps, PUIS soit --isolated soit --user-data-dir
// (v1 seulement), PUIS --proxy-server, puis args libres. NE PAS reordonner (le hot-reload compare
// `JSON.stringify(args)` pour decider d'un respawn : un reordre changerait la signature et
// provoquerait des respawns fantomes).
//
// isolated (profil anonyme EN MEMOIRE) et userDataDir/identity (profil persistant) sont MUTUELLEMENT
// EXCLUSIFS : isolated l'emporte. ⚠️ `--isolated` est CONSERVE (aucune capacite retiree) mais n'est
// PLUS le mode du parallelisme : mesure le 04/09/2026 avec detectincognitojs@1.9.0, un contexte
// isole est DETECTE comme navigation privee (stockage en memoire ⇒ ecritures IndexedDB
// `durability:'strict'` sans cout de fsync — propriete PHYSIQUE, aucun flag ne la maquille).
// Le parallelisme = une INSTANCE persistante jetable par client (profil v2 `identity`).
//
// 🛑 `--shared-browser-context` N'EXISTE PLUS ICI, ET NE DOIT JAMAIS REVENIR (gate statique).
// Il ne servait qu'a contourner « Browser is already in use » entre N clients d'UN serveur
// partage ; mesure le 04/09/2026 : avec lui, deux agents ECRASENT mutuellement leur page (B navigue,
// A voit la page de B — c'est la collision du 03/09). Il n'y a plus de serveur partage : chaque
// client a son instance, la question ne se pose plus.
export function buildSpec(profile, profileCfg, globalCfg = {}, opts = {}) {
  const p = profileCfg || {};
  const g = globalCfg || {};
  const backend = p.backend || g.backend || DEFAULT_BACKEND;
  const args = [...(backend.args || [])];
  // caps : override par profil sinon global, PUIS la cap obligatoire (dedoublonnee, en dernier :
  // les caps de l'utilisateur gardent leur ordre, la signature ne bouge pas quand il n'en a pas).
  const capsUtilisateur = Array.isArray(p.caps) ? p.caps : Array.isArray(g.caps) ? g.caps : [];
  const caps = capsUtilisateur.includes(CAP_OBLIGATOIRE) ? capsUtilisateur : [...capsUtilisateur, CAP_OBLIGATOIRE];
  args.push(`--caps=${caps.join(',')}`);
  if (p.isolated) {
    args.push('--isolated');
  } else if (p.userDataDir && !p.identity) {
    // v1 : dossier FIXE, connu d'avance (un seul navigateur a la fois : SingletonLock de Chrome).
    args.push('--user-data-dir', p.userDataDir);
  }
  // Sortie reseau = attribut de l'IDENTITE (un profil = une identite), jamais de l'agent. Flag
  // officiel `--proxy-server <proxy>` (doc 0.0.78 : "http://myproxy:3128" ou "socks5://…").
  if (typeof p.proxyServer === 'string' && p.proxyServer.length > 0) args.push('--proxy-server', p.proxyServer);
  if (Array.isArray(p.args)) args.push(...p.args);
  return { command: backend.command, args, label: p.label || profile };
}
