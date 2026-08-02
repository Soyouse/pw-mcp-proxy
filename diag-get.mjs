import http from 'node:http';
import { Supervisor } from './src/supervisor.js';
import { buildSpec } from './src/spec.js';
import os from 'node:os'; import path from 'node:path';

const cfg = path.join(os.tmpdir(), `diag-${process.pid}.json`);
const sup = new Supervisor(cfg, { ttl: 60000 });
const spec = buildSpec('anon', { isolated: true, args: ['--headless'], backend: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.78'] } }, {});
const url = await sup.ensureServer('anon', spec);
const u = new URL(url);
const req = (method, headers, body) => new Promise((res, rej) => {
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (x) => {
    let b=''; x.on('data',c=>b+=c); x.on('end',()=>res({status:x.statusCode, headers:x.headers, body:b.slice(0,200)}));
  });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const init = await req('POST', {'content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},
  JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'d',version:'1'}}}));
const sid = init.headers['mcp-session-id'];
console.log('initialize ->', init.status, '| session-id:', sid);
const get = await req('GET', {'accept':'text/event-stream','mcp-protocol-version':'2025-06-18','mcp-session-id':sid});
console.log('GET /mcp   ->', get.status, '| content-type:', get.headers['content-type'], '| body:', JSON.stringify(get.body));
const get2 = await req('GET', {'accept':'text/event-stream','mcp-protocol-version':'2025-06-18'});
console.log('GET sans session ->', get2.status);
await sup.shutdown();
process.exit(0);
