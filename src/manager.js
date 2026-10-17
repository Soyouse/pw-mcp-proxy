// Manager = config (profiles.json) + pool de backends + profil actif.
// Hot-reload par mtime : ajouter/retirer un profil ne demande AUCUN restart.
// SCALABILITE : un profil peut surcharger `backend` (command/args) -> le proxy
// multiplexe N'IMPORTE quel serveur MCP par profil, pas seulement Playwright.
// Zero refactoring pour repurposer : c'est de la donnee, pas du code.

import fs from 'node:fs';
import process from 'node:process';
import { Backend } from './backend.js';
import { StdioTransport } from './stdio-transport.js';
import { HttpTransport } from './http-transport.js';
import { log } from './logger.js';
import { alert } from './notify.js';
import { sweepByCmd, listProcesses } from './prockill.js';
import { buildSpec, verdictConfiguration } from './spec.js';
import { shouldAutoRestart, DEFAULT_MAX_RESTARTS, DEFAULT_WINDOW_MS } from './auto-restart.js';
import { formatFreezeReport } from './freeze-report.js';
// ⚠️ Le DAEMON remplace le superviseur : le ref-count est tenu par le NOYAU (socket ouverte),
// plus par un registre fichier + heartbeat + TTL. Cf src/server-daemon.js pour le POURQUOI.
import { acquerirProfil } from './daemon-client.js';
// Identite (profil v2) : alphabet du nom + liste FERMEE des strategies, decides dans le module PUR.
import { STRATEGIES, nomIdentiteValide, cheminsCoffre } from './identity-store-pure.js';
import { verdictBindHost } from './bind-host-pure.js';
import path from 'node:path';
import os from 'node:os';
// ⚠️ SOURCE UNIQUE des delais (budget.js) — NE JAMAIS redeclarer une duree ici.
import { surveillerConfig } from './config-watch.js';
import { empreinte } from './config-watch-pure.js';
// ⚠️ describeError : JAMAIS `e.message` seul (il peut etre VIDE — incident 01/08).
import { describeError } from './error-detail.js';
// ⚠️ SOURCE UNIQUE du repli de version MCP (3 copies avant l'audit du 03/08).
import { PROTOCOL_FALLBACK } from './protocol.js';

const STRATEGIES_VALIDES = new Set(STRATEGIES);

const DEFAULT_CLIENT_INFO = {
  protocolVersion: PROTOCOL_FALLBACK,
  capabilities: {},
  clientInfo: { name: 'pw-mcp-proxy', version: '1.0.0' },
};

export class Manager {
  // options.watchdog = passe tel quel a `new Backend(...)` (ping*/maxMissedPings, INJECTABLE pour
  // des tests rapides ; defauts prod = ceux de backend.js si omis).
  // options.autoRestart = {maxRestarts, windowMs} passe a shouldAutoRestart (garde anti-boucle,
  // COUCHE 2b) ; defauts prod = auto-restart.js (3 restarts / 5 min) si omis.
  constructor(configPath, options = {}) {
    this.configPath = configPath;
    this.config = null;
    this.backends = new Map(); // profile -> Backend
    this.activeProfile = null;
    // ⚠️ L'environnement est INJECTABLE (tests) ; defaut = celui du process. C'est lui qui porte
    // `PW_MCP_PROFILE`, l'EPINGLAGE d'identite d'un proxy (cf _loadConfig).
    this._env = options.env || process.env;
    // Env transmis au CLIENT du daemon (nom du canal) : `{}` = le canal de l'utilisateur (prod).
    // Injectable pour qu'un test LIVE lance SON daemon (code de ce depot) et jamais celui de l'operateur.
    this._daemonEnv = options.daemonEnv || {};
    /** profile -> instanceId rendu par le daemon (observabilite : current_profile) */
    this._instanceIds = new Map();
    this.clientInfo = { ...DEFAULT_CLIENT_INFO }; // remplace au handshake Claude
    this.onNewBackend = null; // set par le Router (wiring des events)
    this.onConfigChange = null; // set par le Router (re-emet tools/list_changed)
    this._watchdogOptions = options.watchdog || {};
    this._autoRestartOptions = {
      maxRestarts: options.autoRestart?.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      windowMs: options.autoRestart?.windowMs ?? DEFAULT_WINDOW_MS,
    };
    this._restartHistory = new Map(); // profile -> number[] timestamps des auto-restarts declenches (anti-boucle)
    // 🛑 profile -> socket vers le DAEMON. CETTE SOCKET **EST** LE REF-COUNT : tant qu'elle vit, le
    // daemon sait que CE proxy utilise ce profil. La fermer = « je n'en ai plus besoin » (evenement
    // du NOYAU, delivre meme sur kill -9). NE JAMAIS la fermer apres avoir lu l'URL.
    this._connexions = new Map();
    this._loadConfig();
    this._watch();
  }

