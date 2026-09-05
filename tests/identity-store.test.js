// identity-store.test.js — I/O du coffre d'identités, dossiers TEMPORAIRES RÉELS (mkdtempSync).
// Cible : src/identity-store.js. La DÉCISION (filtre, plafonds, éviction) est déjà mutation-testée
// dans identity-store-pure.test.js — ici on vérifie que l'I/O EXÉCUTE fidèlement cette décision :
// copie filtrée réelle, atomicité par rename (negative-check (g)), refus nommés, idempotence.

import { test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  materialiser,
  snapshotRetour,
  supprimerInstance,
  mesurer,
  evincer,
} from '../src/identity-store.js';

const dirsToClean = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirsToClean.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirsToClean.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function ecrire(dir, relPath, contenu = 'x') {
  const p = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contenu);
}

function fauxProfil(dir) {
  ecrire(dir, 'Default/Cookies', 'cookie-data');
  ecrire(dir, 'Default/Cache/data_0', 'cache-data');
  ecrire(dir, 'Default/Service Worker/CacheStorage/x', 'sw-cache');
  ecrire(dir, 'Default/Service Worker/Database/y', 'sw-db');
  ecrire(dir, 'SingletonLock', 'lock');
}

// (a) materialiser snapshot copie tout SAUF les exclus ────────────────────────────────────────
test('materialiser snapshot copie tout SAUF les exclus (caches, verrous)', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');
  fauxProfil(path.join(storeDir, 'vegeta'));

  const dir = await materialiser({
    identite: 'vegeta',
    strategie: 'snapshot',
    storeDir,
    instancesDir,
    instanceId: 'vegeta-1',
  });

  expect(dir).toBe(path.join(instancesDir, 'vegeta-1'));
  expect(fs.existsSync(path.join(dir, 'Default/Cookies'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'Default/Service Worker/Database/y'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'Default/Cache/data_0'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'Default/Service Worker/CacheStorage/x'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'SingletonLock'))).toBe(false);
});

// (b) identité absente du coffre ⇒ dossier d'instance vide créé ────────────────────────────────
test('identité absente du coffre : dossier d instance VIDE créé (identité qui naît)', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');

  const dir = await materialiser({
    identite: 'nouvelle',
    strategie: 'snapshot',
    storeDir,
    instancesDir,
    instanceId: 'nouvelle-1',
  });

  expect(fs.existsSync(dir)).toBe(true);
  expect(fs.readdirSync(dir)).toEqual([]);
});

// (c) instance déjà existante ⇒ throw nommé ─────────────────────────────────────────────────────
test('instance déjà existante : REFUS nommé, jamais écrasée', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');
  fauxProfil(path.join(storeDir, 'vegeta'));
  fs.mkdirSync(path.join(instancesDir, 'vegeta-1'), { recursive: true });
  ecrire(path.join(instancesDir, 'vegeta-1'), 'temoin', 'ne-pas-toucher');

  await expect(materialiser({
    identite: 'vegeta',
    strategie: 'snapshot',
    storeDir,
    instancesDir,
    instanceId: 'vegeta-1',
  })).rejects.toThrow(/existe déjà/);

  // le témoin n'a pas bougé : le refus n'a rien écrasé
  expect(fs.readFileSync(path.join(instancesDir, 'vegeta-1', 'temoin'), 'utf8')).toBe('ne-pas-toucher');
});

// (d) inplace rend le chemin du coffre, sans copie ──────────────────────────────────────────────
test('inplace rend le chemin du COFFRE directement, sans copie', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');
  fauxProfil(path.join(storeDir, 'perso'));

  const dir = await materialiser({
    identite: 'perso',
    strategie: 'inplace',
    storeDir,
    instancesDir,
    instanceId: 'ignore',
  });

  expect(dir).toBe(path.join(storeDir, 'perso'));
  // aucune instance n'a été créée sous instancesDir
  expect(fs.readdirSync(instancesDir)).toEqual([]);
});

test('inplace : identité absente crée le dossier du coffre (vide)', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');

  const dir = await materialiser({
    identite: 'neuve',
    strategie: 'inplace',
    storeDir,
    instancesDir,
    instanceId: 'ignore',
  });

  expect(fs.existsSync(dir)).toBe(true);
});

