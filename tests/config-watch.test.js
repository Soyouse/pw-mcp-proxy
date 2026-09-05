// I/O RÉELLE — la surveillance de config sur un vrai système de fichiers (config-watch.js).
// Ce que ça prouve, sur CET OS : ① une sauvegarde ATOMIQUE (rename) est vue ② une écriture en deux
// temps finit par charger le contenu COMPLET, jamais le tronqué ③ une ré-écriture IDENTIQUE ne
// recharge rien ④ un fichier tenu (EBUSY) est relu au calendrier, sans attente réelle (délai injecté)
// ⑤ calendrier épuisé ⇒ ALERTE ⑥ `fs.watch` refusé ⇒ REPLI sondage, crié, et le changement est quand
// même vu ⑦ `fermer()` arrête tout. Zéro `setTimeout` d'attente aveugle : on attend un FAIT (appel).
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { surveillerConfig } from '../src/config-watch.js';
import { empreinte } from '../src/config-watch-pure.js';
import { CONFIG_WATCH_INTERVAL_MS } from '../src/budget.js';

function scene() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cfgwatch-'));
  const chemin = path.join(dir, 'profiles.json');
  fs.writeFileSync(chemin, '{"v":1}');
  const charges = [];
  const logs = [];
  const alertes = [];
  return { dir, chemin, charges, logs, alertes, opts: { hashInitial: empreinte('{"v":1}'), onContenu: (t) => charges.push(t), log: (m) => logs.push(m), alerter: (m) => alertes.push(m) } };
}
const attendre = (pred, budgetMs = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function boucle() { if (pred()) return res(undefined); if (Date.now() - t0 > budgetMs) return rej(new Error('fait jamais observé')); setImmediate(boucle); })();
});
const ecrireAtomique = (chemin, contenu) => { const tmp = chemin + '.tmp'; fs.writeFileSync(tmp, contenu); fs.renameSync(tmp, chemin); };

