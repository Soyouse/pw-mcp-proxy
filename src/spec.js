// spec.js — construction de la commande backend d'un profil. PUR => testable + mutable.
// C'est la DECISION « quels args passer a @playwright/mcp » (caps, isolated, user-data-dir v1,
// proxy-server, override backend, args libres). Isolee de toute I/O (spawn) pour passer au crible Stryker.
//
// ⚠️ NE construit PAS --host/--port : ce sont des valeurs RUNTIME. Le port est ALLOUE PAR L'OS
// (`port-alloc.js`) puis ajoute aux args par le DAEMON (`server-daemon.js`), qui est le seul a le
// connaitre — il le garde en memoire, il n'y a plus aucun registre. buildSpec = tout SAUF le port.
//
// ⚠️ NE construit PAS NON PLUS le `--user-data-dir` d'une INSTANCE (profil v2 `identity`) : le
// dossier d'instance est lui aussi une valeur RUNTIME — il n'existe qu'une fois que le daemon a
// MATERIALISE l'identite (copie du snapshot vers un dossier neuf, cf `identity-store.js`). Le
// daemon l'ajoute exactement comme il ajoute le port. Seul le profil v1 (`userDataDir`, dossier
// FIXE connu d'avance) le porte ici, pour que le transport stdio (tests, client unique) reste
// utilisable sans daemon.

export const DEFAULT_BACKEND = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };

// 🛑 TOUJOURS PRESENTE : les outils `browser_storage_state` / `browser_set_storage_state` sont
// opt-in cote @playwright/mcp (`--caps=storage`, doc 0.0.78 §Storage) et ce sont EUX qui font
// naitre/exporter une identite. Un serveur sans cette cap ne peut ni sauver ni charger un compte.
// Mesure le 04/09/2026 : le proxy tournait en `caps: []` et les outils d'identite etaient
// simplement ABSENTS de la surface — invisible tant qu'on n'en avait pas besoin.
export const CAP_OBLIGATOIRE = 'storage';

// ═══ `playwrightConfig` = LE FICHIER `--config` OFFICIEL de @playwright/mcp, par profil (05/09/2026) ═══
// Schema = `config.d.ts` du paquet installe (0.0.80) : `browser.launchOptions` (= playwright.LaunchOptions,
// donc `args: string[]` = N'IMPORTE QUEL flag Chrome), `browser.contextOptions` (locale, timezoneId,
// viewport, userAgent…), `network`, `timeouts`, `console`, `outputDir`… On transmet l'objet TEL QUEL
// (aucun dialecte maison : le contrat est celui de l'editeur), sauf ce qui entre en CONFLIT avec ce
// que le proxy decide LUI-MEME. Ces cles sont REFUSEES, nommees, jamais ecrasees en silence :
//   - `server` (host/port/allowedHosts) : le daemon alloue le port et fixe l'hote ;
//   - `capabilities` : `--caps` (avec `storage` obligatoire) ;
//   - `sharedBrowserContext` : INTERDIT (collision mesuree 04/09) ; `extension` : autre mode ;
//   - `browser.userDataDir` / `browser.isolated` : le dossier d'INSTANCE est une valeur runtime ;
//   - `browser.cdpEndpoint` / `browser.remoteEndpoint` : le navigateur serait ailleurs.
// POURQUOI c'est une exigence et pas un confort : c'est le SEUL endroit ou l'on fixe la langue, le
// fuseau horaire et l'ecran d'une identite. Un compte francais en fuseau UTC sur un ecran de serveur
// est un employe virtuel qui sent le robot. L'empreinte est un attribut de l'IDENTITE.
const CLES_RESERVEES = Object.freeze(['server', 'capabilities', 'sharedBrowserContext', 'extension']);
const CLES_BROWSER_RESERVEES = Object.freeze(['userDataDir', 'isolated', 'cdpEndpoint', 'remoteEndpoint']);

/**
 * Verdict sur un `playwrightConfig`. Fonction TOTALE : rend un objet JSON PLAT (clone) ou un refus nomme.
 * @param {unknown} cfg
 * @returns {{ok:true, configuration:object}|{ok:false, raison:string}}
 */
