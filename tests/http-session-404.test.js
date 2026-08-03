// CONFORMITÉ DU 404 — « fin de session » est un ÉVÉNEMENT NORMAL, pas une panne (posé le 03/08/2026).
//
// 🛑 CE QUE CE FICHIER SCELLE, ET POURQUOI ÇA COMPTE. Spec Streamable HTTP (vérifiée 03/08) :
// « The server MAY terminate the session at any time, after which it MUST respond […] 404 », et le
// client « MUST start a new session by sending a new InitializeRequest without a session ID ».
// Jusqu'ici le transport faisait l'inverse : il remontait une `transport error`, le Backend se
// croyait mort, le Manager détruisait tout et respawnait un serveur. Ça FONCTIONNAIT — c'est
// précisément ce qui rendait le défaut invisible — mais ça écrivait un événement NORMAL comme une
// PANNE. Ce mensonge de log a fait chercher un bug pendant 2 jours.
// ⚠️ L'enjeu n'est donc pas « ça marche ou pas » : c'est qu'un journal dise la VÉRITÉ. Un journal
// qui crie au loup sur un événement de routine est pire qu'un journal vide, parce qu'on le croit.
//
// ⚠️ Serveur de test EN PROCESS, jamais spawné : aucun harnais requis, aucun orphelin possible.

import { test, expect } from 'vitest';
import http from 'node:http';
import { HttpTransport } from '../src/http-transport.js';

/**
 * Faux serveur MCP qui TERMINE sa session quand on le lui demande — le comportement exact que la
 * spec autorise et que notre client doit encaisser.
 * ⚠️ Handlers d'erreur sur les 3 niveaux (req/res, clientError, socket) : un RST arrivant APRÈS une
 * réponse complète remonte sur la SOCKET, pas sur req/res — angle mort qui a déjà fait rougir la CI
 * macOS en laissant mourir un fixture, donc conclure à un faux diagnostic.
 */
async function serveur({ toujours404 = false } = {}) {
  const journal = { initialises: 0, notifsInit: 0, sessions: [] };
  let session = null;
  let valide = false;

  const srv = http.createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405).end(); return; }

    let brut = '';
    req.on('data', (c) => { brut += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(brut); } catch { /* corps illisible : traité comme un message vide */ }

      if (msg.method === 'initialize') {
        journal.initialises++;
        session = `sess-${journal.initialises}`;
        journal.sessions.push(session);
        valide = !toujours404; // `toujours404` : le serveur refuse même une session toute neuve
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-404', version: '1' } } }));
        return;
      }
      // 🛑 LE MUST DE LA SPEC : la ré-initialisation se fait SANS session-id. Un client qui garderait
      // l'ancien se ferait re-refuser en boucle — c'est ce que ce serveur vérifie en dur.
      if (msg.method === 'notifications/initialized') {
        journal.notifsInit++;
        res.writeHead(202).end();
        return;
      }
      if (!valide || req.headers['mcp-session-id'] !== session) { res.writeHead(404).end(); return; }
      if (msg.method === 'terminer') { valide = false; res.writeHead(202).end(); return; } // le serveur clôt sa session
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: msg.method } }));
    });
  });
  srv.on('clientError', (_e, s) => s.destroy());
  srv.on('connection', (s) => s.on('error', () => {}));
  // 🛑 ÉCOUTER SUR `localhost`, PAS SUR `127.0.0.1` — et ce n'est PAS cosmétique.
  // Le client se connecte à `localhost` (obligatoire en production : le vrai backend valide
  // l'en-tête Host et renvoie 403 sinon). Or `localhost` résout vers `::1` **ou** `127.0.0.1` selon
  // la machine et l'ordre rendu par le résolveur. Un serveur lié au SEUL `127.0.0.1` est donc
  // joignable… par intermittence — VERT en isolation, ROUGE dans la suite complète (mesuré 03/08).
  // ⚠️ Lier au MÊME nom que celui qu'on appelle supprime la course : les deux côtés parlent de la
  // même chose. NE JAMAIS « réparer » ça en changeant l'URL du client pour `127.0.0.1` : on
  // testerait alors un chemin qui n'existe pas en production.
  await new Promise((r) => srv.listen(0, 'localhost', r));
  return { journal, url: `http://localhost:${srv.address().port}/mcp`, close: () => new Promise((r) => srv.close(r)) };
}

