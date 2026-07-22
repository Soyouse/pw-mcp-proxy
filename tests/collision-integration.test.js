// Integration REELLE de la garde anti-collision : un backend qui expose un tool 'switch_profile'
// homonyme (--collide) doit :
//   - garder son 'switch_profile' NU dans tools/list (passthrough integre, on ne casse rien) ;
//   - forcer NOTRE tool sous 'proxy_switch_profile' ;
//   - router l'appel NU vers le backend, et l'appel proxy_ vers nous.

import { test, beforeAll, afterAll, expect } from 'vitest';
import { spawnTracked } from './harness.js'; // ⚠️ spawn tracké + ratchet anti-fuite (JAMAIS child_process.spawn nu)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-backend.js');

let proc;
let cfgPath;
let buf = '';
const pending = new Map();
let idc = 0;

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}
function request(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function onMessage(m) {
  if (m.id !== undefined && m.method === undefined) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message), { rpc: m.error })) : p.resolve(m.result);
    }
    return;
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, result: { roots: [] } });
}

beforeAll(async () => {
  cfgPath = path.join(os.tmpdir(), `pw-mcp-collide-${process.pid}.json`);
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      defaultProfile: 'vegeta',
      backend: { command: process.execPath, args: [FAKE] },
      // --collide : le backend annonce un tool 'switch_profile' homonyme du notre.
      profiles: { vegeta: { args: ['--tag', 'A', '--collide'], label: 'Agence' } },
    })
  );
  proc = spawnTracked([INDEX], {
    env: { ...process.env, PW_MCP_PROFILES: cfgPath, PW_MCP_LOG: path.join(os.tmpdir(), `pw-mcp-collide-${process.pid}.log`) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
});

afterAll(() => {
  // Process tué + vérifié par le harnais (spawnTracked -> ratchet). Ici : seulement le fichier temp.
  try { fs.unlinkSync(cfgPath); } catch {}
});

test('collision : le tool backend garde son nom NU + notre tool passe sous proxy_', async () => {
  const res = await request('tools/list', {});
  const names = res.tools.map((t) => t.name);
  // deux entrees 'switch_profile' : celle du backend (nue) + la notre renommee proxy_
  expect(names.includes('switch_profile'), 'le switch_profile du BACKEND reste expose (passthrough intact)').toBeTruthy();
  expect(names.includes('proxy_switch_profile'), 'NOTRE switch_profile cede la place sous proxy_').toBeTruthy();
  // current/restart, pas en collision, gardent leur nom nu
  expect(names.includes('current_profile'), 'current_profile pas en collision => nom nu').toBeTruthy();
  expect(names.includes('restart_profile'), 'restart_profile pas en collision => nom nu').toBeTruthy();
  // le backend qui porte le nom nu switch_profile n'est PAS le notre : sa description vient du fake
  const bareSwitch = res.tools.find((t) => t.name === 'switch_profile');
  expect(bareSwitch.description, 'le switch_profile nu est bien celui du backend').toMatch(/homonyme/);
});

test('collision : appel NU switch_profile => passthrough BACKEND (pas notre handler)', async () => {
  // le fake renvoie une erreur "unknown tool" sur switch_profile (il l'annonce mais ne l'implemente pas) :
  // preuve que l'appel est parti au BACKEND et non intercepte par nous (nous aurions renvoye un succes).
  await expect(
    request('tools/call', { name: 'switch_profile', arguments: { profile: 'vegeta' } }),
    'l appel nu est bien route vers le backend'
  ).rejects.toThrow(/unknown tool switch_profile/);
});

test('collision : appel proxy_switch_profile => NOTRE handler (succes)', async () => {
  const res = await request('tools/call', { name: 'proxy_switch_profile', arguments: { profile: 'vegeta' } });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toMatch(/Profil actif/);
});
