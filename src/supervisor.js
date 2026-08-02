// supervisor.js — I/O : cycle de vie des serveurs @playwright/mcp HTTP PARTAGES (1 par profil),
// ref-comptes par les proxys (= agents Claude). C'est ce qui rend le proxy MULTI-AGENT : au lieu que
// chaque proxy spawn son propre backend (=> conflit SingletonLock sur --user-data-dir), TOUS les
// proxys d'un meme profil sont CLIENTS HTTP d'UN serveur partage. La DECISION (port, vie, reap) vit
// dans server-registry.js (PUR, mutation-teste) ; ICI = l'I/O (spawn/kill/fetch/fichier).
//
// ⚠️ SERIALISATION inter-process par LOCK FICHIER : ensureServer() tient un verrou par-config pendant
// toute la sequence lire-registre -> decider -> spawn -> poll-ready -> enregistrer. C'est le POINT DE
// SERIALISATION UNIQUE (doctrine) : deux proxys ne peuvent PAS spawn deux serveurs concurrents pour le
// meme profil (ce qui violerait SingletonLock). NE PAS retirer le verrou.
//
// ⚠️ Serveur DETACHE + unref() sur TOUTES plateformes (pas seulement POSIX) : le serveur est PARTAGE,
// il DOIT survivre a la mort du proxy qui l'a lance (sinon l'agent A ferme et coupe l'agent B). Sa mort
// est detectee via le registre (pid mort => reap) — c'est le dead-man switch. NE PAS l'attacher.
//
// ⚠️ Reap = treeKill OBLIGATOIRE (pas kill simple) : le serveur a un petit-enfant chrome.exe qui tient
// le lock --user-data-dir. Meme invariant que backend.stop(). NE PAS revenir a kill() seul.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';
import {
  emptyRegistry,
  serverEntry,
  pickPort,
  withServer,
  withoutServer,
  withClient,
  withoutClient,
  promoteServer,
  reapDecision,
  STATE_STARTING,
} from './server-registry.js';
// ⚠️ SOURCE UNIQUE des delais (budget.js). NE JAMAIS redeclarer une constante de temps ici : c'est
// leur dispersion couche par couche qui a coute la connexion MCP du 2026-07-31.
import {
  READY_TIMEOUT_MS,
  READY_POLL_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  LOCK_RETRY_MS,
  SERVER_TTL_MS,
  HEARTBEAT_MS,
  SPAWN_ATTEMPTS,
  RETRY_READY_TIMEOUT_MS,
  startStaleMs,
} from './budget.js';
import { allocateEphemeralPort } from './port-alloc.js';
import { treeKill, isPidAlive, sweepByCmd } from './prockill.js';
import { processIdentity } from './proc-identity.js';
import { safeToKill } from './proc-identity-pure.js';
import { resolveShellSpawn } from './spawn-cmd.js';
import { alert } from './notify.js';
import { log } from './logger.js';
import { describeError } from './error-detail.js';
import { acquireLaunchChannel } from './launch-channel.js';
// ⚠️ HORLOGE MONOTONE pour tout horodatage PERSISTE (jamais Date.now() : il saute — NTP/DST).
import { monotonicNow, isStaleBoot, isWallClock } from './clock.js';

// ⚠️ Host / DNS-rebinding : on suit la CONFIGURATION DOCUMENTÉE par Microsoft (skill playwright-mcp-api,
// playwright.dev/mcp/configuration/options), sans rien rétro-ingénierer :
//   - `--host localhost` = le DÉFAUT documenté du serveur.
//   - CLIENT via `http://localhost:<port>/mcp` = l'URL que la doc officielle donne au client.
//   - On NE passe PAS `--allowed-hosts` : son défaut documenté (= le host de bind) autorise déjà le
//     Host header `localhost:<port>` que le client envoie. Un override explicite `localhost` ne matche
//     PAS le port (403) — donc on laisse le défaut, qui est la voie supportée/testée par l'éditeur.
// contract-live.test.js scelle l'accord bout-en-bout contre le vrai binaire.
const BIND_HOST = 'localhost'; // --host (défaut documenté)
const URL_HOST = 'localhost'; // hôte de connexion client (URL documentée)
// ⚠️ Les DELAIS ne sont PAS declares ici : ils viennent de budget.js (source unique, cf import).

function idFor(configPath) {
  return crypto.createHash('sha1').update(String(configPath)).digest('hex').slice(0, 12);
}
function registryPathFor(configPath) {
  return path.join(os.tmpdir(), `pw-mcp-registry-${idFor(configPath)}.json`);
}
function lockPathFor(configPath) {
  return path.join(os.tmpdir(), `pw-mcp-registry-${idFor(configPath)}.lock`);
}

