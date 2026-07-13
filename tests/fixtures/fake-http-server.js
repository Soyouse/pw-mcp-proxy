// Faux serveur "@playwright/mcp --port" SPAWNABLE (autonome) pour tester supervisor.js.
// Parse --host/--port comme le vrai binaire, bind, et repond a toute requete /mcp (readiness OK).
// Optionnel : --fail-bind => tente d'ecouter un port deja pris (simule EADDRINUSE) sans jamais etre pret.
// Volontairement minimal : le superviseur ne teste QUE le cycle de vie (spawn/ready/reap), pas le MCP.

import http from 'node:http';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const host = opt('--host', '127.0.0.1');
const port = Number(opt('--port', '0'));

const server = http.createServer((req, res) => {
  // Toute reponse HTTP prouve la readiness cote superviseur.
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ok\n\n'); // priming SSE, garde le flux ouvert un instant
    setTimeout(() => { try { res.end(); } catch {} }, 50);
    return;
  }
  res.writeHead(202); // POST notif/response : accepte sans corps
  res.end();
});

server.on('error', (e) => {
  // EADDRINUSE (--fail-bind ou course) : on NE devient jamais pret => le superviseur timeout et nous tue.
  process.stderr.write(`fake-http-server bind error: ${e.code}\n`);
  process.exit(1);
});

server.listen(port, host, () => {
  process.stderr.write(`fake-http-server up ${host}:${port}\n`);
});

// Reste vivant tant qu'on ne le tue pas (le superviseur le tree-kill au reap).
process.on('SIGTERM', () => { try { server.close(); } catch {} process.exit(0); });
