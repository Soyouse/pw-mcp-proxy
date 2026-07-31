// deadline.js — PUR : course entre une promesse et une echeance.
//
// ⚠️ RAISON D'ETRE (incident 2026-07-31) : `initialize` attendait le backend SANS BORNE. Le repli
// degrade existait deja dans router.js, mais il ne se declenchait que sur un REJET — JAMAIS sur la
// LENTEUR. Resultat : le backend mettait ~40 s a demarrer, le client raccrochait a 30 s, et comme un
// serveur stdio n'est jamais reconnecte automatiquement, la session etait MORTE jusqu'a une action
// humaine. Meme classe d'erreur que le bug deja repare dans http-transport (« attendait SANS BORNE ») :
// la lecon avait ete appliquee aux requetes EN VOL, jamais au HANDSHAKE.
//
// ⚠️ CE MODULE EST LE POINT UNIQUE DE CETTE COURSE. NE JAMAIS re-ecrire un `setTimeout` de course
// ailleurs (router, manager...) : une deuxieme copie derive, et c'est le retour du couplage implicite.
//
// ⚠️ `delay` est INJECTE (defaut = setTimeout) : c'est ce qui rend le module DETERMINISTE en test
// (aucun faux timer, aucune attente reelle) donc mutation-testable. NE PAS lire l'horloge ici.

// Etat rendu au caller. Forme STABLE et exhaustive : `ok` tranche, `value` n'existe que si ok.
// On ne rejette JAMAIS sur echeance (une echeance n'est pas une erreur : c'est une decision de repli).
const TIMED_OUT = Object.freeze({ ok: false });

// Attend `promise` au plus `ms`. Rend {ok:true, value} si elle gagne, {ok:false} si l'echeance gagne
// OU si la promesse REJETTE (les deux menent au meme repli degrade cote appelant : pas de backend
// exploitable maintenant). Le caller n'a donc qu'UN chemin de repli a ecrire, pas deux.
//
// ⚠️ La promesse perdante n'est PAS annulee (rien n'est annulable en JS) : elle continue en arriere-plan,
// ce qui est VOULU — le backend finit de demarrer pendant que le client a deja recu sa reponse degradee.
// Son rejet eventuel est neutralise (catch no-op) pour ne JAMAIS produire d'unhandledRejection tardif
// qui tuerait le proxy longtemps apres coup, sur une promesse dont plus personne n'attend le resultat.
export function withDeadline(promise, ms, { delay = defaultDelay } = {}) {
  const settled = Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    () => TIMED_OUT
  );
  return Promise.race([settled, delay(ms).then(() => TIMED_OUT)]);
}

// Timer par defaut. `unref()` quand il existe : un timer de course NE DOIT JAMAIS retenir l'event loop
// (sinon le proxy refuserait de s'arreter tant qu'une echeance court). Absent hors Node => ignore.
//
// ⚠️ `timer` est INJECTABLE pour la MEME raison que `delay` l'est dans withDeadline : sans cette
// couture, le corps de cette fonction n'est exerce par AUCUN test deterministe (les tests injectent
// tous leur propre `delay`) — Stryker y laissait donc 7 mutants VIVANTS, dont « setTimeout(resolve, 0) »
// (echeance instantanee = tout repondrait DEGRADE) et la disparition du `unref()` (le proxy refuserait
// de s'arreter tant qu'une echeance court). Deux regressions graves, invisibles sans cette injection.
// ⚠️ La PROD n'override JAMAIS : le defaut EST le comportement. NE PAS retirer cette couture pour
// « simplifier » — ce serait re-aveugler la mutation sur la seule partie non deterministe du module.
export function defaultDelay(ms, { timer = setTimeout } = {}) {
  return new Promise((resolve) => {
    const t = timer(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}
