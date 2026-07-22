// Tests UNITE des fonctions pures (decision isolee de l'I/O). Cible de la mutation Stryker.
// Exhaustifs par construction : chaque branche + chaque borne, pour ne laisser survivre aucun mutant.
// + property-based (fast-check) sur les invariants forts.

import { test, expect } from 'vitest';
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
  expect(detectCollisions(['browser_click', 'browser_type'])).toEqual([]);
});

test('detectCollisions : detecte chaque tool maison homonyme', () => {
  expect(detectCollisions(['browser_click', 'switch_profile'])).toEqual(['switch_profile']);
  expect(detectCollisions(['restart_profile', 'current_profile', 'switch_profile']).sort()).toEqual(['current_profile', 'restart_profile', 'switch_profile']);
});

test('detectCollisions : deduplique et preserve l ordre d apparition', () => {
  expect(detectCollisions(['switch_profile', 'x', 'switch_profile'])).toEqual(['switch_profile']);
});

test('detectCollisions : entree vide / nulle => []', () => {
  expect(detectCollisions([])).toEqual([]);
  expect(detectCollisions(null)).toEqual([]);
  expect(detectCollisions(undefined)).toEqual([]);
});

test('canonicalInjectedName : nom nu injecte => lui-meme', () => {
  for (const n of INJECTED_TOOL_NAMES) expect(canonicalInjectedName(n)).toBe(n);
});

test('canonicalInjectedName : prefixe proxy_ => nom canonique', () => {
  expect(canonicalInjectedName('proxy_switch_profile')).toBe('switch_profile');
  expect(canonicalInjectedName('proxy_current_profile')).toBe('current_profile');
  expect(canonicalInjectedName('proxy_restart_profile')).toBe('restart_profile');
});

test('canonicalInjectedName : non injecte / proxy_ inconnu / vide => null', () => {
  expect(canonicalInjectedName('browser_click')).toBe(null);
  expect(canonicalInjectedName('proxy_browser_click')).toBe(null);
  expect(canonicalInjectedName('')).toBe(null);
  expect(canonicalInjectedName(null)).toBe(null);
  expect(canonicalInjectedName(undefined)).toBe(null);
});

test('canonicalInjectedName : SEUL le prefixe exact proxy_ compte (pas un slice(6) hasardeux)', () => {
  // 6 chars quelconques + un nom injecte, MAIS ne commence PAS par "proxy_" => doit rester null.
  // (tue le mutant qui transformerait le `startsWith('proxy_')` en `true`.)
  expect(canonicalInjectedName('ABCDEFswitch_profile')).toBe(null);
  expect(canonicalInjectedName('xproxyswitch_profile')).toBe(null);
});

test('exposedName : sans collision => nom nu ; avec collision => prefixe proxy_', () => {
  expect(exposedName('switch_profile', [])).toBe('switch_profile');
  expect(exposedName('switch_profile', ['current_profile'])).toBe('switch_profile'); // collision sur un AUTRE
  expect(exposedName('switch_profile', ['switch_profile'])).toBe(FALLBACK_PREFIX + 'switch_profile');
  expect(exposedName('switch_profile', null)).toBe('switch_profile');
});

test('isOurToolCall : nom nu sans collision => a nous (true)', () => {
  expect(isOurToolCall('switch_profile', [])).toBe(true);
});

test('isOurToolCall : nom nu EN collision => tool backend (false)', () => {
  expect(isOurToolCall('switch_profile', ['switch_profile'])).toBe(false);
});

test('isOurToolCall : appel via proxy_ => TOUJOURS a nous, meme en collision', () => {
  expect(isOurToolCall('proxy_switch_profile', ['switch_profile'])).toBe(true);
  expect(isOurToolCall('proxy_switch_profile', [])).toBe(true);
});

test('isOurToolCall : nom non injecte => false', () => {
  expect(isOurToolCall('browser_click', [])).toBe(false);
  expect(isOurToolCall('browser_click', ['switch_profile'])).toBe(false);
});

// ========================= prockill-pure.js =========================

test('normPath : backslash -> slash, null -> chaine vide', () => {
  expect(normPath('C:\\Users\\alice\\.pw-profiles\\perso')).toBe('C:/Users/alice/.pw-profiles/perso');
  expect(normPath('deja/en/slash')).toBe('deja/en/slash');
  expect(normPath(null)).toBe('');
  expect(normPath(undefined)).toBe('');
});

const P = (pid, cmd) => ({ pid, cmd });

test('selectVictims : matche le needle, retourne les PID', () => {
  const procs = [P(10, 'chrome --user-data-dir=C:/x/.pw-profiles/vegeta'), P(11, 'autre chose')];
  expect(selectVictims(procs, ['.pw-profiles/vegeta'], 999)).toEqual([10]);
});

test('selectVictims : exclut TOUJOURS self', () => {
  const procs = [P(42, 'node .pw-profiles/vegeta')];
  expect(selectVictims(procs, ['.pw-profiles/vegeta'], 42)).toEqual([]);
});