  // Un profil est en mode HTTP (serveur @playwright/mcp partage ref-compte, MULTI-AGENT) si son
  // flag `http` OU le flag global `http` est vrai. Defaut = stdio (retro-compatible : profils/tests
  // existants inchanges). C'est le point de bascule expand/contract : les deux transports coexistent.
  _isHttp(profile) {
    const p = this.config.profiles[profile] || {};
    return p.http !== undefined ? !!p.http : !!this.config.http;
  }

  /**
   * Charge et VALIDE la config. `texte` absent = lecture disque (boot) ; present = contenu deja lu par
   * la surveillance (config-watch.js), qui n'avance son empreinte QUE si cette methode ne throw pas.
   * @param {string} [texte]
   */
  _loadConfig(texte) {
    const brut = texte === undefined ? fs.readFileSync(this.configPath, 'utf8') : texte;
    if (texte === undefined) this._configHash = empreinte(brut); // empreinte du contenu charge au boot
    const cfg = JSON.parse(brut);
    if (!cfg.profiles || typeof cfg.profiles !== 'object' || !Object.keys(cfg.profiles).length)
      throw new Error('profiles.json: "profiles" manquant ou vide');
    if (!cfg.defaultProfile || !cfg.profiles[cfg.defaultProfile])
      throw new Error('profiles.json: "defaultProfile" invalide');
    // ═══ PROFIL v2 = IDENTITÉ (05/09/2026) — validation FAILS-CLOSED, motif nommé ═══
    // v1 (`userDataDir`, dossier FIXE, un navigateur a la fois) et v2 (`identity`, snapshot dans
    // le coffre, N instances jetables) COEXISTENT (expand/contract) mais JAMAIS sur le meme profil :
    // deux verites pour un dossier = un compte qui se deconnecte en silence.
    // `playwrightConfig` (global et par profil) = fichier --config officiel : cles en conflit REFUSEES au boot.
    if (cfg.playwrightConfig !== undefined) { const v = verdictConfiguration(cfg.playwrightConfig); if ('raison' in v) throw new Error(`profiles.json: ${v.raison}`); }
    for (const [name, p] of Object.entries(cfg.profiles)) {
      if (!p || typeof p !== 'object') throw new Error(`profiles.json: profil "${name}" non-objet`);
      if (p.playwrightConfig !== undefined) { const v = verdictConfiguration(p.playwrightConfig); if ('raison' in v) throw new Error(`profiles.json: profil "${name}" : ${v.raison}`); }
      if (p.identity === undefined) continue;
      if (p.userDataDir !== undefined) throw new Error(`profiles.json: profil "${name}" porte identity ET userDataDir (v1 XOR v2, jamais les deux)`);
      if (p.isolated) throw new Error(`profiles.json: profil "${name}" porte identity ET isolated (une identite est persistante par definition)`);
      if (!nomIdentiteValide(p.identity)) throw new Error(`profiles.json: profil "${name}" : identity "${String(p.identity)}" invalide (alphabet [A-Za-z0-9._-], 1..64, ne commence pas par . ou -)`);
      const strategie = p.strategie ?? 'snapshot';
      // `Set.has` et non `Array.includes` DANS la boucle des profils : le gate de complexite voit une
      // methode de tableau dans un parcours comme un O(N²) (c'est la forme du seul O(N²) mesure du parc).
      if (!STRATEGIES_VALIDES.has(strategie)) throw new Error(`profiles.json: profil "${name}" : strategie "${String(p.strategie)}" hors liste (${STRATEGIES.join('|')})`);
      if (p.persist !== undefined && typeof p.persist !== 'boolean') throw new Error(`profiles.json: profil "${name}" : persist doit etre un booleen`);
      // Une identite n'existe qu'en HTTP : c'est le DAEMON qui materialise (le transport stdio n'a
      // pas de daemon, il ne saurait ni copier ni ranger un snapshot).
      const http = p.http !== undefined ? !!p.http : !!cfg.http;
      if (!http) throw new Error(`profiles.json: profil "${name}" : identity exige le mode http (le daemon materialise l'identite)`);
    }
    // 🛑 `bindHost` : adresse d'ECOUTE des serveurs. Sans authentification cote @playwright/mcp, une
    // adresse routable offrirait un navigateur connecte au reseau ⇒ verdict PUR (bind-host-pure),
    // interfaces MESUREES (os.networkInterfaces), refus NOMME. Cf §6bis du BACKLOG (classe libuv).
    const vb = verdictBindHost(cfg.bindHost, { interfaceDeclaree: cfg.bindHostInterface, interfaces: os.networkInterfaces() });
    if ('raison' in vb) throw new Error(`profiles.json: ${vb.raison}`); // = refus (narrowing par `in`, lisible par tsc)
    this.config = cfg;
    // 🛑 ÉPINGLAGE : `PW_MCP_PROFILE` (env) prime sur `defaultProfile`. C'est la PRIMITIVE du
    // parallelisme : un proxy = une instance ; N entrees MCP epinglees sur N identites = N agents
    // qui ne se volent jamais la page (mesure 03-04/09/2026). Nom inconnu = REFUS NOMME au boot,
    // jamais un repli silencieux sur defaultProfile (un agent travaillerait sous la MAUVAISE identite).
    const epingle = this._env.PW_MCP_PROFILE;
    if (epingle !== undefined && epingle !== '') {
      if (!cfg.profiles[epingle]) {
        const dispo = Object.keys(cfg.profiles).join(', ');
        throw new Error(`PW_MCP_PROFILE="${epingle}" : profil inconnu dans profiles.json (disponibles : ${dispo})`);
      }
      if (!this.activeProfile) this.activeProfile = epingle; // au boot seulement : un switch ulterieur reste souverain
    }
    if (!this.activeProfile || !cfg.profiles[this.activeProfile])
      this.activeProfile = cfg.defaultProfile;
  }

