// Faux serveur MCP « Streamable HTTP » (zero dep) pour tester http-transport.js en isolation.
// Couvre les 3 formes de reponse : JSON direct, flux SSE (notif liee + response), 202 (notif/response),
// + un flux GET serveur->client + DELETE. In-process (pas de spawn) : startFakeHttpBackend() -> {url, close}.

import http from 'node:http';

export function startFakeHttpBackend() {
  let sessionCounter = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }

    if (req.method === 'GET') {
      // Flux serveur->client persistant : pousse une notif non sollicitee de facon repetee
      // (heartbeat SSE realiste) => robuste a un reset de buffer cote test, teste la persistance.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const iv = setInterval(() => {
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/server_hello', params: { hi: true } })}\n\n`);
      }, 100);
      req.on('close', () => clearInterval(iv));
      return;
    }

    // POST
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }

      const isRequest = msg.id !== undefined && msg.method !== undefined;
      if (!isRequest) { res.writeHead(202); res.end(); return; } // notification/response client

      if (msg.method === 'initialize') {
        const sid = 'sess-' + ++sessionCounter;
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-http', version: '0' } },
        }));
        return;
      }

      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_http', description: 'e', inputSchema: { type: 'object' } }] } }));
        return;
      }

      if (msg.method === 'tools/call' && msg.params?.name === 'notify_http') {
        // Reponse via SSE : une notif LIEE puis la response JSON-RPC, puis cloture du flux (spec).
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'via-sse' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'notified-http' }], isError: false } })}\n\n`);
        res.end();
        return;
      }

      if (msg.method === 'tools/call' && msg.params?.name === 'echo_http') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + (msg.params.arguments?.v ?? '') }], isError: false } }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true, method: msg.method } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