export class Supervisor {
  // clientId = identifiant unique de CE proxy (pid suffit : un proxy = un process).
  // ⚠️ `allocatePort` est INJECTABLE (defaut = l'OS) uniquement pour que les tests puissent exercer la
  // boucle de reessai de maniere DETERMINISTE. La prod ne passe JAMAIS d'override : le port doit venir
  // de l'OS, jamais d'une valeur choisie par du code (c'est toute la lecon de l'incident du 31/07).
  // ⚠️ `readyTimeoutMs` est INJECTABLE (defaut = budget.js) pour que les tests bornent leur pire cas
  // (SPAWN_ATTEMPTS x patience) sous la limite d'un test. La PROD garde le defaut : 20 s sont
  // necessaires a un boot legitime (premier `npx` qui telecharge le paquet). NE PAS raccourcir en prod.
  constructor(configPath, { ttl = SERVER_TTL_MS, clientId = String(process.pid), ntfyUrl = null, allocatePort = allocateEphemeralPort, readyTimeoutMs = READY_TIMEOUT_MS, clock = monotonicNow } = {}) {
    // ⚠️ `clock` INJECTABLE pour la meme raison que `allocatePort` : rendre les tests
    // DETERMINISTES. `os.uptime()` a une resolution d'UNE SECONDE sur macOS (mesure CI
    // 2026-08-02) — un test a TTL de quelques ms n'y declencherait JAMAIS le reap, et le
    // resultat dependrait de l'OS. La PROD garde le defaut : jamais d'override hors tests.
    this._now = clock;
    this._allocatePort = allocatePort;
    this.readyTimeoutMs = readyTimeoutMs;
    // Patience des REESSAIS : courte (paquet deja en cache), et JAMAIS superieure a la nominale —
    // un test qui raccourcit la patience ne doit pas se retrouver avec des reessais PLUS longs.
    this._retryReadyMs = Math.min(RETRY_READY_TIMEOUT_MS, readyTimeoutMs);
    this.configPath = configPath;
    this.registryPath = registryPathFor(configPath);
    this.lockPath = lockPathFor(configPath);
    this.ttl = ttl;
    this.clientId = clientId;
    this.ntfyUrl = ntfyUrl; // dead-man : alerte NTFY quand un serveur partage MEURT (crash inattendu)
    this._heartbeats = new Map(); // profile -> interval handle
    this._reaper = null;
  }