  /**
   * Description d'INSTANCE a transmettre au daemon pour un profil v2, `null` pour un v1/isole.
   * Tout ce que le daemon doit savoir passe ICI (il ne lit aucune config) : identite, strategie,
   * persist, coffre, dossier d'instances, plafonds — SOURCE UNIQUE des defauts de chemins.
   * ⚠️ `identityStore`/`instances` sont des ecrivains DISQUE declares : chemin + plafonds + politique
   * vivent dans profiles.json (defauts ici), l'eviction dans identity-store-pure.js.
   */
  _instanceDe(profile) {
    const p = this.config.profiles[profile] || {};
    if (p.identity === undefined) return null;
    const store = this.config.identityStore || {};
    // ⚠️ `cheminsCoffre` = SOURCE UNIQUE des defauts de chemins, partagee avec le CONCIERGE : deux
    // defauts differents = un concierge qui nettoie a cote (ou chez autrui).
    const { storeDir, instancesDir } = cheminsCoffre(this.config, { homedir: os.homedir(), tmpdir: os.tmpdir() }, path.join);
    return {
      identite: p.identity,
      strategie: p.strategie ?? 'snapshot',
      persist: p.persist ?? true,
      storeDir,
      instancesDir,
      plafonds: { maxParIdentiteMo: store.maxParIdentiteMo, maxTotalMo: store.maxTotalMo, retentionJours: store.retentionJours },
    };
  }

  /** Observabilite (current_profile) : sur quelle INSTANCE ce proxy travaille, et sa nature. */
  instanceInfo(profile) {
    const inst = this._instanceDe(profile);
    return { instanceId: this._instanceIds.get(profile) || null, identite: inst?.identite || null, strategie: inst?.strategie || null, persist: inst ? inst.persist : null, jetable: !!inst && inst.strategie === 'snapshot' };
  }

