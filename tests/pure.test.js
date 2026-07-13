// Tests UNITE des fonctions pures (decision isolee de l'I/O). Cible de la mutation Stryker.
// Exhaustifs par construction : chaque branche + chaque borne, pour ne laisser survivre aucun mutant.
// + property-based (fast-check) sur les invariants forts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  INJECTED_TOOL_NAMES,
  FALLBACK_PREFIX,
  detectCollisions,
  canonicalInjectedName,
  exposedName,
  isOurToolCall,
} from '../src/collision.js';
import { normPath, selectVictims } from '../src/prockill-pure.js';
import { buildSpec, DEFAULT_BACKEND } from '../src/spec.js';
import { resolveShellSpawn } from '../src/spawn-cmd.js';

// ========================= collision.js =========================

test('detectCollisions : aucun homonyme => []', () => {
  assert.deepEqual(detectCollisions(['browser_click', 'browser_type']), []);
});

test('detectCollisions : detecte chaque tool maison homonyme', () => {
  assert.deepEqual(detectCollisions(['browser_click', 'switch_profile']), ['switch_profile']);
  assert.deepEqual(
    detectCollisions(['restart_profile', 'current_profile', 'switch_profile']).sort(),
    ['current_profile', 'restart_profile', 'switch_profile']
  );
});

test('detectCollisions : deduplique et preserve l ordre d apparition', () => {
  assert.deepEqual(detectCollisions(['switch_profile', 'x', 'switch_profile']), ['switch_profile']);
});

test('detectCollisions : entree vide / nulle => []', () => {
  assert.deepEqual(detectCollisions([]), []);
  assert.deepEqual(detectCollisions(null), []);
  assert.deepEqual(detectCollisions(undefined), []);
});

test('canonicalInjectedName : nom nu injecte => lui-meme', () => {
  for (const n of INJECTED_TOOL_NAMES) assert.equal(canonicalInjectedName(n), n);
});

test('canonicalInjectedName : prefixe proxy_ => nom canonique', () => {
  assert.equal(canonicalInjectedName('proxy_switch_profile'), 'switch_profile');
  assert.equal(canonicalInjectedName('proxy_current_profile'), 'current_profile');
  assert.equal(canonicalInjectedName('proxy_restart_profile'), 'restart_profile');
});

test('canonicalInjectedName : non injecte / proxy_ inconnu / vide => null', () => {
  assert.equal(canonicalInjectedName('browser_click'), null);
  assert.equal(canonicalInjectedName('proxy_browser_click'), null);
  assert.equal(canonicalInjectedName(''), null);
  assert.equal(canonicalInjectedName(null), null);
  assert.equal(canonicalInjectedName(undefined), null);
});

test('canonicalInjectedName : SEUL le prefixe exact proxy_ compte (pas un slice(6) hasardeux)', () => {
  // 6 chars quelconques + un nom injecte, MAIS ne commence PAS par "proxy_" => doit rester null.
  // (tue le mutant qui transformerait le `startsWith('proxy_')` en `true`.)
  assert.equal(canonicalInjectedName('ABCDEFswitch_profile'), null);
  assert.equal(canonicalInjectedName('xproxyswitch_profile'), null);
});

test('exposedName : sans collision => nom nu ; avec collision => prefixe proxy_', () => {
  assert.equal(exposedName('switch_profile', []), 'switch_profile');
  assert.equal(exposedName('switch_profile', ['current_profile']), 'switch_profile'); // collision sur un AUTRE
  assert.equal(exposedName('switch_profile', ['switch_profile']), FALLBACK_PREFIX + 'switch_profile');
  assert.equal(exposedName('switch_profile', null), 'switch_profile');
});

test('isOurToolCall : nom nu sans collision => a nous (true)', () => {
  assert.equal(isOurToolCall('switch_profile', []), true);
});

test('isOurToolCall : nom nu EN collision => tool backend (false)', () => {
  assert.equal(isOurToolCall('switch_profile', ['switch_profile']), false);
});

