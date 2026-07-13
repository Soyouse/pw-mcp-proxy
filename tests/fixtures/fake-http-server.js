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
  // ⚠️ ROBUSTESSE CROSS-OS : le probe readiness du superviseur annule la reponse (res.body.cancel())
  //   => RST de connexion. Sans handler, l'event 'error' de la socket = uncaughtException => le fixture
  //   MEURT (reproduit sur macOS 2026-07-13 : timing RST plus agressif que Linux/Windows). On IGNORE
  //   ces erreurs socket ET on repond IMMEDIATEMENT (pas de flux SSE qui traine = pas de course reset/write).
  req.on('error', () => {});
  res.on('error', () => {});
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(': ok\n\n'); // toute reponse prouve la readiness ; on ferme tout de suite (zero flux persistant)
    return;
  }
  res.writeHead(202); // POST notif/response : accepte sans corps
  res.end();
});

// Erreur de handshake TCP (client qui coupe tot) : detruire la socket sans crasher le process.
server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });

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