  // 🛑 HOT-RELOAD : l'OS REVEILLE (fs.watch sur le DOSSIER), le CONTENU DECIDE (empreinte sha256 vs
  // charge). Un evenement double, un antivirus qui touche le fichier, un nom d'evenement absent : tout
  // est absorbe par la comparaison de contenu. Une config invalide est IGNOREE (l'ancienne reste) et
  // son empreinte n'est PAS avancee : elle sera rejugee au prochain reveil. Cf config-watch.js.
  _watch() {
    this._surveillance = surveillerConfig(this.configPath, {
      hashInitial: this._configHash,
      log,
      alerter: (msg) => { log(msg); alert(msg); },
      onContenu: (texte) => {
        this._loadConfig(texte); // throw = refus nomme, empreinte non avancee (config-watch)
        // _reconcile est asynchrone (stop/get de backends) ; sa promesse ne conditionne pas l'acceptation
        // du contenu — un echec de reconciliation se loggue, il n'annule pas une config VALIDE.
        this._reconcile().then(() => {
          log('config rechargee (hot-reload)');
          if (this.onConfigChange) this.onConfigChange();
        }, (e) => log('reconciliation apres hot-reload : ' + describeError(e)));
      },
    });
  }

  // Aligne les backends vivants sur la nouvelle config : profil supprime -> stop ;
  // spec changee (ex: caps, args, userDataDir) -> respawn (le backend actif tout de suite,
  // les autres en lazy au prochain switch). C'est ce qui rend le changement de `caps`
  // effectif a chaud (respawn transparent + le Router emet tools/list_changed).
  async _reconcile() {
    for (const [name, b] of [...this.backends]) {
      if (!this.config.profiles[name]) {
        b.stop();
        this.backends.delete(name);
        this._closeConnexion(name); // http : je ne suis plus client de ce profil (ref-count noyau)
        continue;
      }
      const newSpec = this._spec(name);
      // Signature = args ET configuration (fichier --config) : un changement d'empreinte respawn aussi.
      if (JSON.stringify([newSpec.args, newSpec.configuration]) !== JSON.stringify([b.spec.args, b.spec.configuration])) {
        const wasActive = name === this.activeProfile;
        b.stop();
        this.backends.delete(name);
        // 🛑 RELACHER AVANT DE REPRENDRE — l'inverse EXACT de `setActiveProfile`, et c'est voulu.
        // Ici l'intention est de REDEMARRER le serveur avec la nouvelle spec : garder l'ancienne
        // connexion le maintiendrait vivant, et le daemon nous rendrait le MEME serveur, avec les
        // ANCIENS args. Bug REEL trouve le 02/08 par la matrice de transports : en stdio le child
        // prive respawnait (donc vert), en HTTP le changement de `caps` n'avait JAMAIS lieu.
        // ⚠️ MULTI-AGENT : si un AUTRE agent tient encore ce profil, son serveur SURVIT (refcount)
        // et la nouvelle spec ne s'appliquera qu'a son depart. C'est la bonne semantique — on ne
        // coupe pas le navigateur d'autrui pour un changement de config qui nous concerne.
        this._closeConnexion(name);
        if (wasActive) {
          try {
            await this.get(name); // respawn immediat avec la nouvelle spec
          } catch (e) {
            log(`respawn ${name} echoue: ${describeError(e)}`);
          }
        }
      }
    }
  }

  // Delegue a buildSpec (pur, mutation-teste). Le transport n'est plus une dimension de la spec
  // (05/09/2026 : plus de --shared-browser-context, une instance par client quel que soit le mode).
  _spec(profile) {
    return buildSpec(profile, this.config.profiles[profile], this.config);
  }