test('isOurToolCall : appel via proxy_ => TOUJOURS a nous, meme en collision', () => {
  assert.equal(isOurToolCall('proxy_switch_profile', ['switch_profile']), true);
  assert.equal(isOurToolCall('proxy_switch_profile', []), true);
});

test('isOurToolCall : nom non injecte => false', () => {
  assert.equal(isOurToolCall('browser_click', []), false);
  assert.equal(isOurToolCall('browser_click', ['switch_profile']), false);
});

// ========================= prockill-pure.js =========================

test('normPath : backslash -> slash, null -> chaine vide', () => {
  assert.equal(normPath('C:\\Users\\alice\\.pw-profiles\\perso'), 'C:/Users/alice/.pw-profiles/perso');
  assert.equal(normPath('deja/en/slash'), 'deja/en/slash');
  assert.equal(normPath(null), '');
  assert.equal(normPath(undefined), '');
});

const P = (pid, cmd) => ({ pid, cmd });

test('selectVictims : matche le needle, retourne les PID', () => {
  const procs = [P(10, 'chrome --user-data-dir=C:/x/.pw-profiles/vegeta'), P(11, 'autre chose')];
  assert.deepEqual(selectVictims(procs, ['.pw-profiles/vegeta'], 999), [10]);
});

test('selectVictims : exclut TOUJOURS self', () => {
  const procs = [P(42, 'node .pw-profiles/vegeta')];
  assert.deepEqual(selectVictims(procs, ['.pw-profiles/vegeta'], 42), []);
});

test('selectVictims : cross-OS, needle en / matche une cmdline en backslash', () => {
  // crashpad-handler enfant ecrit le chemin en backslash ; le needle est en slash.
  const procs = [P(7, 'crashpad --user-data-dir=C:\\Users\\alice\\.pw-profiles\\perso')];
  assert.deepEqual(selectVictims(procs, ['.pw-profiles/perso'], 999), [7]);
});

test('selectVictims : needles vide => [] (jamais de sweep large)', () => {
  const procs = [P(1, 'nimporte quoi')];
  assert.deepEqual(selectVictims(procs, [], 999), []);
  assert.deepEqual(selectVictims(procs, [null, '', undefined], 999), []);
});

test('selectVictims : aucun match => []', () => {
  assert.deepEqual(selectVictims([P(1, 'aaa'), P(2, 'bbb')], ['zzz'], 999), []);
});

test('selectVictims : plusieurs needles, plusieurs victimes', () => {
  const procs = [P(1, 'x/vegeta'), P(2, 'x/perso'), P(3, 'rien')];
  assert.deepEqual(selectVictims(procs, ['vegeta', 'perso'], 999).sort((a, b) => a - b), [1, 2]);
});

test('selectVictims : procs nul / entrees nulles => robuste', () => {
  assert.deepEqual(selectVictims(null, ['x'], 1), []);
  assert.deepEqual(selectVictims([null, P(5, 'x')], ['x'], 1), [5]);
});

// ========================= spec.js =========================

test('buildSpec : backend par defaut si rien de defini', () => {
  const s = buildSpec('vegeta', {}, {});
  assert.equal(s.command, 'npx'); // litteral (PAS DEFAULT_BACKEND.command : muterait avec le code)
  assert.equal(DEFAULT_BACKEND.command, 'npx');
  assert.deepEqual(s.args, ['-y', '@playwright/mcp@latest']);
  assert.equal(s.label, 'vegeta');
});

test('buildSpec : backend override SANS args => args de base vides', () => {
  const s = buildSpec('p', { backend: { command: 'solo' } }, {}); // pas de backend.args
  assert.equal(s.command, 'solo');
  assert.deepEqual(s.args, []); // tue le mutant `backend.args || ["..."]`
});

test('buildSpec : backend global utilise si pas d override profil', () => {
  const s = buildSpec('p', {}, { backend: { command: 'node', args: ['x.js'] } });
  assert.equal(s.command, 'node');
  assert.deepEqual(s.args, ['x.js']);
});

