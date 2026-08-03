// janitor-pure.js — LA DÉCISION du concierge (aucune I/O). Posé le 03/08/2026.
//
// 🛑 CE MODULE DÉCIDE DE TUER DES PROCESS. Il est donc écrit comme une RÈGLE EXACTE, jamais comme
// une heuristique — la doctrine du dépôt interdit toute action destructive derrière une inférence.
//
// ═══ POURQUOI IL PEUT EXISTER AUJOURD'HUI, ET PAS AVANT ═══
// « Ce process a-t-il encore un propriétaire ? » était INDÉCIDABLE à l'ère du registre fichier :
// on ne pouvait que SUPPOSER (« ce heartbeat est vieux, il est sans doute mort »), et c'est
// exactement ce qui a produit deux pannes en deux jours. Depuis le daemon unique, la propriété est
// CALCULABLE :
//     le daemon est le PARENT de tous les serveurs · chaque serveur a un gardien ·
//     chaque client est une socket comptée par le NOYAU.
// ⇒ tout process à nous qui n'est rattaché à AUCUN daemon vivant n'a, par construction, aucun
//   propriétaire possible. Ce n'est plus une estimation, c'est une déduction.
//
// ═══ LA RÈGLE, ET SA MOITIÉ LA PLUS IMPORTANTE ═══
// 🛑 **DAEMON VIVANT ⇒ ON NE TOUCHE À RIEN. ZÉRO EXCEPTION.**
// Ce n'est pas de la prudence, c'est de la rigueur : sans le lien de parenté (indisponible de façon
// portable — il faudrait /proc sous Linux et WMI sous Windows), on ne peut PAS distinguer les
// enfants de CE daemon de ceux d'un autre agent. Tuer là serait la régression P0-inverse déjà
// vécue : le boot-sweep large qui abattait le serveur d'un agent voisin en plein travail.
// ⚠️ NE JAMAIS « améliorer » ce module en le faisant agir quand un daemon vit. Le cas qu'il couvre
// — daemon mort, serveurs survivants — est précisément celui qui a produit les 6 orphelins mesurés
// le 03/08, et il se referme entièrement sans jamais avoir besoin de juger un process vivant.

import { normPath } from './prockill-pure.js';

// Le gardien est un fichier À NOUS : son nom dans une cmdline est une signature, pas un indice.
// ⚠️ Ne JAMAIS élargir à `node` ni `npx` : ce serait tuer des process étrangers.
const SIGNATURE_GARDIEN = 'child-guard.js';

/**
 * Quels process tuer ? Fonction TOTALE et déterministe : mêmes entrées ⇒ mêmes sorties, jamais
 * de throw (un concierge qui tombe laisse la machine sale sans le dire).
 *
 * @param {{daemonVivant?:boolean, processus?:Array<{pid:number,cmd:string}>, uddNeedles?:string[], selfPid?:number}} [faits]
 *   ⚠️ `daemonVivant` est OPTIONNEL et vaut `true` par défaut — c'est-à-dire **ne rien tuer**.
 *   Un appel malformé ou incomplet doit produire l'INACTION, jamais un balayage : c'est la forme
 *   fails-closed appliquée jusque dans la signature.
 *   `daemonVivant` — FAIT observé par l'appelant en interrogeant le NOYAU (le canal est-il pris ?),
 *   jamais un horodatage ni un heartbeat.
 *   `uddNeedles` — les `--user-data-dir` de NOS profils. ⚠️ Le Chrome PERSONNEL vit sous
 *   `AppData\...\User Data` : il ne peut pas matcher. C'est la seule chose qui sépare « nettoyer »
 *   de « fermer le navigateur de l'utilisateur ».
 * @returns {number[]} PIDs à tuer, ordre stable, sans doublon
 */
export function victimesConcierge(faits = {}) {
  const { daemonVivant = true, processus = [], uddNeedles = [], selfPid = 0 } = faits || {};
  // 🛑 LA GARDE PRINCIPALE (cf en-tête). Fails-CLOSED : en l'absence d'information, on ne tue rien.
  if (daemonVivant) return [];

  const aiguilles = (uddNeedles || []).map(normPath).filter(Boolean);
  const vus = new Set();
  const out = [];
  for (const p of processus || []) {
    if (!p || typeof p.pid !== 'number' || p.pid === selfPid || vus.has(p.pid)) continue;
    const c = normPath(p.cmd);
    // Deux signatures, toutes deux INFALSIFIABLEMENT nôtres : un de nos user-data-dir, ou notre
    // propre fichier gardien. ⚠️ Un process qui ne porte NI l'un NI l'autre n'est pas à nous —
    // on n'a rien à en dire, et surtout rien à en faire.
    if (aiguilles.some((n) => c.includes(n)) || c.includes(SIGNATURE_GARDIEN)) {
      vus.add(p.pid);
      out.push(p.pid);
    }
  }
  return out;
}