  async get(profile) {
    if (!this.config.profiles[profile]) throw new Error(`profil inconnu: ${profile}`);
    let b = this.backends.get(profile);
    if (b && b.ready) return b;
    // Backend EXITE = cadavre (bug live 2026-07-23) : son transport porte une session morte (http :
    // sessionId perime => re-initialize prend un 404 avale par l'idempotence de _onExit => promesse
    // eternelle => appel MCP qui pend 120 s ; stdio : child mort). NE JAMAIS le ranimer : on le purge
    // et on reconstruit backend + transport FRAIS (nouvelle session HTTP via _makeTransport, qui
    // re-acquiert le profil aupres du daemon). stop() = close best-effort (DELETE session, treeKill stdio).
    if (b && b.exited) {
      // LOG SIGNAL (traçabilité incident) : c'est cette ligne qui rend le remplacement VISIBLE dans
      // pw-mcp-proxy.log — le bug du 23/07 n'a été trouvé QUE grâce aux logs. NE PAS la retirer.
      log(`[backend:${profile}] exited => purge du cadavre + respawn (transport/session frais)`);
      b.stop();
      this.backends.delete(profile);
      b = null;
    }
    if (!b) {
      const transport = await this._makeTransport(profile);
      b = new Backend(profile, transport, this._watchdogOptions);
      this.backends.set(profile, b);
      // COUCHE 2b (auto-restart, 0-human) : reagit UNIQUEMENT au gel detecte par le watchdog
      // (sig==='unresponsive', cf _onBackendUnresponsive). Cable AVANT tout message (comme onNewBackend).
      b.on('exit', (code, sig) => this._onBackendUnresponsive(profile, sig, b));
      // FORENSIQUE (0-human : « ne jamais rester dans l'ignorance ») : sur un GEL detecte par le
      // watchdog, ecrire un rapport RICHE (etat process Chrome, requetes en vol) => la prochaine
      // occurrence d'un bug tordu est diagnosticable. Observation SEULE, ne change aucune decision.
      b.on('freeze', (info) => this._logFreezeReport(profile, info));
      if (this.onNewBackend) this.onNewBackend(b); // wiring AVANT tout message
    }
    await b.start(this.clientInfo);
    return b;
  }

  // Auto-restart (0-human, COUCHE 2b du bug de GEL) : recycle SEUL un backend que le watchdog a
  // declare fige, sans attendre que Claude appelle restart_profile a la main.
  // ⚠️ SCOPE STRICT : ne reagit QU'AU gel detecte par le watchdog liveness (backend.js _pingOnce).
  // 'unresponsive' n'est JAMAIS emis ailleurs (grep : seul _onExit(-1,'unresponsive') l'utilise) =>
  // un stop() volontaire (stopAll/_reconcile/restartProfile lui-meme) emet 'close'/'error'/exit stdio,
  // JAMAIS 'unresponsive' => AUCUNE garde supplementaire requise, ce filtre suffit par construction.
  // ⚠️ ANTI-RECURSION : restartProfile() appelle b.stop() -> transport.close() -> _onExit(null,'close')
  // sur l'ANCIEN backend => sig='close' => le filtre ci-dessus l'ignore (pas de re-declenchement).
  async _onBackendUnresponsive(profile, sig, backend) {
    if (sig !== 'unresponsive') return; // seul le gel watchdog nous interesse (cf commentaire ci-dessus)
    if (this.backends.get(profile) !== backend) return; // event PERIME : ce backend a deja ete remplace

    const now = Date.now();
    const hist = this._restartHistory.get(profile) || [];
    const allowed = shouldAutoRestart(hist, now, this._autoRestartOptions);

    if (!allowed) {
      // ANTI-BOUCLE (dead-man) : on ne restart PAS a l'infini un profil qui gele en boucle -> on crie
      // au lieu de boucler en silence (0-human = crier, pas travailler pour rien).
      const msg = `pw-mcp-proxy: profil "${profile}" en BOUCLE de gel (>=${this._autoRestartOptions.maxRestarts} auto-restarts en ${this._autoRestartOptions.windowMs}ms) — auto-restart SUSPENDU, redemarrage de Claude Code probablement requis.`;
      log(msg);
      alert(msg, this.config?.ntfyUrl);
      return;
    }

    // Purge les timestamps HORS fenetre en meme temps qu'on enregistre le nouveau : la liste reste
    // bornee (jamais de croissance illimitee sur une longue session) ET l'historique ne porte que ce
    // que shouldAutoRestart regarde. NE PAS remplacer par un simple `[...hist, now]` (fuite + histo faux).
    const windowStart = now - this._autoRestartOptions.windowMs;
    this._restartHistory.set(profile, [...hist.filter((t) => t > windowStart), now]);
    log(`[auto-restart] profil "${profile}" declare unresponsive par le watchdog => restart automatique`);
    try {
      await this.restartProfile(profile);
    } catch (e) {
      // Cas "gel grave" (BACKLOG.md) : le respawn lui-meme ne revient pas -> alerte bruyante, jamais
      // un echec silencieux (le proxy resterait mort sans que personne ne le sache).
      const msg = `pw-mcp-proxy: auto-restart de "${profile}" a ECHOUE (${describeError(e)}) — serveur probablement mort, redemarrage de Claude Code requis.`;
      log(msg);
      alert(msg, this.config?.ntfyUrl);
    }
  }