// (e) snapshotRetour crée le snapshot, écrit la métadonnée, taille cohérente ────────────────────
test('snapshotRetour crée le snapshot + .pw-mcp-identite.json, taille cohérente', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instanceDir = tmpDir('pw-idstore-instance-');
  fauxProfil(instanceDir);

  const res = await snapshotRetour({
    identite: 'vegeta',
    storeDir,
    instanceDir,
    plafonds: { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 },
  });

  expect(res.ok).toBe(true);
  const identiteDir = path.join(storeDir, 'vegeta');
  expect(fs.existsSync(path.join(identiteDir, 'Default/Cookies'))).toBe(true);
  expect(fs.existsSync(path.join(identiteDir, 'Default/Cache/data_0'))).toBe(false);

  const meta = JSON.parse(fs.readFileSync(path.join(identiteDir, '.pw-mcp-identite.json'), 'utf8'));
  expect(meta.octets).toBe(res.octets);
  expect(typeof meta.dernierUsageMs).toBe('number');
  // la taille rendue == taille réelle mesurée après coup (cookie-data + sw-db, hors caches/lock)
  const octetsCookies = fs.statSync(path.join(identiteDir, 'Default/Cookies')).size;
  const octetsSwDb = fs.statSync(path.join(identiteDir, 'Default/Service Worker/Database/y')).size;
  expect(res.octets).toBeGreaterThanOrEqual(octetsCookies + octetsSwDb);
});

// (f) snapshotRetour REMPLACE un ancien snapshot ────────────────────────────────────────────────
test('snapshotRetour REMPLACE l ancien snapshot (fichier disparu de l instance disparaît du coffre)', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instanceDir = tmpDir('pw-idstore-instance-');
  ecrire(instanceDir, 'Default/Cookies', 'v1');
  ecrire(instanceDir, 'Default/Web Data', 'sera-retire');

  const r1 = await snapshotRetour({
    identite: 'vegeta', storeDir, instanceDir,
    plafonds: { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 },
  });
  expect(r1.ok).toBe(true);
  expect(fs.existsSync(path.join(storeDir, 'vegeta', 'Default/Web Data'))).toBe(true);

  // l'instance évolue : le fichier disparaît, le contenu change
  fs.rmSync(path.join(instanceDir, 'Default/Web Data'));
  fs.writeFileSync(path.join(instanceDir, 'Default/Cookies'), 'v2');

  const r2 = await snapshotRetour({
    identite: 'vegeta', storeDir, instanceDir,
    plafonds: { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 },
  });
  expect(r2.ok).toBe(true);
  expect(fs.existsSync(path.join(storeDir, 'vegeta', 'Default/Web Data'))).toBe(false);
  expect(fs.readFileSync(path.join(storeDir, 'vegeta', 'Default/Cookies'), 'utf8')).toBe('v2');
  // aucun résidu .tmp-*/.old-* laissé derrière
  const restes = fs.readdirSync(storeDir);
  expect(restes.filter((n) => n.includes('.tmp-') || n.includes('.old-'))).toEqual([]);
});

// (g) NEGATIVE-CHECK D'ATOMICITÉ : au-dessus du plafond ⇒ refus, ancien snapshot INTACT ─────────
test('snapshotRetour au-dessus du plafond : REFUS nommé, ANCIEN snapshot INTACT octet pour octet', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instanceDir = tmpDir('pw-idstore-instance-');
  ecrire(instanceDir, 'Default/Cookies', 'contenu-ancien-intact');

  const r1 = await snapshotRetour({
    identite: 'vegeta', storeDir, instanceDir,
    plafonds: { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 },
  });
  expect(r1.ok).toBe(true);
  const identiteDir = path.join(storeDir, 'vegeta');
  const avant = fs.readFileSync(path.join(identiteDir, 'Default/Cookies'), 'utf8');
  const metaAvant = fs.readFileSync(path.join(identiteDir, '.pw-mcp-identite.json'), 'utf8');

  // instance grossit au-delà d'un plafond volontairement bas (1 Mio) : 2 Mio de contenu
  fs.writeFileSync(path.join(instanceDir, 'Default/Cookies'), 'x'.repeat(2 * 1024 * 1024));

  const r2 = await snapshotRetour({
    identite: 'vegeta', storeDir, instanceDir,
    plafonds: { maxParIdentiteMo: 1, maxTotalMo: 6000, retentionJours: 30 }, // 1 MiB — dépassé par les 2 Mio écrits
  });

  expect(r2.ok).toBe(false);
  expect(typeof r2.raison).toBe('string');
  expect(r2.raison.length).toBeGreaterThan(0);

  // ANCIEN snapshot INTACT, octet pour octet
  expect(fs.readFileSync(path.join(identiteDir, 'Default/Cookies'), 'utf8')).toBe(avant);
  expect(fs.readFileSync(path.join(identiteDir, '.pw-mcp-identite.json'), 'utf8')).toBe(metaAvant);
  // aucun résidu .tmp-* laissé derrière
  const restes = fs.readdirSync(storeDir);
  expect(restes.filter((n) => n.includes('.tmp-'))).toEqual([]);
});

