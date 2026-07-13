// spawn-cmd.js — PUR : resolution de la commande de spawn cross-OS (source UNIQUE, anti-duplication).
// Sur Windows, une commande BARE (`npx`, `node`...) n'est PAS un .exe direct => `spawn` sans shell
// echoue (ENOENT sur `npx.cmd`). Il faut `shell:true` + quoter les arguments a espaces. Un binaire
// absolu `.exe`/`.com` se lance SANS shell (un shell casserait sur un chemin a espaces non quote).
//
// ⚠️ SOURCE UNIQUE de cette decision : consommee par stdio-transport.js ET supervisor.js. NE PAS
// dupliquer la logique ailleurs (une copie qui derive = un spawn qui casse sur un seul des deux chemins,
// exactement le bug reproduit 2026-07-13 : le superviseur spawnait `npx` en shell:false => jamais pret).

// Retourne { command, args, shell } prets pour child_process.spawn.
export function resolveShellSpawn(command, args = [], platform = process.platform) {
  const onWin = platform === 'win32';
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(command); // absolu Windows (C:\...) ou POSIX (/...)
  const isBinary = /\.(exe|com)$/i.test(command);
  const needsShell = onWin && !isAbsolute && !isBinary;
  if (!needsShell) return { command, args, shell: false };
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s); // quote si espace (le shell re-parse la ligne)
  return { command: q(command), args: args.map(q), shell: true };
}