  // FORENSIQUE (I/O) : au moment d'un GEL (event 'freeze' du backend), collecte l'etat REEL et ecrit
  // le rapport via freeze-report (PUR). But 0-human : « ne jamais rester dans l'ignorance » — la
  // prochaine occurrence d'un bug tordu (gel 22/07 jamais capture) devient diagnosticable.
  // ⚠️ BEST-EFFORT : ne throw JAMAIS (un echec de diagnostic ne doit pas perturber le flux du proxy) ;
  // OBSERVATION SEULE (ne tue rien, ne decide rien — le restart reste gere par _onBackendUnresponsive).
  // Cout de listProcesses acceptable : emis UNIQUEMENT sur gel detecte (rare), jamais dans le chemin chaud.
  _logFreezeReport(profile, info = {}) {
    try {
      const cfg = this.config.profiles?.[profile] || {};
      const udd = cfg.userDataDir || null;
      // ⚠️ Le pid/port du serveur partage n'est PLUS lisible ici : il vit dans le daemon, qui est le
      // seul a le connaitre (fin du registre fichier). Le DISCRIMINANT du rapport reste intact —
      // c'est `browserCount` (0 = Chrome mort, >0 = fige), jamais le pid du serveur.
      let serverPid = null, serverAlive = null, port = null, browserCount = null;
      if (udd) {
        try {
          // Discriminant Chrome mort/fige. Normalise les slashes (Windows \ vs Unix /) pour ne pas
          // rater le match => un faux « AUCUN Chrome » tromperait le diagnostic. Meme filtre binaire
          // que le drift-test (chrome/headless, jamais node/npx/cmd wrappers).
          const uddN = udd.replace(/\\/g, '/');
          browserCount = listProcesses().filter((p) => {
            const c = p.cmd.replace(/\\/g, '/');
            return c.includes(uddN) && /(chrome|chromium|headless_shell|msedge)/i.test(c) && !/node|npx|cmd\.exe/i.test(c);
          }).length;
        } catch { /* SILENCE: diagnostic best-effort — un rapport de gel ne doit JAMAIS throw (cf freeze-report) */ }
      }
      log(formatFreezeReport({ profile, reason: 'unresponsive', serverPid, serverAlive, port, browserCount, missedPings: info.missedPings, inflight: info.inflight }));
    } catch (e) {
      log(`[freeze-report] echec du diagnostic pour "${profile}": ${describeError(e)}`);
    }
  }

  // Fabrique le transport d'un profil.
  // Mode HTTP (MULTI-AGENT) : le DAEMON garantit le serveur partage (le demarre ou le partage) et
  // rend une socket AVANT qu'on injecte un HttpTransport client — cette socket EST le ref-count.
  // Mode stdio (defaut) : child MCP prive au proxy (tests, backends custom), aucun daemon implique.
  async _makeTransport(profile) {
    const spec = this._spec(profile);
    if (!this._isHttp(profile)) return new StdioTransport(profile, spec);
    // ⚠️ Le daemon cree UNE INSTANCE pour ce proxy (materialise l'identite v2, lance son serveur)
    // et rend une socket. Cette socket EST le ref-count : on la GARDE ouverte, `_release` la
    // fermera. La fermer ici terminerait l'instance aussitot et tuerait le navigateur sous l'agent.
    // `maxBrowsers` (optionnel, absent = illimite) : garde-fou CHOISI par l'utilisateur, applique
    // par le daemon au LANCEMENT. Il REFUSE une instance de plus, il n'evince jamais.
    const { url, instanceId, connexion } = await acquerirProfil(profile, spec, this._daemonEnv, { maxBrowsers: this.config.maxBrowsers, bindHost: this.config.bindHost, instance: this._instanceDe(profile) });
    this._closeConnexion(profile); // une SEULE connexion par profil (re-acquisition apres purge)
    this._connexions.set(profile, connexion);
    this._instanceIds.set(profile, instanceId);
    return new HttpTransport(url, { protocolVersion: this.clientInfo.protocolVersion, spec });
  }