  // ---------- registre : lecture / ecriture atomique (write-rename) ----------
  // ⚠️ Tout horodatage du registre est en MONOTONE (ms depuis le boot machine), jamais en heure
  // murale : `Date.now()` saute (NTP/DST) et ferait soit massacrer tous les serveurs, soit ne
  // plus jamais en nettoyer aucun — silencieusement, et seulement sur la longue duree.
  _read() {
    let reg;
    try {
      reg = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) || emptyRegistry();
    } catch {
      return emptyRegistry(); // absent/corrompu : on repart d'un registre vide (self-heal)
    }
    // ⚠️ REGISTRE D'AVANT LE DERNIER REBOOT ⇒ VIDE. Ce n'est PAS une inference : un horodatage
    // superieur a l'uptime courant ne peut venir que d'un boot precedent, et AUCUN process ne
    // survit a un redemarrage. Meme regle qui rattrape l'ancien format (heure murale ~1.7e12,
    // toujours > un uptime plausible) : une seule detection, pas de migration a maintenir.
    const stamps = [];
    for (const e of Object.values(reg.servers || {})) {
      if (e && typeof e === 'object') stamps.push(e.startedAt, e.spawnedAt, ...Object.values(e.clients || {}));
    }
    const now = this._now();
    // LEGACY (horodatages en heure murale) : les process peuvent etre VIVANTS. On CONVERTIT — les
    // oublier laisserait des serveurs orphelins A VIE le jour de la mise a jour, en silence.
    // Ils repartent avec une grace d'un TTL : au pire un serveur idle vit un cycle de plus.
    if (stamps.some(isWallClock)) {
      log('[supervisor] registre au format horaire (pre-2026-08-02) : converti en monotone');
      for (const e of Object.values(reg.servers || {})) {
        if (!e || typeof e !== 'object') continue;
        if (isWallClock(e.startedAt)) e.startedAt = now;
        if (isWallClock(e.spawnedAt)) e.spawnedAt = now;
        for (const [c, t] of Object.entries(e.clients || {})) if (isWallClock(t)) e.clients[c] = now;
      }
      return reg;
    }
    // PRE-REBOOT : un horodatage > uptime ne peut venir que d'un boot precedent, et AUCUN process
    // ne survit a un redemarrage. Vider est donc EXACT, pas prudent.
    if (isStaleBoot(stamps, now)) {
      log('[supervisor] registre anterieur au dernier demarrage : ignore (aucun process n a survecu)');
      return emptyRegistry();
    }
    return reg;
  }
  _write(reg) {
    const tmp = this.registryPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg));
    fs.renameSync(tmp, this.registryPath); // rename = atomique sur le meme FS
  }

  // Verrou fichier spin (wx = echoue si existe). Vol du verrou perime (proxy mort en le tenant).
  // ⚠️ PROTOCOLE FORMELLEMENT PROUVE — spec/SupervisorLock.tla (config Fixed, verifie par TLC au gate
  // `npm run test:spec`). CE CODE EST L'ANCRAGE (trace) de la spec ; toute divergence casse la preuve.
  // Correspondance code <-> actions TLA+ : openSync(wx) reussi = action Open (entree section critique) ;
  // EEXIST + stat = actions Open(present)/Check ; _tryStealStale = actions Steal* (vol serialise).
  async _lock() {
    const stealPath = this.lockPath + '.steal'; // meta-verrou serialisant le VOL (spec: variable `meta`)
    // Patience DERIVEE de budget.js (LOCK_WAIT_MS / LOCK_RETRY_MS = 30000/50 = 600 tours : valeurs
    // IDENTIQUES a l'historique => protocole inchange, la preuve TLC reste valable telle quelle).
    const attempts = Math.ceil(LOCK_WAIT_MS / LOCK_RETRY_MS);
    for (let i = 0; i < attempts; i++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx'); // spec: Open, branche lock=NoOwner => section critique
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // verrou present (spec: Open branche lock#NoOwner => Check). Perime ?
        let stale = false;
        try {
          const st = fs.statSync(this.lockPath);
          stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        } catch { /* disparu entre stat : on reboucle direct sur openSync */ continue; }
        // ⚠️ NE JAMAIS remplacer par un `unlinkSync(this.lockPath)` inconditionnel ici : c'est le BUG
        // prouve ROUGE par TLC (config Buggy) = deux proxys volent le meme verrou perime, le 2e supprime
        // le verrou FRAIS que le 1er vient de creer => double section critique => double spawn
        // @playwright/mcp => « browser is already in use ». Le vol DOIT passer par _tryStealStale.
        if (stale) { if (!this._tryStealStale(stealPath)) await this._delay(LOCK_RETRY_MS); }
        else await this._delay(LOCK_RETRY_MS);
      }
    }
    throw new Error('registry lock: timeout (verrou tenu trop longtemps)');
  }

  // Vol d'un verrou PERIME, SERIALISE par un meta-verrou + RE-VERIFICATION de la peremption SOUS ce verrou.
  // ⚠️ INVARIANT DE SURETE (prouve par TLC — spec/SupervisorLock.tla, config Fixed) : le unlink du verrou
  // principal est re-verifie sous le meta-verrou. Un verrou FRAIS ne pouvant naitre (openSync wx) que si le
  // path est ABSENT, tant que le perime est present aucun frais n'apparait => ce unlink ne peut JAMAIS
  // supprimer un verrou frais. Le meta ne protege QU'un re-check+unlink (il n'entre JAMAIS en section
  // critique, ne cree JAMAIS le verrou principal) => un meta orphelin est un probleme de VIVACITE seul,
  // jamais de surete ; on le libere au-dela de LOCK_STALE_MS. Retourne true si on a fait un tour de vol
  // (le caller reboucle sans delai), false si le meta est occupe (le caller temporise).
  _tryStealStale(stealPath) {
    let fd;
    try {
      fd = fs.openSync(stealPath, 'wx'); // spec: StealAcquireMeta (meta=NoOwner => meta:=moi)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // spec: StealWaitMeta (meta occupe). Meta orphelin (voleur mort) => on le recupere (vivacite).
      try {
        const st = fs.statSync(stealPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { try { fs.unlinkSync(stealPath); } catch {} }
      } catch { /* meta disparu entre-temps */ }
      return false; // occupe : le caller temporise
    }
    try {
      fs.closeSync(fd);
      // spec: StealDo — RE-VERIF sous meta : unlink UNIQUEMENT si TOUJOURS present ET TOUJOURS perime.
      const st = fs.statSync(this.lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(this.lockPath);
    } catch { /* verrou principal deja disparu ou frais : rien a voler */ }
    finally { try { fs.unlinkSync(stealPath); } catch {} } // relache le meta (spec: meta:=NoOwner)
    return true;
  }
  _unlock() {
    try { fs.unlinkSync(this.lockPath); } catch { /* deja libere */ }
  }
  async _withLock(fn) {
    await this._lock();
    try { return await fn(); } finally { this._unlock(); }
  }

  // ---------- section critique de LANCEMENT : canal nomme (remplacant du verrou fichier) ----------
  // ⚠️ REMPLACE `_withLock` (incident 31/07→01/08 : verrou SATURE, pas orphelin). Le noyau detruit
  // le canal a la mort du processus ⇒ aucun verrou ne peut plus « rester coince », donc plus aucune
  // attente, plus aucune peremption, plus aucun vol. Toutes les questions posees ici sont LOCALES et
  // le noyau y repond EXACTEMENT — il n'y a pas un seul delai dans ce chemin.
  //
  // Deux issues, toutes deux terminales (aucune boucle d'attente) :
  //   LANCEUR : j'execute la section critique, je publie le port, je libere le canal.
  //   SUIVEUR : un autre lance deja ; il m'a publie un port DEJA PROUVE JOIGNABLE ⇒ je l'utilise.
  //
  // ⚠️ Le lanceur ne publie QU'APRES readiness prouvee ⇒ un port recu par un suiveur n'est jamais
  //    une promesse, c'est un fait. NE PAS deplacer `publish` avant le poll.
  async _withLaunchChannel(profile, fn) {
    const channel = await acquireLaunchChannel(profile);

    if (channel.role === 'follower') {
      // Le port vient d'un lanceur qui a DEJA prouve la readiness. On le confirme quand meme :
      // le serveur a pu mourir entre la publication et maintenant (fait observable, pas suppose).
      if (await this._probeReady(channel.port)) {
        log(`[supervisor:${profile}] serveur adopte via canal port=${channel.port}`);
        return this.urlFor(channel.port);
      }
      // ⚠️ Anomalie REELLE, jamais un simple reessai : le lanceur a annonce un port joignable qui ne
      // l'est plus. On echoue BRUYAMMENT plutot que de boucler (une boucle ici recreerait exactement
      // la contention du 01/08). L'appelant (manager.get) refera un cycle propre.
      throw new Error(
        `serveur ${profile} : port ${channel.port} publie par le lanceur mais deja injoignable ` +
          `(le serveur est mort juste apres son demarrage — consulter le log du backend)`
      );
    }

    try {
      return await fn(channel);
    } finally {
      // ⚠️ Liberation EXPLICITE au cas nominal ; mais la correction n'en depend PAS : sur un crash,
      // le noyau libere le canal lui-meme. C'est toute la difference avec le verrou fichier, dont
      // la liberation dependait d'un nettoyage volontaire (et donc echouait quand ca allait mal).
      channel.close();
    }
  }

  // ---------- garde anti-recyclage de PID ----------
  // ⚠️ UN PID EST UN NUMERO REUTILISABLE, PAS UNE IDENTITE (`pid_max` = 32768 par defaut sous Linux).
  // Sur une machine qui tourne des semaines, le PID d'un serveur mort finit REATTRIBUE a un process
  // tiers. Sans cette garde, `treeKill(entry.pid)` finit par TUER LE PROCESS DE QUELQU'UN D'AUTRE —
  // la seule faute du projet dont les degats sortent de son perimetre. Faille trouvee par simulation
  // le 2026-08-01 (jamais observee, mais CERTAINE a terme).
  //
  // ⚠️ Cout MESURE : ~650 ms sur Windows (CIM), quasi nul sur Linux (/proc). Donc on ne verifie
  //    QU'AVANT DE TUER, jamais dans le chemin chaud (la readiness reste prouvee par la sonde HTTP).
  // ⚠️ Entree SANS identite = registre ecrit AVANT cette migration (2026-08-01). On tue alors comme
  //    avant, en le TRACANT : refuser ferait fuir des orphelins a vie chez tout utilisateur existant.
  //    Cas transitoire par construction — toute entree neuve porte son identite.
  // Rend un verdict a TROIS etats — la distinction est VITALE (regression introduite puis corrigee
  // le 2026-08-02) :
  //   'killed'   : c'etait bien notre process, il est mort ⇒ l'appelant retire l'entree.
  //   'not-ours' : identite LUE et DIFFERENTE ⇒ notre serveur est mort et son pid a ete recycle.
  //                On ne tue pas, mais l'entree doit disparaitre (elle ne designe plus rien a nous).
  //   'unknown'  : identite ILLISIBLE (PowerShell indisponible, machine saturee, /proc refuse).
  //                ⇒ ⚠️ L'APPELANT DOIT GARDER L'ENTREE. Sans preuve, on n'a ni tue ni disculpe :
  //                effacer la trace laisserait un process VIVANT et INCONNU DE TOUS — il tiendrait
  //                le port et le lock --user-data-dir, ferait echouer les spawns suivants, et on
  //                retomberait sur la panne METASTABLE du 31/07 (taskkill humain). Le doute se
  //                REPORTE au prochain reap, il ne se resout jamais par un effacement.
  //                (Declencheur REEL, pas theorique : la loopback de cette machine a decroche sous
  //                charge le 2026-08-02, faisant echouer les appels PowerShell.)
  _killIfOurs(pid, identity, what) {
    if (identity) {
      const now = processIdentity(pid);
      if (!now) {
        log(`[supervisor] ${what}: pid=${pid} identite ILLISIBLE — ni tue ni oublie, on reessaiera`);
        return 'unknown';
      }
      if (!safeToKill(identity, now)) {
        // ⚠️ Les DEUX valeurs sont imprimees : sans elles, « PID recycle » et « lecture instable »
        // sont indiscernables — et on repart sur des hypotheses (2 fausses le 02/08 sur macOS).
        log(
          `[supervisor] ${what}: pid=${pid} NON tue — identite differente. ` +
            `attendue=${JSON.stringify(identity)} lue=${JSON.stringify(now)}`
        );
        return 'not-ours';
      }
    } else {
      log(`[supervisor] ${what}: pid=${pid} tue SANS verification d'identite (entree d'avant 2026-08-01)`);
    }
    try { treeKill(pid); } catch (e) { log(`[supervisor] ${what}: treeKill pid=${pid} — ${describeError(e)}`); }
    return 'killed';
  }

  // ---------- readiness ----------
  urlFor(port) {
    return `http://${URL_HOST}:${port}/mcp`; // client via localhost (Host header allowlisté)
  }
  // Le serveur ecoute-t-il ? Toute reponse HTTP (meme 4xx) prouve qu'il est up. ECONNREFUSED = pas pret.
  // ⚠️ Pas de health endpoint documente cote @playwright/mcp (verifie en ligne) => on sonde /mcp.
  async _probeReady(port) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    try {
      const res = await fetch(this.urlFor(port), {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      // draine/ferme le flux eventuel (evite un socket qui pend).
      try { await res.body?.cancel(); } catch {}
      return true; // a repondu quelque chose => up
    } catch {
      return false; // refus de connexion / timeout => pas (encore) pret
    } finally {
      clearTimeout(t);
    }
  }
  async _pollReady(port, budget = this.readyTimeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      if (await this._probeReady(port)) return true;
      await this._delay(READY_POLL_MS);
    }
    return false;
  }

  // ---------- coeur : garantir un serveur pour un profil ----------
  // spec = { command, args } DEJA construit (buildSpec) SANS --port (le port est runtime). On y ajoute
  // --host/--port. Retourne l'URL du serveur pret. Idempotent + reprenable : si un serveur vivant
  // existe deja (course gagnee par un autre proxy), on l'ADOPTE au lieu d'en spawn un second.
  // userDataDir (optionnel) : sert au SELF-HEAL d'un orphelin NON suivi (registre perdu mais un vieux
  // serveur tient encore le lock du profil) — cf recovery ci-dessous. Aucun effet en mode isolated.
  async ensureServer(profile, spec, { userDataDir = null } = {}) {
    // Chemin rapide : deja pret et vivant, sans prendre le verrou (lecture seule).
    const fast = serverEntry(this._read(), profile);
    if (fast && isPidAlive(fast.pid) && (await this._probeReady(fast.port))) return this.urlFor(fast.port);

    return this._withLaunchChannel(profile, async (channel) => {
      let reg = this._read();
      let entry = serverEntry(reg, profile);
      // Re-verifie sous verrou (un autre proxy a pu gagner la course pendant l'attente du lock).
      if (entry && isPidAlive(entry.pid) && (await this._probeReady(entry.port))) {
        channel.publish(entry.port); // serveur ADOPTE : les suiveurs sont servis sans re-sonder
        return this.urlFor(entry.port);
      }

      // Entree morte : on la purge (tree-kill best-effort si le pid traine encore).
      if (entry) {
        if (isPidAlive(entry.pid)) this._killIfOurs(entry.pid, entry.identity, 'purge entree morte');
        reg = withoutServer(reg, profile);
        this._write(reg);
      }

      let pid = await this._spawnReady(profile, reg, spec);
      // SELF-HEAL orphelin : le spawn a echoue (port tenu par un vieux serveur NON suivi, ou son Chrome
      // tient le lock --user-data-dir). Ce serveur ne peut PAS etre un serveur PARTAGE vivant : celui-la
      // aurait ete ADOPTE au chemin rapide/re-verif (il est dans le registre + pret). Donc c'est un
      // ABANDONNE => on reclame SA ressource par user-data-dir (jamais le Chrome perso) et on retente 1x.
      // C'est le remplacant CIBLE du boot-sweep global (incompatible avec le modele serveur-partage).
      if (pid == null && userDataDir) {
        const killed = sweepByCmd([userDataDir], process.pid);
        if (killed.length) log(`[supervisor:${profile}] self-heal: ${killed.length} orphelin(s) tue(s) [${killed.join(',')}]`);
        // Patience COURTE ici aussi : c'est un reessai, le paquet est deja en cache (cf budget.js).
        pid = await this._spawnReady(profile, this._read(), spec, this._retryReadyMs);
      }
      // ⚠️ REESSAIS SUR PORT NEUF (refonte port ephemere, 2026-07-31). Chaque _spawnReady REDEMANDE un
      // port a l'OS => un echec du a la fenetre TOCTOU (port raffle entre notre close et le bind du
      // serveur) est resolu par le simple fait de reessayer sur un port DIFFERENT. C'est le traitement
      // prevu et documente de cette course : borne, bruyant, jamais infini.
      // ⚠️ Ce filet ne remplace PAS le self-heal ci-dessus (causes disjointes : lock --user-data-dir vs
      // port) — les deux coexistent, dans cet ordre. NE PAS fusionner.
      for (let attempt = 2; pid == null && attempt <= SPAWN_ATTEMPTS; attempt++) {
        log(`[supervisor:${profile}] demarrage rate — nouveau port demande a l'OS (tentative ${attempt}/${SPAWN_ATTEMPTS})`);
        pid = await this._spawnReady(profile, this._read(), spec, this._retryReadyMs);
      }
      // ⚠️ MESSAGE HONNETE (le precedent — « pas pret apres 20000ms » — ACCUSAIT le serveur alors qu'il
      // demarrait tres bien : il a coute 3 h d'enquete le 31/07). On nomme ce qu'on SAIT (N tentatives,
      // ports differents) et ce qu'on SUPPOSE, sans jamais presenter l'un pour l'autre.
      if (pid == null) {
        throw new Error(
          `serveur ${profile} injoignable apres ${SPAWN_ATTEMPTS} tentatives sur ${SPAWN_ATTEMPTS} ports differents ` +
          `(${this.readyTimeoutMs}ms chacune). Le process demarre mais ne repond pas sur la loopback : ` +
          `suspecter un filtrage local (antivirus/VPN/pare-feu), PAS le serveur lui-meme.`
        );
      }

      // PROMOTION : l'entree EXISTE DEJA (write-ahead de _spawnReady) ; on la fait passer 'starting' ->
      // 'ready'. ⚠️ NE PAS la re-creer ici avec withServer : ce serait un SECOND site de construction
      // d'entree (deux verites a maintenir en parallele = la duplication qui derive), et ca ecraserait
      // le spawnedAt d'origine — donc le seul horodatage qui date reellement le demarrage.
      let out = promoteServer(this._read(), profile, this._now());
      out = withClient(out, profile, this.clientId, this._now()); // je m'enregistre immediatement
      this._write(out);
      // ⚠️ PUBLICATION APRES readiness PROUVEE, jamais avant : un suiveur qui recoit un port le
      // considere JOIGNABLE par construction. Publier un port « en cours » rendrait le suiveur
      // porteur d'une inference — exactement ce qu'on supprime.
      channel.publish(this._lastPort);
      log(`[supervisor:${profile}] serveur pret pid=${pid} ${this.urlFor(this._lastPort)}`);
      return this.urlFor(this._lastPort);
    });
  }

  // Spawn detache d'un serveur + attente readiness. Retourne le pid si pret, sinon null (apres tree-kill
  // de la tentative ratee). _lastPort porte le port choisi (relu par ensureServer pour l'enregistrement).
  //
  // ⚠️ WRITE-AHEAD (incident 2026-07-31) : l'entree est inscrite au registre en `starting` DES QUE le pid
  // existe, AVANT le poll de readiness. NE JAMAIS repousser cette ecriture apres le poll : entre le spawn
  // et la promotion il s'ecoule jusqu'a READY_TIMEOUT_MS, et le serveur est DETACHE (il survit a tout).
  // Si le proxy meurt dans cet intervalle sans que rien ne soit inscrit, le process reste VIVANT et
  // INCONNU DE TOUS : il tient le port et le lock --user-data-dir, fait echouer le spawn suivant, met le
  // boot hors budget client, tue la connexion, et laisse un nouvel orphelin => panne METASTABLE (le
  // remede fabrique la cause suivante). C'est exactement ce qui a impose un `taskkill` HUMAIN le 31/07.
  // Regle universelle du provisioning, ici non negociable : INSCRIRE L'INTENTION AVANT L'ACTION.
  async _spawnReady(profile, reg, spec, budgetMs = this.readyTimeoutMs) {
    // ⚠️ Le port est DEMANDE A L'OS, jamais calcule (cf port-alloc.js — incident 2026-07-31).
    // `pickPort` ne s'en sert QUE s'il n'y a pas deja d'entree pour ce profil : le rendez-vous des
    // agents reste le REGISTRE, inchange. Allocation A CHAQUE TENTATIVE => un reessai porte
    // necessairement sur un port DIFFERENT (c'est ce qui rend la boucle d'ensureServer efficace ;
    // reutiliser le meme port rejouerait le meme echec a l'identique).
    const port = pickPort(reg, profile, await this._allocatePort());
    this._lastPort = port;
    // Resolution cross-OS centralisee (spawn-cmd.js) : sur Windows, `npx` (commande bare) EXIGE
    // shell:true + quoting, sinon le serveur ne demarre jamais (bug reproduit 2026-07-13 : timeout
    // "pas pret"). SOURCE UNIQUE partagee avec stdio-transport.js. NE PAS remettre shell:false en dur.
    const rawArgs = [...spec.args, '--host', BIND_HOST, '--port', String(port)];
    const { command, args, shell } = resolveShellSpawn(spec.command, rawArgs);
    const child = spawn(command, args, {
      stdio: 'ignore', // serveur autonome : ni stdin ni capture (il n'est pas pilote en stdio)
      detached: true, // ⚠️ survit a la mort du proxy lanceur (serveur PARTAGE)
      windowsHide: true,
      shell,
    });
    child.on('error', (e) => log(`[supervisor:${profile}] spawn error: ${describeError(e)}`));
    const pid = child.pid;
    child.unref(); // ⚠️ ne pas retenir l'event loop du proxy sur ce serveur detache
    if (!pid) return null; // spawn avorte : aucun process a tracer, donc rien a inscrire ni a tuer
    // WRITE-AHEAD : l'intention est inscrite MAINTENANT, pas apres le poll (cf en-tete de la methode).
    // A partir d'ici, ce process est CONNU du registre : meme si ce proxy meurt a la milliseconde
    // suivante, le reaper de n'importe quel autre agent le verra et le tuera (plus d'orphelin invisible).
    // ⚠️ `startedAt` (instant du spawn), PAS `spawnedAt` : ce dernier est pose a la PROMOTION, donc la
    // grace de boot du reaper reste calculee exactement comme avant le write-ahead (zero regression).
    // ⚠️ IDENTITE CAPTUREE ICI, au plus pres du spawn : c'est le seul instant ou l'on SAIT que ce pid
    // est bien le notre. Toute lecture ulterieure sera comparee a celle-ci avant un kill.
    const identity = processIdentity(pid);
    this._write(withServer(this._read(), profile, { port, pid, identity, startedAt: this._now(), state: STATE_STARTING }));
    if (await this._pollReady(port, budgetMs)) return pid;
    try { treeKill(pid); } catch {}
    // Tentative RATEE : on retire l'intention qu'on vient d'inscrire. Le pid vient d'etre tue ; laisser
    // l'entree ferait croire a un serveur existant (et figerait son port pour l'essai suivant).
    this._write(withoutServer(this._read(), profile));
    return null;
  }

  // ---------- ref-count : heartbeat client ----------
  // A appeler quand CE proxy commence a utiliser un profil : bat le coeur periodiquement pour que
  // le reaper garde le serveur vivant. Idempotent par profil (relancer ne cree pas 2 timers).
  registerClient(profile) {
    this._touch(profile);
    if (this._heartbeats.has(profile)) return;
    const h = setInterval(() => this._touch(profile), HEARTBEAT_MS);
    h.unref?.(); // le heartbeat ne doit pas empecher le proxy de s'arreter
    this._heartbeats.set(profile, h);
  }
  async _touch(profile) {
    try {
      await this._withLock(async () => {
        const reg = withClient(this._read(), profile, this.clientId, this._now());
        this._write(reg);
      });
    } catch (e) {
      log(`[supervisor:${profile}] heartbeat rate: ${describeError(e)}`);
    }
  }
  // A appeler quand CE proxy lache un profil (switch) ou s'arrete : retire mon heartbeat.
  async unregisterClient(profile) {
    const h = this._heartbeats.get(profile);
    if (h) { clearInterval(h); this._heartbeats.delete(profile); }
    try {
      await this._withLock(async () => {
        const reg = withoutClient(this._read(), profile, this.clientId);
        this._write(reg);
      });
    } catch (e) {
      log(`[supervisor:${profile}] unregister rate: ${describeError(e)}`);
    }
  }

  // ---------- reaper : tue les serveurs morts ou sans client vivant ----------
  // PUR = reapDecision ; ICI on applique l'I/O (treeKill + persistance). Boot-reap au demarrage +
  // periodique. alivePids mesure REELLE via isPidAlive (jamais devinee).
  async reap() {
    try {
      await this._withLock(async () => {
        const reg = this._read();
        const pids = Object.values(reg.servers || {}).map((s) => s.pid);
        const alive = pids.filter((p) => isPidAlive(p));
        // startStaleMs() = budget au-dela duquel une entree 'starting' jamais promue est morte-nee.
        // C'est CE parametre qui rend l'orphelin du 31/07 tuable AUTOMATIQUEMENT (0-human).
        const { reap, kept } = reapDecision(reg, alive, this._now(), this.ttl, startStaleMs());
        const doute = []; // entrees dont l'identite n'a PAS pu etre lue : a CONSERVER
        for (const r of reap) {
          const verdict = this._killIfOurs(r.pid, (reg.servers || {})[r.profile]?.identity, `reap ${r.reason}`);
          if (verdict === 'unknown') { doute.push(r.profile); continue; } // ni alerte ni retrait
          log(`[supervisor] reap ${r.profile} (${r.reason}) pid=${r.pid} port=${r.port}`);
          // ⚠️ Dead-man (doctrine « crier quand ca meurt ») : un serveur DEAD = mort INATTENDUE (crash)
          // vs 'idle' = fin de vie NORMALE (plus de client). On alerte UNIQUEMENT le crash pour reperer
          // une boucle de mort, sinon le self-heal respawn masquerait un backend qui plante en silence.
          // ⚠️ 'stuck-starting' NE CRIE PAS non plus : un serveur qui n'a jamais fini de demarrer n'a
          // pas crashe (cas courant : la fenetre Claude est fermee pendant un boot). Le confondre avec
          // 'dead' ferait sonner le dead-man en routine — et une alerte qui sonne pour rien est une
          // alerte qu'on cesse de lire, donc une VRAIE panne qui passera inapercue. Le log suffit ici.
          if (r.reason === 'dead') {
            alert(`serveur @playwright/mcp du profil "${r.profile}" MORT inopinement (pid=${r.pid}, port=${r.port}) — reape. Verifier un crash en boucle.`, this.ntfyUrl);
          }
        }
        // ⚠️ Les entrees en DOUTE sont REINJECTEES telles quelles : `reapDecision` (pur) les avait
        // retirees, mais lui ne sait pas que la lecture d'identite a echoue. Ne JAMAIS simplifier en
        // ecrivant `kept` directement — ce serait perdre de vue un process potentiellement vivant.
        if (reap.length) {
          let out = kept;
          for (const p of doute) out = withServer(out, p, reg.servers[p]);
          this._write(out);
        }
      });
    } catch (e) {
      log(`[supervisor] reap rate: ${describeError(e)}`);
    }
  }
  startReaper(period = HEARTBEAT_MS) {
    if (this._reaper) return;
    this._reaper = setInterval(() => this.reap(), period);
    this._reaper.unref?.();
  }
  stopReaper() {
    if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
  }

  // Arret propre de CE proxy : retire tous mes heartbeats + stoppe le reaper. NE tue PAS les serveurs
  // (ils sont partages : d'autres proxys peuvent les utiliser). Le reap s'en chargera si plus personne.
  async shutdown() {
    this.stopReaper();
    for (const profile of [...this._heartbeats.keys()]) await this.unregisterClient(profile);
  }

  _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