test('buildSpec : backend du profil prime sur le global', () => {
  const s = buildSpec('p', { backend: { command: 'a', args: ['1'] } }, { backend: { command: 'b', args: ['2'] } });
  assert.equal(s.command, 'a');
  assert.deepEqual(s.args, ['1']);
});

test('buildSpec : caps profil > caps global ; [] => pas de --caps', () => {
  assert.ok(buildSpec('p', { caps: ['storage'] }, { caps: ['pdf'] }).args.includes('--caps=storage'));
  assert.ok(buildSpec('p', {}, { caps: ['pdf', 'vision'] }).args.includes('--caps=pdf,vision'));
  assert.ok(!buildSpec('p', { caps: [] }, { caps: ['pdf'] }).args.some((a) => a.startsWith('--caps=')));
  assert.ok(!buildSpec('p', {}, {}).args.some((a) => a.startsWith('--caps=')));
});

test('buildSpec : userDataDir ajoute --user-data-dir <path>', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x/perso' }, {});
  const i = s.args.indexOf('--user-data-dir');
  assert.ok(i >= 0);
  assert.equal(s.args[i + 1], 'C:/x/perso');
});

// resolveShellSpawn : decision de spawn cross-OS (source unique stdio-transport + supervisor).
test('resolveShellSpawn : Windows + commande bare (npx) => shell:true (sinon le serveur ne demarre pas)', () => {
  const r = resolveShellSpawn('npx', ['-y', '@playwright/mcp@0.0.78'], 'win32');
  assert.equal(r.shell, true, 'bare command sur win => shell requis');
  assert.equal(r.command, 'npx');
});

test('resolveShellSpawn : Windows + binaire absolu .exe => shell:false', () => {
  const r = resolveShellSpawn('C:/Program Files/node/node.exe', ['x.js'], 'win32');
  assert.equal(r.shell, false, '.exe absolu => pas de shell (espace dans le chemin casserait)');
});

test('resolveShellSpawn : Windows + shell => quote les args a espaces', () => {
  const r = resolveShellSpawn('npx', ['--user-data-dir', 'C:/mes profils/x'], 'win32');
  assert.ok(r.args.includes('"C:/mes profils/x"'), 'arg a espace quote pour le shell');
  assert.ok(r.args.includes('--user-data-dir'), 'arg sans espace non quote');
});

test('resolveShellSpawn : POSIX => jamais de shell (detached/kill de groupe gere ailleurs)', () => {
  const r = resolveShellSpawn('npx', ['-y', 'pkg'], 'linux');
  assert.equal(r.shell, false);
  assert.deepEqual(r.args, ['-y', 'pkg'], 'args intacts (pas de quoting hors shell)');
});

test('resolveShellSpawn : Windows + chemin ABSOLU sans extension => shell:false (isAbsolute suffit)', () => {
  assert.equal(resolveShellSpawn('C:/tools/runner', [], 'win32').shell, false);
  assert.equal(resolveShellSpawn('C:\\tools\\runner', [], 'win32').shell, false, 'backslash aussi absolu');
});

test('resolveShellSpawn : Windows + RELATIF mais .exe/.com => shell:false (isBinary suffit)', () => {
  assert.equal(resolveShellSpawn('runner.exe', [], 'win32').shell, false, '.exe relatif = binaire');
  assert.equal(resolveShellSpawn('runner.COM', [], 'win32').shell, false, '.com insensible a la casse');
});

test('resolveShellSpawn : Windows + chemin POSIX-absolu (/usr/bin) => shell:false', () => {
  assert.equal(resolveShellSpawn('/usr/bin/node', [], 'win32').shell, false, 'slash de tete = absolu');
});

test('buildSpec : isolated ajoute --isolated (et EXCLUT --user-data-dir)', () => {
  const s = buildSpec('anon', { isolated: true, userDataDir: 'C:/ignore' }, {});
  assert.ok(s.args.includes('--isolated'), 'flag --isolated present');
  assert.ok(!s.args.includes('--user-data-dir'), 'isolated l emporte : pas de --user-data-dir');
});

