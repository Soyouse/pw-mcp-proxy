// prockill-pure.js — DECISION pure du balayage de process (aucune I/O) => testable + mutable.
// L'I/O (enumeration réelle, kill) vit dans prockill.js. Ici : uniquement « quels PID tuer ».
// Separation OBLIGATOIRE (doctrine) : la logique passe au crible Stryker, l'I/O passe au live.

// Normalise les separateurs pour comparer des chemins Windows melangeant / et \.
// ⚠️ Cross-OS CRITIQUE : Chrome ecrit `--user-data-dir=C:/.../perso` (/) mais le crashpad-handler
// enfant ecrit `...\perso` (\). Un needle en / DOIT matcher les deux => on normalise les DEUX cotes.
export function normPath(s) {
  return String(s || '').replace(/\\/g, '/');
}

// Retourne les PID a tuer : process (hors self) dont la cmdline contient un des needles
// (comparaison separateur-agnostique). needles vide => [] (aucune victime, jamais un sweep large).
// `procs` = [{pid, cmd}] ; deterministe, sans effet de bord.
export function selectVictims(procs, needles, selfPid) {
  const wanted = (needles || []).map(normPath).filter(Boolean);
  if (!wanted.length) return [];
  const out = [];
  for (const p of procs || []) {
    if (!p || p.pid === selfPid) continue;
    const c = normPath(p.cmd);
    if (wanted.some((n) => c.includes(n))) out.push(p.pid);
  }
  return out;
}
