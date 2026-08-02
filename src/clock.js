// Horloge MONOTONE partagee entre process de la meme machine.
//
// POURQUOI (faille trouvee par simulation le 2026-08-01) : le registre horodatait avec
// `Date.now()` — l'horloge MURALE. Elle SAUTE (correction NTP, passage heure d'ete, reglage
// manuel). Consequences sur un service qui tourne des mois :
//   saut en AVANT  ⇒ tous les serveurs paraissent idle depuis longtemps ⇒ **massacre general**
//   saut en ARRIERE ⇒ plus rien n'atteint jamais son TTL ⇒ **plus aucun nettoyage**
// Les deux sont silencieux. Sur un poste qui redemarre souvent ca ne se voit pas ; sur des mois,
// c'est une certitude.
//
// ⚠️ `os.uptime()` et NON `performance.now()` : il faut une reference COMMUNE A TOUS LES PROCESS
//    de la machine (le registre est partage entre les proxys). `performance.now()` part de zero
//    a chaque process — inutilisable pour comparer des horodatages ecrits par un AUTRE process.
// ⚠️ NE JAMAIS remettre `Date.now()` dans un horodatage PERSISTE. Pour un affichage humain (log),
//    l'heure murale reste la bonne chose ; pour une DECISION, jamais.

import os from 'node:os';

/**
 * Millisecondes ecoulees depuis le demarrage de la machine.
 *
 * ⚠️ RESOLUTION DEPENDANTE DE L'OS — MESUREE en CI le 2026-08-02 : Linux lit `/proc/uptime`
 *    (centiemes de seconde), mais **macOS derive de `kern.boottime` et ne bouge que toutes les
 *    SECONDES**. Deux evenements de la meme seconde y portent donc le MEME horodatage.
 *    Sans effet en production (les TTL sont de l'ordre de la minute), mais RHEDIBITOIRE pour un
 *    test qui veut un TTL de quelques ms ⇒ le Supervisor prend une horloge INJECTABLE, et les
 *    tests fournissent la leur. NE PAS « corriger » en melangeant une horloge fine locale : elle
 *    ne serait plus comparable entre process, ce qui est toute la raison d'etre de ce module.
 * Monotone (ne recule jamais), commune a tous les process locaux, immunisee NTP/DST.
 * @returns {number} entier
 */
export function monotonicNow() {
  return Math.round(os.uptime() * 1000);
}

// Seuil separant un horodatage MONOTONE (ms depuis le boot) d'un horodatage MURAL (ms depuis 1970).
// ⚠️ Ce n'est PAS un reglage arbitraire : `Date.now()` vaut ~1.7e12 en 2026, tandis qu'un uptime
// n'atteindrait 1e12 ms qu'apres **31 ANS** de fonctionnement continu. Les deux domaines ne peuvent
// pas se recouvrir. NE PAS transformer ce seuil en option configurable : il n'y a rien a regler.
export const WALL_CLOCK_FLOOR = 1e12;

/**
 * Cet horodatage vient-il de l'heure MURALE (registre ecrit avant la migration du 2026-08-02) ?
 * ⚠️ Distinguer legacy et pre-reboot est NECESSAIRE, pas cosmetique — les traitements sont opposes :
 *    legacy      ⇒ CONVERTIR (les process peuvent etre VIVANTS ; les oublier = orphelins a vie)
 *    pre-reboot  ⇒ VIDER (aucun process ne survit a un redemarrage : c'est un fait)
 *    Confondre les deux ferait fuir des serveurs le jour de la mise a jour, en silence.
 */
export function isWallClock(t) {
  // ⚠️ `Number.isFinite` NE COERCE PAS (contrairement au `isFinite` global) : il rejette deja
  // chaine, null, undefined et objet. Un `typeof` en plus etait un mutant equivalent, pas une garde.
  return Number.isFinite(t) && t >= WALL_CLOCK_FLOOR;
}

/**
 * Ce registre a-t-il ete ecrit AVANT le dernier redemarrage de la machine ?
 *
 * ⚠️ CE N'EST PAS UNE INFERENCE, c'est un FAIT : un horodatage superieur a l'uptime courant ne
 *    peut avoir ete produit que par un boot PRECEDENT (l'uptime repart de zero au demarrage).
 *    Et aucun process ne survit a un redemarrage — donc toutes les entrees sont mortes, sans
 *    exception et sans avoir a le verifier.
 * ⚠️ Le format legacy (horodatages en heure murale, ~1.7e12) est detecte par la MEME regle : il
 *    depasse forcement un uptime plausible. Pas besoin d'un second mecanisme de migration.
 *
 * @param {number[]} stamps horodatages lus dans le registre
 * @param {number} now uptime courant en ms (INJECTE : la fonction reste pure)
 */
export function isStaleBoot(stamps, now) {
  if (!Array.isArray(stamps)) return false;
  return stamps.some((t) => Number.isFinite(t) && t > now); // isFinite ne coerce pas : garde suffisante
}
