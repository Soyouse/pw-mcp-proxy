// PUR — IDENTITE d'un process : (pid, instant de demarrage). Parsing + comparaison.
//
// POURQUOI (faille trouvee par simulation le 2026-08-01, jamais survenue mais CERTAINE a terme) :
// un PID est un NUMERO REUTILISABLE, pas une identite (`pid_max` = 32768 par defaut sous Linux).
// Sur une machine qui tourne des semaines, le PID d'un serveur mort finit reattribue. Or
// `supervisor.js` fait `if (isPidAlive(pid)) treeKill(pid)` ⇒ a terme, **on tue un process qui
// n'est pas le notre**. C'est la faute la plus grave du projet : elle sort de son perimetre.
//
// ⚠️ LE TOKEN DE DEMARRAGE EST OPAQUE. On ne fait JAMAIS d'arithmetique dessus, jamais de
//    comparaison d'ordre, jamais de conversion en duree. On compare deux lectures a l'IDENTIQUE.
//    C'est ce qui rend l'identite immunisee aux sauts d'horloge (NTP, DST) : peu importe ce que
//    le nombre represente, seule son EGALITE a un sens. Traiter ce token comme un temps
//    reintroduirait exactement la classe de bug qu'on elimine.
// ⚠️ `pidfd` (Linux 5.3+) serait la reponse ideale — ecarte SCIEMMENT : Linux uniquement ET
//    inaccessible depuis Node sans addon natif. Cela violerait le zero-dependance runtime ET le
//    cross-OS. (pid, starttime) est l'equivalent portable, c'est ce que fait systemd.

/**
 * Linux — `/proc/<pid>/stat`, champ 22 (1-indexe) = starttime, en ticks DEPUIS LE BOOT.
 * Immunise NTP par construction (ce n'est pas une date murale).
 *
 * ⚠️ Le champ 2 (`comm`) est entre parentheses et peut contenir DES ESPACES ET DES PARENTHESES
 *    (un binaire peut s'appeler `my (weird) app`). On coupe donc apres la DERNIERE `)`, jamais
 *    par un `split(' ')` naif — c'est le piege classique de ce format.
 *
 * @returns {string|null} token opaque, ou null si illisible
 */
export function parseLinuxStat(content) {
  if (typeof content !== 'string') return null;
  const close = content.lastIndexOf(')');
  if (close === -1) return null;
  // Apres `) `, les champs repartent au champ 3 (state). starttime = champ 22 ⇒ index 19 ici.
  const rest = content.slice(close + 1).trim().split(/\s+/);
  const tok = rest[19];
  return tok && /^\d+$/.test(tok) ? tok : null;
}

/**
 * Windows — `CreationDate` de Win32_Process, rendu en ISO 8601 (`.ToString('o')`).
 * Mesure du 2026-08-01 : `2026-08-01T23:46:21.5690920+02:00`.
 * ⚠️ Garde la chaine TELLE QUELLE (token opaque). Ne pas la reparser en Date : la valeur ne sert
 *    qu'a l'egalite, et un aller-retour Date perdrait des chiffres (7 decimales cote Windows).
 */
export function parseWindowsCreationDate(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
  return m ? m[0] : null;
}

/**
 * macOS/BSD — `ps -p <pid> -o lstart=` ⇒ `Fri Aug  1 23:46:21 2026`.
 * ⚠️ Espaces MULTIPLES quand le jour tient sur un chiffre : on normalise pour que deux lectures
 *    du meme process donnent exactement la meme chaine (sinon l'egalite echoue au hasard).
 */
export function parseLstart(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

/**
 * Les deux identites designent-elles LE MEME process ?
 *
 * ⚠️ FAILS-CLOSED : une identite INCONNUE (`null`) ne matche JAMAIS. Un appelant qui n'a pas pu
 *    lire le starttime doit s'abstenir de tuer, jamais tuer « au cas ou ». C'est la regle
 *    « aucune action destructive derriere une inference » appliquee ici.
 * ⚠️ Egalite STRICTE de chaines. Pas de tolerance, pas d'approximation temporelle : deux lectures
 *    du meme process rendent la meme valeur, un process different rend autre chose.
 */
export function identityMatches(a, b) {
  // ⚠️ Ecrit en UNE expression : tester `b` separement etait REDONDANT (si `a === b` et que `a` est
  // une chaine non vide, alors `b` l'est aussi). La mutation l'a montre — 5 mutants survivants
  // etaient des gardes que rien ne pouvait distinguer. Une garde qu'aucun test ne peut faire
  // echouer n'est pas une securite : c'est du code mort qui donne l'illusion d'en etre une.
  return typeof a === 'string' && a !== '' && a === b;
}

/**
 * Peut-on tuer ce pid en toute surete ?
 * @param {string|null} recorded identite enregistree au spawn
 * @param {string|null} current identite lue MAINTENANT pour ce pid
 * @returns {boolean} true UNIQUEMENT si c'est prouve etre le meme process
 */
export function safeToKill(recorded, current) {
  return identityMatches(recorded, current);
}
