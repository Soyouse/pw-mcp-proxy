// spec.js — construction de la commande backend d'un profil. PUR => testable + mutable.
// C'est la DECISION « quels args passer a @playwright/mcp » (caps, user-data-dir, override backend,
// args libres). Isolee de l'I/O (le spawn vit dans backend.js) pour passer au crible Stryker.

export const DEFAULT_BACKEND = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };

// Ordre des args VOLONTAIRE et STABLE : base backend, puis --caps, puis --user-data-dir, puis args
// libres du profil. NE PAS reordonner (le hot-reload compare `JSON.stringify(args)` pour decider
// d'un respawn : un reordre changerait la signature et provoquerait des respawns fantomes).
export function buildSpec(profile, profileCfg, globalCfg = {}) {
  const p = profileCfg || {};
  const g = globalCfg || {};
  const backend = p.backend || g.backend || DEFAULT_BACKEND;
  const args = [...(backend.args || [])];
  // caps : override par profil sinon global. [] = Playwright minimal (groupe core seul).
  const caps = Array.isArray(p.caps) ? p.caps : Array.isArray(g.caps) ? g.caps : [];
  if (caps.length) args.push(`--caps=${caps.join(',')}`);
  if (p.userDataDir) args.push('--user-data-dir', p.userDataDir);
  if (Array.isArray(p.args)) args.push(...p.args);
  return { command: backend.command, args, label: p.label || profile };
}