test('sauvegarde ATOMIQUE (rename) ⇒ contenu chargé une fois, mode événement', async () => {
  const s = scene();
  const w = surveillerConfig(s.chemin, s.opts);
  try {
    expect(w.mode()).toBe('evenement');
    ecrireAtomique(s.chemin, '{"v":2}');
    await attendre(() => s.charges.length >= 1);
    expect(s.charges).toEqual(['{"v":2}']);
    expect(s.alertes).toEqual([]);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('ré-écriture IDENTIQUE ⇒ aucun rechargement (événement double / antivirus absorbés)', async () => {
  const s = scene();
  const w = surveillerConfig(s.chemin, s.opts);
  try {
    fs.writeFileSync(s.chemin, '{"v":1}');
    fs.writeFileSync(s.chemin, '{"v":1}');
    await w.verifier(); // force une vérification APRÈS les événements : verdict = identique
    expect(s.charges).toEqual([]);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('écriture en DEUX temps ⇒ le tronqué est ignoré (nommé), le complet est chargé', async () => {
  const s = scene();
  const w = surveillerConfig(s.chemin, s.opts);
  try {
    const fd = fs.openSync(s.chemin, 'w'); // tronque ⇒ événement(s) sur un fichier vide/partiel
    fs.writeSync(fd, '{"v":');
    await w.verifier();
    expect(s.charges).toEqual([]);
    expect(s.logs.some((l) => /illisible/.test(l))).toBe(true);
    fs.writeSync(fd, '3}');
    fs.closeSync(fd);
    await attendre(() => s.charges.length >= 1);
    expect(s.charges).toEqual(['{"v":3}']);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('contenu REFUSÉ par onContenu ⇒ empreinte non avancée : rejugé au réveil suivant', async () => {
  const s = scene();
  let refuser = true;
  s.opts.onContenu = (t) => { if (refuser) throw new Error('config refusée par le manager'); s.charges.push(t); };
  const w = surveillerConfig(s.chemin, s.opts);
  try {
    fs.writeFileSync(s.chemin, '{"v":4}');
    await w.verifier();
    expect(s.charges).toEqual([]);
    expect(s.logs.some((l) => /IGNOREE.*refusée/.test(l))).toBe(true);
    refuser = false;
    await w.verifier(); // même contenu, mais jamais accepté ⇒ rejugé, cette fois chargé
    expect(s.charges).toEqual(['{"v":4}']);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('fichier TENU (EBUSY ×2) ⇒ relu au calendrier déclaré, sans attente réelle, puis chargé', async () => {
  const s = scene();
  let refus = 2;
  const pauses = [];
  const fsImpl = { ...fs, promises: { readFile: async (p) => { if (refus-- > 0) { const e = new Error('busy'); /** @type {any} */ (e).code = 'EBUSY'; throw e; } return fs.promises.readFile(p); } } };
  const w = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl), delai: async (ms) => { pauses.push(ms); } });
  try {
    fs.writeFileSync(s.chemin, '{"v":5}');
    await w.verifier();
    expect(pauses).toEqual([100, 500]);
    expect(s.charges).toEqual(['{"v":5}']);
    expect(s.alertes).toEqual([]);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('fichier TENU au-delà du calendrier ⇒ ALERTE nommée, rien chargé, ancienne config gardée', async () => {
  const s = scene();
  const fsImpl = { ...fs, promises: { readFile: async () => { const e = new Error('perm'); /** @type {any} */ (e).code = 'EPERM'; throw e; } } };
  const w = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl), delai: async () => {} });
  try {
    await w.verifier();
    expect(s.charges).toEqual([]);
    expect(s.alertes).toHaveLength(1);
    expect(s.alertes[0]).toMatch(/illisible après 4 essais/);
    expect(s.alertes[0]).toMatch(/PEUT-ÊTRE PERDU/);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('erreur de lecture NON transitoire ⇒ loggée, pas rejouée, pas d alerte', async () => {
  const s = scene();
  let appels = 0;
  const fsImpl = { ...fs, promises: { readFile: async () => { appels++; const e = new Error('dir'); /** @type {any} */ (e).code = 'EISDIR'; throw e; } } };
  const w = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl), delai: async () => { throw new Error('aucun délai attendu'); } });
  try {
    await w.verifier();
    expect(appels).toBe(1);
    expect(s.charges).toEqual([]);
    expect(s.alertes).toEqual([]);
    expect(s.logs.some((l) => /lecture impossible/.test(l))).toBe(true);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('fs.watch REFUSÉ (NFS/SMB) ⇒ REPLI sondage crié, et le changement est quand même vu', async () => {
  const s = scene();
  const fsImpl = { ...fs, watch: () => { throw new Error('ENOSYS: watch non supporté'); } };
  const w = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl) });
  try {
    expect(w.mode()).toBe('sondage');
    expect(s.logs.some((l) => /REPLI sur sondage/.test(l) && l.includes(String(CONFIG_WATCH_INTERVAL_MS)))).toBe(true);
    // watchFile compare les mtime : forcer un mtime distinct de celui de la création (granularité 1 s sur certains FS)
    fs.writeFileSync(s.chemin, '{"v":6}');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(s.chemin, t, t);
    await attendre(() => s.charges.length >= 1, 3 * CONFIG_WATCH_INTERVAL_MS + 2000);
    expect(s.charges).toEqual(['{"v":6}']);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
}, 15000);

test('watcher qui émet `error` APRÈS coup ⇒ bascule sondage (une seule fois)', async () => {
  const s = scene();
  const w = surveillerConfig(s.chemin, s.opts);
  try {
    // On provoque l'erreur sur le vrai FSWatcher : c'est l'événement que Node émet quand l'OS lâche.
    const dirWatchers = [];
    const fsImpl = { ...fs, watch: (...a) => { const x = fs.watch(...a); dirWatchers.push(x); return x; } };
    const w2 = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl) });
    dirWatchers[0].emit('error', new Error('EPERM: dossier retiré'));
    dirWatchers[0].emit('error', new Error('encore'));
    expect(w2.mode()).toBe('sondage');
    expect(s.logs.filter((l) => /REPLI sur sondage/.test(l))).toHaveLength(1);
    w2.fermer();
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('fermer() : plus aucun chargement après, même sur changement réel', async () => {
  const s = scene();
  const w = surveillerConfig(s.chemin, s.opts);
  w.fermer();
  try {
    ecrireAtomique(s.chemin, '{"v":7}');
    await w.verifier();
    expect(s.charges).toEqual([]);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('coalescence : N réveils pendant une vérification ⇒ une vérification de plus, jamais N lectures parallèles', async () => {
  const s = scene();
  let lecturesEnVol = 0; let maxEnVol = 0; let total = 0;
  const fsImpl = { ...fs, promises: { readFile: async (p) => { total++; lecturesEnVol++; maxEnVol = Math.max(maxEnVol, lecturesEnVol); await new Promise((r) => setImmediate(r)); lecturesEnVol--; return fs.promises.readFile(p); } } };
  const w = surveillerConfig(s.chemin, { ...s.opts, fsImpl: /** @type {any} */ (fsImpl) });
  try {
    fs.writeFileSync(s.chemin, '{"v":8}');
    const p = Promise.all([w.verifier(), w.verifier(), w.verifier(), w.verifier()]);
    await p;
    expect(maxEnVol).toBe(1);
    expect(total).toBe(2); // la première + UNE relance coalescée
    expect(s.charges).toEqual(['{"v":8}']);
  } finally { w.fermer(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
