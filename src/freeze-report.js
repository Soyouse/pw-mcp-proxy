// freeze-report.js — PUR : formate un rapport FORENSIQUE de gel/backend « unresponsive » a partir de
// FAITS deja collectes (AUCUNE I/O ici : ni listProcesses, ni horloge lue — tout est parametre). But :
// quand le watchdog declare un backend fige, ecrire dans les logs UN diagnostic exploitable => la
// PROCHAINE occurrence d'un bug tordu (gel du 22/07 jamais capture, cf memory reference-browser-mcp-
// freeze-bug) n'est plus un mystere : on saura si Chrome etait MORT ou FIGE, quelle action pendait,
// depuis combien de temps. Isole de l'I/O => Stryker + property-based (fonction totale, jamais throw).
//
// ⚠️ NE JAMAIS y faire d'I/O ni lire Date.now() : les faits (browserCount, serverAlive, ages) sont
// collectes par l'appelant (manager, cote I/O) et passes ici. Sinon plus mutable/testable.

// browserCount = nombre de process Chrome vivants pour CE profil (--user-data-dir), mesure par l'appelant.
// C'est LE discriminant cle : 0 => Chrome mort/absent ; >0 => Chrome present donc FIGE (pas mort).
function browserDiag(browserCount) {
  if (browserCount === null || browserCount === undefined) return 'inconnu';
  if (browserCount === 0) return 'AUCUN Chrome vivant (mort/absent)';
  return `${browserCount} Chrome vivant(s) => FIGE (pas mort)`;
}

export function formatFreezeReport(facts = {}) {
  const f = facts || {};
  const profile = f.profile ?? '?';
  const reason = f.reason ?? 'unresponsive';
  const serverPid = f.serverPid ?? '?';
  const serverAlive = f.serverAlive === undefined || f.serverAlive === null ? 'inconnu' : String(f.serverAlive);
  const port = f.port ?? '?';
  const missedPings = f.missedPings ?? '?';
  const inflight = Array.isArray(f.inflight) ? f.inflight : [];

  const lines = [];
  lines.push(`[FREEZE] profil="${profile}" reason=${reason}`);
  lines.push(`  serveur: pid=${serverPid} vivant=${serverAlive} port=${port}`);
  lines.push(`  browser: ${browserDiag(f.browserCount)}`);
  lines.push(`  watchdog: pings_rates_consecutifs=${missedPings}`);
  if (inflight.length === 0) {
    lines.push('  requetes EN VOL: aucune');
  } else {
    lines.push(`  requetes EN VOL (${inflight.length}):`);
    for (const r of inflight) {
      const method = (r && r.method) ?? '?';
      const age = r && typeof r.ageMs === 'number' ? ` en vol depuis ${Math.round(r.ageMs / 1000)}s` : '';
      lines.push(`    - ${method}${age}`);
    }
  }
  return lines.join('\n');
}