test('buildSpec : sans isolated, userDataDir seul => --user-data-dir (pas --isolated)', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x' }, {});
  assert.ok(!s.args.includes('--isolated'));
  assert.ok(s.args.includes('--user-data-dir'));
});

test('buildSpec : HTTP + persistant => --shared-browser-context (multi-agent, contrat documente)', () => {
  const s = buildSpec('vegeta', { userDataDir: 'C:/x' }, {}, { http: true });
  assert.ok(s.args.includes('--shared-browser-context'), 'persistant multi-client partage le contexte');
  assert.ok(s.args.includes('--user-data-dir'));
});

test('buildSpec : HTTP + isolated => PAS de --shared-browser-context (deja parallele)', () => {
  const s = buildSpec('anon', { isolated: true }, {}, { http: true });
  assert.ok(!s.args.includes('--shared-browser-context'));
  assert.ok(s.args.includes('--isolated'));
});

test('buildSpec : stdio (pas http) + persistant => PAS de --shared-browser-context (client unique)', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x' }, {}, { http: false });
  assert.ok(!s.args.includes('--shared-browser-context'));
});

test('buildSpec : http sans profil courant (opts.http mais isolated) n injecte pas shared-context', () => {
  // garde-fou : --shared-browser-context UNIQUEMENT sur la branche userDataDir, jamais isolated
  const s = buildSpec('anon', { isolated: true, userDataDir: 'C:/ignore' }, {}, { http: true });
  assert.ok(!s.args.includes('--shared-browser-context'), 'isolated l emporte, pas de shared-context');
});

test('buildSpec : args libres du profil ajoutes en fin', () => {
  const s = buildSpec('p', { args: ['--foo', 'bar'] }, {});
  assert.deepEqual(s.args.slice(-2), ['--foo', 'bar']);
});

test('buildSpec : ordre stable base -> caps -> user-data-dir -> args libres', () => {
  const s = buildSpec('p', { caps: ['storage'], userDataDir: 'D', args: ['--z'] }, {});
  assert.deepEqual(s.args, ['-y', '@playwright/mcp@latest', '--caps=storage', '--user-data-dir', 'D', '--z']);
});

test('buildSpec : label du profil sinon nom du profil', () => {
  assert.equal(buildSpec('p', { label: 'Perso' }, {}).label, 'Perso');
  assert.equal(buildSpec('vegeta', {}, {}).label, 'vegeta');
});

// ========================= property-based (fast-check) =========================

test('property : normPath est idempotent et sans backslash', () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const once = normPath(s);
      assert.equal(normPath(once), once);
      assert.ok(!once.includes('\\'));
    })
  );
});

test('property : un proc (non-self) dont la cmd contient un needle est TOUJOURS selectionne', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1e6 }),
      fc.string({ minLength: 1 }).filter((s) => !s.includes('\\')),
      fc.string(),
      fc.string(),
      (pid, needle, pre, post) => {
        const self = pid + 1;
        const cmd = pre + needle + post;
        assert.deepEqual(selectVictims([{ pid, cmd }], [needle], self), [pid]);
      }
    )
  );
});

test('property : buildSpec preserve toujours userDataDir quand fourni', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (dir) => {
      const s = buildSpec('p', { userDataDir: dir }, {});
      const i = s.args.indexOf('--user-data-dir');
      assert.ok(i >= 0 && s.args[i + 1] === dir);
    })
  );
});

test('property : isOurToolCall(proxy_<injecte>) est vrai quelles que soient les collisions', () => {
  fc.assert(
    fc.property(fc.constantFrom(...INJECTED_TOOL_NAMES), fc.subarray(INJECTED_TOOL_NAMES), (name, collisions) => {
      assert.equal(isOurToolCall(FALLBACK_PREFIX + name, collisions), true);
    })
  );
});