  // Ferme MA connexion au daemon pour ce profil = decremente le ref-count. Best-effort et
  // idempotent : liberer ne doit JAMAIS faire echouer une bascule reussie.
  _closeConnexion(profile) {
    const c = this._connexions.get(profile);
    this._instanceIds.delete(profile);
    if (!c) return;
    this._connexions.delete(profile);
    try { c.destroy(); } catch (e) { log(`[daemon:${profile}] fermeture: ${describeError(e)}`); }
  }

  // SEUL chemin de bascule de profil (router._handleSwitch l'appelle ; NE PAS re-ecrire
  // `manager.activeProfile = x` ailleurs — ce serait sauter la liberation ci-dessous).
  //
  // ⚠️ LIBERER L'ANCIEN PROFIL EST OBLIGATOIRE — incident LIVE 2026-08-02 07:15 (boucle de spawn) :
  // sans ca, le backend quitte RESTAIT dans le pool avec son transport HTTP VIVANT, alors que son
  // serveur partage venait d'etre reape « idle » (legitime : plus aucun client). Ce transport tapait
  // dans le vide => backend exited => « purge du cadavre + respawn » => un serveur @playwright/mcp
  // (+ son Chrome) relance toutes les ~15 s jusqu'a saturer la machine.
  //
  // ⚠️ ORDRE OBLIGATOIRE : on n'ouvre le nouveau QU'APRES l'avoir obtenu (get d'abord). Liberer avant
  // laisserait l'agent SANS AUCUN backend si le nouveau profil echoue a demarrer.
  // ⚠️ MULTI-AGENT : liberer = fermer MA session (DELETE HTTP) + retirer MON heartbeat. Le serveur
  // partage survit tant qu'un AUTRE agent le tient (ref-count) ; on ne tue JAMAIS le serveur ici.
  // Scelle par tests/manager-switch-lifecycle.test.js (invariant N profils : au plus 1 transport ouvert).
  async setActiveProfile(target) {
    if (!this.config.profiles[target]) throw new Error(`profil inconnu: ${target}`);
    const previous = this.activeProfile;
    await this.get(target); // peut throw : on n'a alors RIEN libere, l'agent garde son backend courant
    this.activeProfile = target;
    if (previous && previous !== target) this._release(previous);
    return target;
  }

  // Libere un profil dont CE proxy n'est plus client : ferme backend + transport et retire le
  // heartbeat. Best-effort et idempotent — liberer ne doit jamais faire echouer une bascule reussie.
  _release(profile) {
    const b = this.backends.get(profile);
    if (b) {
      this.backends.delete(profile); // AVANT stop() : 'close' -> _onBackendUnresponsive ne doit rien retrouver
      try { b.stop(); } catch (e) { log(`[backend:${profile}] liberation: ${describeError(e)}`); }
    }
    // http seulement : fermer ma socket decremente le ref-count tenu par le NOYAU (no-op en stdio).
    this._closeConnexion(profile);
  }

  active() {
    return this.get(this.activeProfile);
  }

  // Vrai des qu'un backend du profil actif existe (pret OU en cours de demarrage). Le routeur ne sert
  // le SOUVENIR de handshake que si c'est faux : un backend vivant prime toujours sur un souvenir.
  demarre() {
    return this.backends.has(this.activeProfile);
  }

  // Spec du profil actif = la CLE du souvenir de handshake (cf handshake-cache-pure.cleHandshake).
  // ⚠️ Passe par `_spec`, SOURCE UNIQUE de la commande : une cle calculee ailleurs pourrait servir le
  // souvenir d'une AUTRE commande que celle qui sera lancee.
  specActive() {
    return this._spec(this.activeProfile);
  }