// (h) nom d'identité invalide ⇒ throw, rien écrit ───────────────────────────────────────────────
test('nom d identité invalide (../x) : throw, RIEN écrit sur disque', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  const instancesDir = tmpDir('pw-idstore-inst-');

  await expect(materialiser({
    identite: '../x',
    strategie: 'snapshot',
    storeDir,
    instancesDir,
    instanceId: 'x-1',
  })).rejects.toThrow(/invalide/);

  expect(fs.readdirSync(storeDir)).toEqual([]);
  expect(fs.readdirSync(instancesDir)).toEqual([]);

  const instanceDir = tmpDir('pw-idstore-instance-');
  await expect(snapshotRetour({
    identite: '../x',
    storeDir,
    instanceDir,
    plafonds: { maxParIdentiteMo: 300, maxTotalMo: 6000, retentionJours: 30 },
  })).rejects.toThrow(/invalide/);
  expect(fs.readdirSync(storeDir)).toEqual([]);
});

// (i) mesurer rend octets + dernierUsageMs et ignore .tmp-*/.old-* ─────────────────────────────
test('mesurer rend octets + dernierUsageMs par identité, ignore les résidus .tmp-*/.old-*', async () => {
  const storeDir = tmpDir('pw-idstore-store-');
  ecrire(path.join(storeDir, 'vegeta', 'Default/Cookies'), 'aaaa');
  fs.writeFileSync(
    path.join(storeDir, 'vegeta', '.pw-mcp-identite.json'),
    JSON.stringify({ dernierUsageMs: 12345, octets: 4 }),
  );
  ecrire(path.join(storeDir, 'perso', 'Default/Cookies'), 'bb'); // pas de meta ⇒ dernierUsageMs undefined
  fs.mkdirSync(path.join(storeDir, 'vegeta.tmp-999'), { recursive: true });
  ecrire(path.join(storeDir, 'vegeta.tmp-999', 'x'), 'ignoré');
  fs.mkdirSync(path.join(storeDir, 'vegeta.old-999'), { recursive: true });

  const entrees = mesurer(storeDir);
  const noms = entrees.map((e) => e.identite).sort();
  expect(noms).toEqual(['perso', 'vegeta']);

  const vegeta = entrees.find((e) => e.identite === 'vegeta');
  expect(vegeta.dernierUsageMs).toBe(12345);
  expect(vegeta.octets).toBeGreaterThan(0);

  const perso = entrees.find((e) => e.identite === 'perso');
  expect(perso.dernierUsageMs).toBeUndefined();
});

test('mesurer sur un coffre absent rend un tableau vide (pas une erreur)', () => {
  expect(mesurer(path.join(os.tmpdir(), 'pw-idstore-jamais-cree-' + Date.now()))).toEqual([]);
});

// (j) evincer supprime exactement le plan, idempotent ───────────────────────────────────────────
test('evincer supprime EXACTEMENT le plan, idempotent', () => {
  const storeDir = tmpDir('pw-idstore-store-');
  ecrire(path.join(storeDir, 'a'), 'f', '1');
  ecrire(path.join(storeDir, 'b'), 'f', '1');
  ecrire(path.join(storeDir, 'c'), 'f', '1');

  const plan = { evincer: [{ identite: 'a', motif: 'retention' }, { identite: 'b', motif: 'plafond-total' }] };
  const supprimees = evincer(storeDir, plan);

  expect(supprimees.sort()).toEqual(['a', 'b']);
  expect(fs.existsSync(path.join(storeDir, 'a'))).toBe(false);
  expect(fs.existsSync(path.join(storeDir, 'b'))).toBe(false);
  expect(fs.existsSync(path.join(storeDir, 'c'))).toBe(true); // hors plan : intact

  // rejouer le même plan : idempotent, pas d'erreur, rien de plus supprimé
  const supprimees2 = evincer(storeDir, plan);
  expect(supprimees2.sort()).toEqual(['a', 'b']);
  expect(fs.existsSync(path.join(storeDir, 'c'))).toBe(true);
});

test('evincer refuse un nom invalide dans le plan sans toucher au reste', () => {
  const storeDir = tmpDir('pw-idstore-store-');
  ecrire(path.join(storeDir, 'a'), 'f', '1');
  const plan = { evincer: [{ identite: '../etc', motif: 'retention' }] };
  const supprimees = evincer(storeDir, plan);
  expect(supprimees).toEqual([]);
  expect(fs.existsSync(path.join(storeDir, 'a'))).toBe(true);
});

// (k) supprimerInstance idempotent ──────────────────────────────────────────────────────────────
test('supprimerInstance idempotent — dossier existant puis déjà absent, jamais de throw', () => {
  const instanceDir = tmpDir('pw-idstore-instance-');
  ecrire(instanceDir, 'Default/Cookies', 'x');

  expect(() => supprimerInstance(instanceDir)).not.toThrow();
  expect(fs.existsSync(instanceDir)).toBe(false);

  expect(() => supprimerInstance(instanceDir)).not.toThrow(); // déjà absent : idempotent
  expect(() => supprimerInstance(path.join(instanceDir, 'inexistant-imbrique'))).not.toThrow();
});
