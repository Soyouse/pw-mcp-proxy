// 🛑 GARDE-FOU FAILS-CLOSED : une fixture NE DOIT JAMAIS pouvoir tourner hors d'un test.
//
// LA PANNE QU'IL SUPPRIME (vécue le 02/08/2026) : une fixture lancée A LA MAIN pour une sonde
// rapide — hors `harness.js`, donc invisible du ratchet anti-fuite — a survécu une heure en
// écoutant un port. Elle ne consommait presque rien : c'est PIRE, personne ne l'aurait jamais vue.
// Toute la discipline du harnais (marqueur + traque + ratchet) est CONTOURNÉE dès qu'un humain (ou
// un agent) tape `node tests/fixtures/...` directement. Une consigne ne ferme pas ce trou ; un
// refus au démarrage, si.
//
// COMMENT C'EST EXACT, ET NON UNE DEVINETTE : `harness.spawnTracked` pose `PWMCP_TEST` dans
// l'ENVIRONNEMENT, et l'environnement est HÉRITÉ par tout l'arbre — proxy → daemon → gardien →
// fixture. Sa présence est donc un FAIT : « je descends d'un test ». Son absence aussi.
// ⚠️ NE JAMAIS remplacer par une heuristique (nom du process parent, cwd, NODE_ENV…) : ce serait
// remettre de l'inférence là où on a une preuve.
//
// ÉCHAPPATOIRE VOLONTAIRE : `PWMCP_FIXTURE_MANUELLE=1` pour un diagnostic assumé. Elle exige un
// GESTE EXPLICITE — on ne peut plus laisser un zombie par simple distraction.

import process from 'node:process';

/**
 * Sort IMMÉDIATEMENT si ce process ne descend pas d'un test.
 * ⚠️ Appeler EN TÊTE de fixture, AVANT d'ouvrir le moindre port ou descripteur : le but est qu'il
 * n'y ait rien à nettoyer, jamais quelque chose à fermer proprement.
 * @param {string} nom nom de la fixture, pour un message qui dit quoi faire
 */
export function exigerSousTest(nom) {
  if (process.env.PWMCP_TEST || process.env.PWMCP_FIXTURE_MANUELLE === '1') return;
  process.stderr.write(
    `${nom} : REFUS de démarrer hors test.\n` +
      `  Cette fixture ne s'exécute que sous tests/harness.js, qui la traque et la tue.\n` +
      `  Lancée à la main, elle survivrait indéfiniment sans que rien ne la voie.\n` +
      `  Diagnostic assumé ? PWMCP_FIXTURE_MANUELLE=1 node ${nom} ...\n`
  );
  process.exit(3); // code DISTINCT : ni 0 (succès), ni 1/2 (erreurs d'usage), pour être reconnaissable
}
