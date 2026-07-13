// spec.js — construction de la commande backend d'un profil. PUR => testable + mutable.
// C'est la DECISION « quels args passer a @playwright/mcp » (caps, isolated, user-data-dir, override
// backend, args libres). Isolee de l'I/O (spawn/supervisor) pour passer au crible Stryker.
//
// ⚠️ NE construit PAS --host/--port : en mode HTTP le PORT est runtime (choisi par supervisor.js selon
// le registre partage). Le superviseur ajoute --host/--port a ces args. buildSpec = tout SAUF le port.

export const DEFAULT_BACKEND = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };

// Ordre des args VOLONTAIRE et STABLE : base backend, --caps, PUIS soit --isolated soit --user-data-dir,
// puis args libres. NE PAS reordonner (le hot-reload compare `JSON.stringify(args)` pour decider d'un
// respawn : un reordre changerait la signature et provoquerait des respawns fantomes).
//
// isolated (profil anonyme) et userDataDir (profil-identite persistant) sont MUTUELLEMENT EXCLUSIFS :
// --isolated = profil ephemere en memoire (sessions paralleles illimitees) ; --user-data-dir = profil
// persistant (SingletonLock : 1 navigateur, N clients HTTP via le serveur partage). isolated l'emporte.
//
// ⚠️ MULTI-AGENT sur profil PERSISTANT (opts.http) : la doc @playwright/mcp est FORMELLE — « a persistent
// profile can only be used by one browser instance at a time, so concurrent MCP clients sharing the same
// workspace will conflict ». Le mecanisme DOCUMENTE pour lever ce conflit = `--shared-browser-context`
// (« share a single browser context between multiple connected clients »). Donc en mode HTTP + persistant,
// on l'ajoute => les N agents partagent UN contexte (cookies/pages communs) au lieu de se bloquer. En
// isole, inutile (chaque session a deja son profil ephemere) ; en stdio (client unique), inutile aussi.
export function buildSpec(profile, profileCfg, globalCfg = {}, opts = {}) {
  const p = profileCfg || {};
  const g = globalCfg || {};
  const backend = p.backend || g.backend || DEFAULT_BACKEND;
  const args = [...(backend.args || [])];
  // caps : override par profil sinon global. [] = Playwright minimal (groupe core seul).
  const caps = Array.isArray(p.caps) ? p.caps : Array.isArray(g.caps) ? g.caps : [];
  if (caps.length) args.push(`--caps=${caps.join(',')}`);
  if (p.isolated) {
    args.push('--isolated');
  } else if (p.userDataDir) {
    args.push('--user-data-dir', p.userDataDir);
    if (opts.http) args.push('--shared-browser-context'); // multi-agent persistant (contrat documente)
  }
  if (Array.isArray(p.args)) args.push(...p.args);
  return { command: backend.command, args, label: p.label || profile };
}