/** Envoie une requête et attend SA réponse (matchée par id). */
function echange(transport, messages, id, method) {
  transport.send({ jsonrpc: '2.0', id, method, params: {} });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const m = messages.find((x) => x.id === id);
      if (m) return resolve(m);
      if (Date.now() - t0 > 5000) return resolve(null);
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('404 = session terminée ⇒ le transport SE RÉINITIALISE SEUL et la requête aboutit', async () => {
  const s = await serveur();
  const messages = [];
  const erreurs = [];
  const t = new HttpTransport(s.url, { protocolVersion: '2025-06-18' });
  t.on('message', (m) => messages.push(m));
  t.on('error', (e) => erreurs.push(e));

  await echange(t, messages, 1, 'initialize');
  expect(t.sessionId, 'session initiale capturée').toBe('sess-1');

  // Le serveur TERMINE sa session, comme la spec l'y autorise à tout instant.
  t.send({ jsonrpc: '2.0', method: 'terminer' });
  await new Promise((r) => setTimeout(r, 100));

  const rep = await echange(t, messages, 2, 'tools/list');

  expect(rep, "LA REQUÊTE DOIT ABOUTIR : un 404 de session ne doit RIEN coûter à l'appelant").not.toBe(null);
  expect(rep?.result?.ok, 'et rendre le VRAI résultat, pas une erreur maquillée').toBe('tools/list');
  expect(s.journal.initialises, 'le handshake a été rejoué EXACTEMENT une fois').toBe(2);
  expect(t.sessionId, 'la nouvelle session est adoptée').toBe('sess-2');
  expect(s.journal.notifsInit, "`notifications/initialized` est OBLIGATOIRE après tout initialize — sans elle la session neuve peut être refusée").toBeGreaterThanOrEqual(1);

  // 🛑 LES DEUX INVARIANTS QUI PROTÈGENT LE BACKEND, et qui sont le cœur du correctif :
  expect(erreurs, "AUCUNE erreur remontée : c'est tout le sujet — un événement NORMAL ne doit pas être journalisé comme une panne").toEqual([]);
  expect(messages.filter((m) => String(m.id ?? '').startsWith('pw-mcp-reinit')),
    "la réponse du handshake interne ne doit JAMAIS atteindre le Backend : il a déjà résolu son initialize, une 2e réponse corromprait sa table d ids").toEqual([]);

  await t.close();
  await s.close();
});

// NEGATIVE-CHECK — un mécanisme de reprise qui ne peut pas ABANDONNER est une boucle infinie.
test('NEGATIVE-CHECK : un 404 qui PERSISTE après un handshake neuf est une VRAIE panne, et remonte', async () => {
  const s = await serveur({ toujours404: true });
  const messages = [];
  const erreurs = [];
  const t = new HttpTransport(s.url, { protocolVersion: '2025-06-18' });
  t.on('message', (m) => messages.push(m));
  t.on('error', (e) => erreurs.push(e));

  await echange(t, messages, 1, 'initialize');
  await echange(t, messages, 2, 'tools/list'); // 404, ré-init, 404 de nouveau ⇒ abandon

  expect(erreurs.length, "un 404 APRÈS une session toute neuve n'est plus une session périmée : ça DOIT remonter").toBe(1);
  expect(erreurs[0]?.message, 'et le message doit dire que la réouverture a été tentée').toMatch(/reouverture impossible/);
  expect(s.journal.initialises, 'UN SEUL essai de reprise — jamais de boucle de handshakes').toBe(2);

  await t.close();
  await s.close();
});