  profileList() {
    return Object.entries(this.config.profiles).map(([name, p]) => ({ name, label: p.label || name }));
  }

  // ⚠️ `userDataDirs()` A ETE SUPPRIME LE 03/08/2026 (audit) : CODE MORT. Son commentaire annoncait
  // « needles du boot-sweep / restart_profile », or le boot-sweep global a ete retire le 02/08 avec
  // le superviseur, et `restartProfile` lit le udd du SEUL profil vise (chirurgical, ci-dessous) —
  // jamais la liste entiere. Verifie : zero appelant dans `src/` comme dans `tests/`.
  // 🛑 NE PAS le recreer : une methode qui rend TOUS les user-data-dir n'a qu'un usage possible, le
  // balayage LARGE — precisement la regression P0-inverse (tuer le serveur d'un AUTRE agent).

  // restart_profile (P1) : libere le verrou d'UN profil bloque et respawn un backend propre.
  // 1) stop() du backend connu (tree-kill son arbre) ; 2) sweep de tout ORPHELIN tenant encore
  // le lock de CE user-data-dir (backend d'un proxy deja mort) ; 3) respawn immediat.
  // Chirurgical par user-data-dir => n'affecte QUE ce profil (jamais l'autre compte ni le Chrome perso).
  // ⚠️ MULTI-AGENT (appelant = humain via tool OU _onBackendUnresponsive automatique) : en mode HTTP
  // partage, ce restart recycle le serveur PARTAGE (sweepByCmd userDataDir) => impacte TOUS les agents
  // actuellement clients de ce profil. C'est ACCEPTE PAR DESIGN (c'est l'automatisation de l'outil manuel
  // restart_profile, prevu pour debloquer un profil FIGE — un profil fige est deja inutilisable pour
  // TOUS ses clients) ; l'anti-boucle de _onBackendUnresponsive (shouldAutoRestart) borne l'emballement
  // pour ne pas thrasher le serveur partage a chaque gel repete. NE PAS reintroduire de boot-sweep global.
  async restartProfile(profile) {
    if (!this.config.profiles[profile]) throw new Error(`profil inconnu: ${profile}`);
    const b = this.backends.get(profile);
    if (b) {
      b.stop();
      this.backends.delete(profile);
    }
    // v1 (dossier FIXE) : balayage chirurgical des orphelins qui tiendraient encore CE user-data-dir.
    // v2 (identite) : RIEN a balayer ici — l'instance appartient au DAEMON, qui la range et la
    // supprime a la fermeture de notre socket (ci-dessous, via _closeConnexion dans get/_makeTransport) ;
    // un balayage par dossier d'instance viserait un dossier que le daemon est en train de ranger.
    const dir = this.config.profiles[profile].userDataDir;
    if (dir) {
      const killed = sweepByCmd([dir], process.pid);
      if (killed.length) log(`restart_profile ${profile}: ${killed.length} orphelin(s) tue(s) [${killed.join(',')}]`);
    }
    // ⚠️ Fermer la socket AVANT de redemander : sinon le daemon nous rendrait... rien de partage
    // (plus de partage), mais l'ancienne instance survivrait tant que cette socket vit.
    this._closeConnexion(profile);
    return this.get(profile);
  }

  stopAll() {
    if (this._surveillance) { this._surveillance.fermer(); this._surveillance = null; }
    for (const b of this.backends.values()) b.stop();
    this.backends.clear();
    // Rendre TOUS mes profils au daemon. La correction n'en depend pas (le noyau ferme les sockets
    // a la mort du process, meme sur kill -9) — c'est la sortie PROPRE, pas le filet.
    for (const p of [...this._connexions.keys()]) this._closeConnexion(p);
  }

  // ⚠️ PLUS AUCUNE SUPERVISION ICI — supprimee le 02/08 avec le superviseur. Le cycle de vie des
  // serveurs partages appartient au DAEMON, qui en est le PARENT : il les demarre a la demande et
  // les arrete quand leur derniere socket se ferme. Il n'y a plus rien a amorcer au boot, plus
  // rien a purger, plus aucun heartbeat a retirer a l'arret. NE PAS reintroduire de boot-sweep ni
  // de lock d'abdication : ils tueraient le serveur qu'un AUTRE agent utilise.
}
