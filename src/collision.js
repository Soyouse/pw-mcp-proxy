// collision.js — garde anti-collision de noms de tools. PUR (aucune I/O) => testable + mutable.
//
// Le proxy INJECTE 3 tools maison (switch/current/restart_profile) a cote des tools du backend.
// Si une update @playwright/mcp sortait un tool du MEME nom, notre injection le masquerait EN
// SILENCE (ou creerait un doublon ambigu). Cette garde DETECTE la collision pour :
//   1) la SIGNALER a l'operateur (log + NTFY, cf notify.js) ;
//   2) degrader proprement : nos tools passent sous le prefixe `proxy_` (le tool backend garde
//      son nom nu => le passthrough reste integre, on ne casse JAMAIS une update Microsoft).
//
// ⚠️ Source UNIQUE des noms injectes = INJECTED_TOOL_NAMES. router.js DOIT deriver de cette
// liste (jamais re-hardcoder les 3 noms ailleurs) sinon derive silencieuse (ajout d'un 4e tool
// non protege). NE PAS dupliquer ces litteraux.

export const INJECTED_TOOL_NAMES = ['switch_profile', 'current_profile', 'restart_profile'];
export const FALLBACK_PREFIX = 'proxy_';

// Noms du backend qui entrent en collision avec nos tools injectes (dedupliques, ordre stable).
export function detectCollisions(backendToolNames, injected = INJECTED_TOOL_NAMES) {
  const inj = new Set(injected);
  const seen = new Set();
  const out = [];
  for (const n of backendToolNames || []) {
    if (inj.has(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// Nom canonique de l'action interceptee, en acceptant le prefixe de repli.
// 'switch_profile' -> 'switch_profile' ; 'proxy_switch_profile' -> 'switch_profile' ; sinon null.
// => l'interception marche que le tool soit expose sous son nom nu OU sous proxy_ (apres collision).
export function canonicalInjectedName(name, injected = INJECTED_TOOL_NAMES) {
  if (!name) return null;
  if (injected.includes(name)) return name;
  if (name.startsWith(FALLBACK_PREFIX)) {
    const bare = name.slice(FALLBACK_PREFIX.length);
    if (injected.includes(bare)) return bare;
  }
  return null;
}

// Nom sous lequel exposer un de nos tools compte tenu des collisions detectees.
// Sans collision sur ce nom -> nom nu ; avec collision -> prefixe `proxy_` (cede la place au backend).
export function exposedName(canonical, collisions) {
  return (collisions || []).includes(canonical) ? FALLBACK_PREFIX + canonical : canonical;
}

// Decide si un appel tools/call vise NOTRE tool maison (vs le tool backend homonyme en collision).
// A nous ssi : appel via le repli `proxy_<name>` (toujours a nous), OU nom nu d'une action injectee
// SANS collision. Nom nu EN collision => tool backend => passthrough (return false).
// ⚠️ CRITIQUE : sans ce filtre, on intercepterait le tool backend homonyme = casse le passthrough.
export function isOurToolCall(rawName, collisions = [], injected = INJECTED_TOOL_NAMES) {
  const canonical = canonicalInjectedName(rawName, injected);
  if (!canonical) return false;
  if (rawName.startsWith(FALLBACK_PREFIX)) return true;
  return !(collisions || []).includes(canonical);
}
