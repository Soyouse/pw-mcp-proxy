// auto-restart.js — PUR : decision d'auto-restart d'un profil sur backend FIGE (COUCHE 2b du bug de
// GEL, cf memory reference-browser-mcp-freeze-bug + BACKLOG.md). Isole de l'I/O (le manager fait le
// restart REEL) => Stryker + property-based.
//
// MODELE : `recentTimestamps` = horodatages (ms epoch) des auto-restarts DEJA declenches pour CE
// profil (historique porte par le manager, une entree par restart reussi). shouldAutoRestart decide
// si UN restart supplementaire est autorise MAINTENANT (`now`), en comptant seulement les timestamps
// dans la fenetre glissante [now - windowMs, now] (anti-boucle : au-dela de maxRestarts dans la
// fenetre, on REFUSE => le dead-man (alert) prend le relais au lieu de boucler en silence).
//
// PUR : aucune horloge lue ici (now = parametre), aucun I/O, deterministe.

export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_WINDOW_MS = 300000; // 5 min

// shouldAutoRestart(recentTimestamps, now, {maxRestarts, windowMs}) => boolean
// true  <=> nombre de timestamps DANS la fenetre [now-windowMs, now] est STRICTEMENT < maxRestarts.
// Timestamps hors fenetre (trop vieux) => ignores (pas de fuite memoire logique : c'est le manager
// qui purge l'historique, cette fonction se contente de ne PAS les compter).
export function shouldAutoRestart(recentTimestamps, now, options = {}) {
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const list = Array.isArray(recentTimestamps) ? recentTimestamps : [];
  const windowStart = now - windowMs;
  const inWindow = list.filter((t) => typeof t === 'number' && t >= windowStart && t <= now).length;
  return inWindow < maxRestarts;
}
