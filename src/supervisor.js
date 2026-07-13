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
  reapDecision,
} from './server-registry.js';
import { treeKill, isPidAlive, sweepByCmd } from './prockill.js';
import { resolveShellSpawn } from './spawn-cmd.js';
import { alert } from './notify.js';
import { log } from './logger.js';

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
const READY_TIMEOUT_MS = 20000; // budget max d'attente qu'un serveur neuf reponde sur /mcp.
const READY_POLL_MS = 200;
const LOCK_STALE_MS = 60000; // un verrou plus vieux que ca est vole (proxy mort en tenant le lock).
const DEFAULT_TTL_MS = 90000; // sans heartbeat client depuis 90s => serveur reape.
const HEARTBEAT_MS = 30000; // periode de battement client (< ttl/2 => 2 battements avant reap).

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
  constructor(configPath, { ttl = DEFAULT_TTL_MS, clientId = String(process.pid), ntfyUrl = null } = {}) {
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
  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) || emptyRegistry();
    } catch {
      return emptyRegistry(); // absent/corrompu : on repart d'un registre vide (self-heal)
    }
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
    for (let i = 0; i < 600; i++) { // ~600*50ms = 30s de patience max
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
        if (stale) { if (!this._tryStealStale(stealPath)) await this._delay(50); }
        else await this._delay(50);
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
  async _pollReady(port, budget = READY_TIMEOUT_MS) {
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

    return this._withLock(async () => {
      let reg = this._read();
      let entry = serverEntry(reg, profile);
      // Re-verifie sous verrou (un autre proxy a pu gagner la course pendant l'attente du lock).
      if (entry && isPidAlive(entry.pid) && (await this._probeReady(entry.port))) return this.urlFor(entry.port);

      // Entree morte : on la purge (tree-kill best-effort si le pid traine encore).
      if (entry) {
        if (isPidAlive(entry.pid)) { try { treeKill(entry.pid); } catch {} }
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
        pid = await this._spawnReady(profile, this._read(), spec);
      }
      if (pid == null) throw new Error(`serveur ${profile} pas pret apres ${READY_TIMEOUT_MS}ms`);

      let out = withServer(this._read(), profile, { port: this._lastPort, pid, spawnedAt: Date.now() });
      out = withClient(out, profile, this.clientId, Date.now()); // je m'enregistre immediatement
      this._write(out);
      log(`[supervisor:${profile}] serveur pret pid=${pid} ${this.urlFor(this._lastPort)}`);
      return this.urlFor(this._lastPort);
    });
  }

  // Spawn detache d'un serveur + attente readiness. Retourne le pid si pret, sinon null (apres tree-kill
  // de la tentative ratee). _lastPort porte le port choisi (relu par ensureServer pour l'enregistrement).
  async _spawnReady(profile, reg, spec) {
    const port = pickPort(reg, profile);
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
    child.on('error', (e) => log(`[supervisor:${profile}] spawn error: ${e.message}`));
    const pid = child.pid;
    child.unref(); // ⚠️ ne pas retenir l'event loop du proxy sur ce serveur detache
    if (await this._pollReady(port)) return pid;
    try { treeKill(pid); } catch {}
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
        const reg = withClient(this._read(), profile, this.clientId, Date.now());
        this._write(reg);
      });
    } catch (e) {
      log(`[supervisor:${profile}] heartbeat rate: ${e.message}`);
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
      log(`[supervisor:${profile}] unregister rate: ${e.message}`);
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
        const { reap, kept } = reapDecision(reg, alive, Date.now(), this.ttl);
        for (const r of reap) {
          try { treeKill(r.pid); } catch {}
          log(`[supervisor] reap ${r.profile} (${r.reason}) pid=${r.pid} port=${r.port}`);
          // ⚠️ Dead-man (doctrine « crier quand ca meurt ») : un serveur DEAD = mort INATTENDUE (crash)
          // vs 'idle' = fin de vie NORMALE (plus de client). On alerte UNIQUEMENT le crash pour reperer
          // une boucle de mort, sinon le self-heal respawn masquerait un backend qui plante en silence.
          if (r.reason === 'dead') {
            alert(`serveur @playwright/mcp du profil "${r.profile}" MORT inopinement (pid=${r.pid}, port=${r.port}) — reape. Verifier un crash en boucle.`, this.ntfyUrl);
          }
        }
        if (reap.length) this._write(kept);
      });
    } catch (e) {
      log(`[supervisor] reap rate: ${e.message}`);
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