export function verdictConfiguration(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, raison: 'playwrightConfig doit etre un objet (schema config.d.ts de @playwright/mcp)' };
  const reservee = CLES_RESERVEES.find((k) => k in cfg);
  if (reservee) return { ok: false, raison: `playwrightConfig.${reservee} est decide par le proxy (interdit dans le fichier)` };
  const b = /** @type {{browser?:unknown}} */ (cfg).browser;
  if (b !== undefined) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, raison: 'playwrightConfig.browser doit etre un objet' };
    const rb = CLES_BROWSER_RESERVEES.find((k) => k in b);
    if (rb) return { ok: false, raison: `playwrightConfig.browser.${rb} est decide par le proxy (dossier d'instance / mode)` };
    const lo = /** @type {{launchOptions?:{args?:unknown}}} */ (b).launchOptions;
    if (lo && lo.args !== undefined && !(Array.isArray(lo.args) && lo.args.every((a) => typeof a === 'string'))) {
      return { ok: false, raison: 'playwrightConfig.browser.launchOptions.args doit etre un tableau de chaines (flags Chrome)' };
    }
  }
  // Clone JSON : ce qui part au daemon est une DONNEE, jamais une reference partagee.
  return { ok: true, configuration: JSON.parse(JSON.stringify(cfg)) };
}


// Ordre des args VOLONTAIRE et STABLE : base backend, --caps, PUIS soit --isolated soit --user-data-dir
// (v1 seulement), PUIS --proxy-server, puis args libres. NE PAS reordonner (le hot-reload compare
// `JSON.stringify(args)` pour decider d'un respawn : un reordre changerait la signature et
// provoquerait des respawns fantomes).
//
// isolated (profil anonyme EN MEMOIRE) et userDataDir/identity (profil persistant) sont MUTUELLEMENT
// EXCLUSIFS : isolated l'emporte. ⚠️ `--isolated` est CONSERVE (aucune capacite retiree) mais n'est
// PLUS le mode du parallelisme : mesure le 04/09/2026 avec detectincognitojs@1.9.0, un contexte
// isole est DETECTE comme navigation privee (stockage en memoire ⇒ ecritures IndexedDB
// `durability:'strict'` sans cout de fsync — propriete PHYSIQUE, aucun flag ne la maquille).
// Le parallelisme = une INSTANCE persistante jetable par client (profil v2 `identity`).
//
// 🛑 `--shared-browser-context` N'EXISTE PLUS ICI, ET NE DOIT JAMAIS REVENIR (gate statique).
// Il ne servait qu'a contourner « Browser is already in use » entre N clients d'UN serveur
// partage ; mesure le 04/09/2026 : avec lui, deux agents ECRASENT mutuellement leur page (B navigue,
// A voit la page de B — c'est la collision du 03/09). Il n'y a plus de serveur partage : chaque
// client a son instance, la question ne se pose plus.
export function buildSpec(profile, profileCfg, globalCfg = {}, opts = {}) {
  const p = profileCfg || {};
  const g = globalCfg || {};
  const backend = p.backend || g.backend || DEFAULT_BACKEND;
  const args = [...(backend.args || [])];
  // caps : override par profil sinon global, PUIS la cap obligatoire (dedoublonnee, en dernier :
  // les caps de l'utilisateur gardent leur ordre, la signature ne bouge pas quand il n'en a pas).
  const capsUtilisateur = Array.isArray(p.caps) ? p.caps : Array.isArray(g.caps) ? g.caps : [];
  const caps = capsUtilisateur.includes(CAP_OBLIGATOIRE) ? capsUtilisateur : [...capsUtilisateur, CAP_OBLIGATOIRE];
  args.push(`--caps=${caps.join(',')}`);
  if (p.isolated) {
    args.push('--isolated');
  } else if (p.userDataDir && !p.identity) {
    // v1 : dossier FIXE, connu d'avance (un seul navigateur a la fois : SingletonLock de Chrome).
    args.push('--user-data-dir', p.userDataDir);
  }
  // Sortie reseau = attribut de l'IDENTITE (un profil = une identite), jamais de l'agent. Flag
  // officiel `--proxy-server <proxy>` (doc 0.0.78 : "http://myproxy:3128" ou "socks5://…").
  if (typeof p.proxyServer === 'string' && p.proxyServer.length > 0) args.push('--proxy-server', p.proxyServer);
  if (Array.isArray(p.args)) args.push(...p.args);
  // `configuration` = le contenu du fichier `--config` (profil > global), deja VALIDE par l'appelant
  // (manager `_loadConfig`, fails-closed) ; le chemin du fichier est une valeur RUNTIME ecrite par le
  // daemon a cote de l'instance, comme `--user-data-dir`. `null` = pas de fichier, pas de flag.
  const configuration = p.playwrightConfig !== undefined ? p.playwrightConfig : g.playwrightConfig !== undefined ? g.playwrightConfig : null;
  return { command: backend.command, args, label: p.label || profile, configuration };
}