test('selectVictims : cross-OS, needle en / matche une cmdline en backslash', () => {
  // crashpad-handler enfant ecrit le chemin en backslash ; le needle est en slash.
  const procs = [P(7, 'crashpad --user-data-dir=C:\\Users\\alice\\.pw-profiles\\perso')];
  expect(selectVictims(procs, ['.pw-profiles/perso'], 999)).toEqual([7]);
});

test('selectVictims : needles vide => [] (jamais de sweep large)', () => {
  const procs = [P(1, 'nimporte quoi')];
  expect(selectVictims(procs, [], 999)).toEqual([]);
  expect(selectVictims(procs, [null, '', undefined], 999)).toEqual([]);
});

test('selectVictims : aucun match => []', () => {
  expect(selectVictims([P(1, 'aaa'), P(2, 'bbb')], ['zzz'], 999)).toEqual([]);
});

test('selectVictims : plusieurs needles, plusieurs victimes', () => {
  const procs = [P(1, 'x/vegeta'), P(2, 'x/perso'), P(3, 'rien')];
  expect(selectVictims(procs, ['vegeta', 'perso'], 999).sort((a, b) => a - b)).toEqual([1, 2]);
});

test('selectVictims : procs nul / entrees nulles => robuste', () => {
  expect(selectVictims(null, ['x'], 1)).toEqual([]);
  expect(selectVictims([null, P(5, 'x')], ['x'], 1)).toEqual([5]);
});

// ========================= spec.js =========================

test('buildSpec : backend par defaut si rien de defini', () => {
  const s = buildSpec('vegeta', {}, {});
  expect(s.command).toBe('npx'); // litteral (PAS DEFAULT_BACKEND.command : muterait avec le code)
  expect(DEFAULT_BACKEND.command).toBe('npx');
  expect(s.args).toEqual(['-y', '@playwright/mcp@latest']);
  expect(s.label).toBe('vegeta');
});

test('buildSpec : backend override SANS args => args de base vides', () => {
  const s = buildSpec('p', { backend: { command: 'solo' } }, {}); // pas de backend.args
  expect(s.command).toBe('solo');
  expect(s.args).toEqual([]); // tue le mutant `backend.args || ["..."]`
});

test('buildSpec : backend global utilise si pas d override profil', () => {
  const s = buildSpec('p', {}, { backend: { command: 'node', args: ['x.js'] } });
  expect(s.command).toBe('node');
  expect(s.args).toEqual(['x.js']);
});

test('buildSpec : backend du profil prime sur le global', () => {
  const s = buildSpec('p', { backend: { command: 'a', args: ['1'] } }, { backend: { command: 'b', args: ['2'] } });
  expect(s.command).toBe('a');
  expect(s.args).toEqual(['1']);
});

test('buildSpec : caps profil > caps global ; [] => pas de --caps', () => {
  expect(buildSpec('p', { caps: ['storage'] }, { caps: ['pdf'] }).args.includes('--caps=storage')).toBeTruthy();
  expect(buildSpec('p', {}, { caps: ['pdf', 'vision'] }).args.includes('--caps=pdf,vision')).toBeTruthy();
  expect(!buildSpec('p', { caps: [] }, { caps: ['pdf'] }).args.some((a) => a.startsWith('--caps='))).toBeTruthy();
  expect(!buildSpec('p', {}, {}).args.some((a) => a.startsWith('--caps='))).toBeTruthy();
});

test('buildSpec : userDataDir ajoute --user-data-dir <path>', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x/perso' }, {});
  const i = s.args.indexOf('--user-data-dir');
  expect(i >= 0).toBeTruthy();
  expect(s.args[i + 1]).toBe('C:/x/perso');
});

// resolveShellSpawn : decision de spawn cross-OS (source unique stdio-transport + supervisor).
test('resolveShellSpawn : Windows + commande bare (npx) => shell:true (sinon le serveur ne demarre pas)', () => {
  const r = resolveShellSpawn('npx', ['-y', '@playwright/mcp@0.0.78'], 'win32');
  expect(r.shell, 'bare command sur win => shell requis').toBe(true);
  expect(r.command).toBe('npx');
});

test('resolveShellSpawn : Windows + binaire absolu .exe => shell:false', () => {
  const r = resolveShellSpawn('C:/Program Files/node/node.exe', ['x.js'], 'win32');
  expect(r.shell, '.exe absolu => pas de shell (espace dans le chemin casserait)').toBe(false);
});

test('resolveShellSpawn : Windows + shell => quote les args a espaces', () => {
  const r = resolveShellSpawn('npx', ['--user-data-dir', 'C:/mes profils/x'], 'win32');
  expect(r.args.includes('"C:/mes profils/x"'), 'arg a espace quote pour le shell').toBeTruthy();
  expect(r.args.includes('--user-data-dir'), 'arg sans espace non quote').toBeTruthy();
});

test('resolveShellSpawn : POSIX => jamais de shell (detached/kill de groupe gere ailleurs)', () => {
  const r = resolveShellSpawn('npx', ['-y', 'pkg'], 'linux');
  expect(r.shell).toBe(false);
  expect(r.args, 'args intacts (pas de quoting hors shell)').toEqual(['-y', 'pkg']);
});

test('resolveShellSpawn : Windows + chemin ABSOLU sans extension => shell:false (isAbsolute suffit)', () => {
  expect(resolveShellSpawn('C:/tools/runner', [], 'win32').shell).toBe(false);
  expect(resolveShellSpawn('C:\\tools\\runner', [], 'win32').shell, 'backslash aussi absolu').toBe(false);
});

test('resolveShellSpawn : Windows + RELATIF mais .exe/.com => shell:false (isBinary suffit)', () => {
  expect(resolveShellSpawn('runner.exe', [], 'win32').shell, '.exe relatif = binaire').toBe(false);
  expect(resolveShellSpawn('runner.COM', [], 'win32').shell, '.com insensible a la casse').toBe(false);
});

test('resolveShellSpawn : Windows + chemin POSIX-absolu (/usr/bin) => shell:false', () => {
  expect(resolveShellSpawn('/usr/bin/node', [], 'win32').shell, 'slash de tete = absolu').toBe(false);
});

test('buildSpec : isolated ajoute --isolated (et EXCLUT --user-data-dir)', () => {
  const s = buildSpec('anon', { isolated: true, userDataDir: 'C:/ignore' }, {});
  expect(s.args.includes('--isolated'), 'flag --isolated present').toBeTruthy();
  expect(!s.args.includes('--user-data-dir'), 'isolated l emporte : pas de --user-data-dir').toBeTruthy();
});

test('buildSpec : sans isolated, userDataDir seul => --user-data-dir (pas --isolated)', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x' }, {});
  expect(!s.args.includes('--isolated')).toBeTruthy();
  expect(s.args.includes('--user-data-dir')).toBeTruthy();
});

test('buildSpec : HTTP + persistant => --shared-browser-context (multi-agent, contrat documente)', () => {
  const s = buildSpec('vegeta', { userDataDir: 'C:/x' }, {}, { http: true });
  expect(s.args.includes('--shared-browser-context'), 'persistant multi-client partage le contexte').toBeTruthy();
  expect(s.args.includes('--user-data-dir')).toBeTruthy();
});

test('buildSpec : HTTP + isolated => PAS de --shared-browser-context (deja parallele)', () => {
  const s = buildSpec('anon', { isolated: true }, {}, { http: true });
  expect(!s.args.includes('--shared-browser-context')).toBeTruthy();
  expect(s.args.includes('--isolated')).toBeTruthy();
});

test('buildSpec : stdio (pas http) + persistant => PAS de --shared-browser-context (client unique)', () => {
  const s = buildSpec('p', { userDataDir: 'C:/x' }, {}, { http: false });
  expect(!s.args.includes('--shared-browser-context')).toBeTruthy();
});

test('buildSpec : http sans profil courant (opts.http mais isolated) n injecte pas shared-context', () => {
  // garde-fou : --shared-browser-context UNIQUEMENT sur la branche userDataDir, jamais isolated
  const s = buildSpec('anon', { isolated: true, userDataDir: 'C:/ignore' }, {}, { http: true });
  expect(!s.args.includes('--shared-browser-context'), 'isolated l emporte, pas de shared-context').toBeTruthy();
});

test('buildSpec : args libres du profil ajoutes en fin', () => {
  const s = buildSpec('p', { args: ['--foo', 'bar'] }, {});
  expect(s.args.slice(-2)).toEqual(['--foo', 'bar']);
});

test('buildSpec : ordre stable base -> caps -> user-data-dir -> args libres', () => {
  const s = buildSpec('p', { caps: ['storage'], userDataDir: 'D', args: ['--z'] }, {});
  expect(s.args).toEqual(['-y', '@playwright/mcp@latest', '--caps=storage', '--user-data-dir', 'D', '--z']);
});

test('buildSpec : label du profil sinon nom du profil', () => {
  expect(buildSpec('p', { label: 'Perso' }, {}).label).toBe('Perso');
  expect(buildSpec('vegeta', {}, {}).label).toBe('vegeta');
});

// ========================= property-based (fast-check) =========================

test('property : normPath est idempotent et sans backslash', () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      const once = normPath(s);
      expect(normPath(once)).toBe(once);
      expect(!once.includes('\\')).toBeTruthy();
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
        expect(selectVictims([{ pid, cmd }], [needle], self)).toEqual([pid]);
      }
    )
  );
});

test('property : buildSpec preserve toujours userDataDir quand fourni', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (dir) => {
      const s = buildSpec('p', { userDataDir: dir }, {});
      const i = s.args.indexOf('--user-data-dir');
      expect(i >= 0 && s.args[i + 1] === dir).toBeTruthy();
    })
  );
});

test('property : isOurToolCall(proxy_<injecte>) est vrai quelles que soient les collisions', () => {
  fc.assert(
    fc.property(fc.constantFrom(...INJECTED_TOOL_NAMES), fc.subarray(INJECTED_TOOL_NAMES), (name, collisions) => {
      expect(isOurToolCall(FALLBACK_PREFIX + name, collisions)).toBe(true);
    })
  );
});
