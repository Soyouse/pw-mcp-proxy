// Tests PURS du decodeur SSE (sse-parse.js). Unite + property-based (fast-check).
// L'invariant central (property) : le decoupage en chunks n'affecte JAMAIS les events extraits.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { sseFeed, parseSseBlock } from '../src/sse-parse.js';

// Rejoue un flux complet en le decoupant aux offsets donnes, retourne {events, pending} cumules.
function drain(stream, cuts = []) {
  const points = [...new Set(cuts.map((c) => c % (stream.length + 1)))].sort((a, b) => a - b);
  const chunks = [];
  let prev = 0;
  for (const p of points) { chunks.push(stream.slice(prev, p)); prev = p; }
  chunks.push(stream.slice(prev));
  let pending = '';
  const events = [];
  for (const ch of chunks) {
    const r = sseFeed(pending, ch);
    pending = r.pending;
    events.push(...r.events);
  }
  return { events, pending };
}

test('parseSseBlock : data simple => event message', () => {
  expect(parseSseBlock('data: hello')).toEqual({ event: 'message', data: 'hello', id: null, retry: null });
});

test('parseSseBlock : data multi-lignes concatene par \\n', () => {
  expect(parseSseBlock('data: a\ndata: b').data).toBe('a\nb');
});

test('parseSseBlock : event/id/retry captures', () => {
  const ev = parseSseBlock('event: msg\nid: 42\nretry: 3000\ndata: x');
  expect(ev).toEqual({ event: 'msg', data: 'x', id: '42', retry: '3000' });
});

test('parseSseBlock : commentaire (: ...) ignore', () => {
  expect(parseSseBlock(': keep-alive\ndata: y').data).toBe('y');
});

test('parseSseBlock : un seul espace de tete retire apres :', () => {
  // "data:  x" (deux espaces) => un seul retire => " x"
  expect(parseSseBlock('data:  x').data).toBe(' x');
});

test('parseSseBlock : bloc vide => null', () => {
  expect(parseSseBlock('')).toBe(null);
  expect(parseSseBlock(': just a comment')).toBe(null);
});

test('sseFeed : un event complet extrait, rien en attente', () => {
  const r = sseFeed('', 'data: 1\n\n');
  expect(r.events.length).toBe(1);
  expect(r.events[0].data).toBe('1');
  expect(r.pending).toBe('');
});

test('sseFeed : event incomplet reste en pending', () => {
  const r = sseFeed('', 'data: partiel\n');
  expect(r.events.length).toBe(0);
  expect(r.pending).toBe('data: partiel\n');
});

test('sseFeed : deux events dans un chunk', () => {
  const r = sseFeed('', 'data: a\n\ndata: b\n\n');
  expect(r.events.map((e) => e.data)).toEqual(['a', 'b']);
});

test('sseFeed : CRLF normalise (data: a\\r\\n\\r\\n)', () => {
  const r = sseFeed('', 'data: a\r\n\r\n');
  expect(r.events.length).toBe(1);
  expect(r.events[0].data).toBe('a');
});

test('sseFeed : CRLF coupe entre deux chunks est recolle', () => {
  const a = sseFeed('', 'data: a\r');
  const b = sseFeed(a.pending, '\n\r\n');
  expect(b.events.length, 'l event est extrait malgre le CRLF a cheval').toBe(1);
  expect(b.events[0].data).toBe('a');
});

test('sseFeed : JSON-RPC MCP typique (une reponse)', () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  const r = sseFeed('', `event: message\nid: s1\ndata: ${payload}\n\n`);
  expect(JSON.parse(r.events[0].data).result.ok).toBe(true);
});

// ---- tueurs de mutants (Stryker) : fallbacks, champs, bornes ----
test('parseSseBlock : champ nu sans deux-points (c === -1) => valeur vide', () => {
  // "data" sans ":" => field="data", value="" => data=[""] (sawData vrai) => data ""
  expect(parseSseBlock('data').data).toBe('');
});

test('parseSseBlock : espace de tete unique retire (data: x => "x", pas " x")', () => {
  expect(parseSseBlock('data: x').data).toBe('x');
  expect(parseSseBlock('data:x').data).toBe('x'); // sans espace : identique
});

test('parseSseBlock : id SEUL => non-null (clause id===null)', () => {
  expect(parseSseBlock('id: 5')).toEqual({ event: 'message', data: '', id: '5', retry: null });
});
test('parseSseBlock : retry SEUL => non-null (clause retry===null)', () => {
  expect(parseSseBlock('retry: 900')).toEqual({ event: 'message', data: '', id: null, retry: '900' });
});
test('parseSseBlock : event SEUL => non-null (clause event===null) + valeur portee', () => {
  expect(parseSseBlock('event: ping')).toEqual({ event: 'ping', data: '', id: null, retry: null });
});
test('parseSseBlock : data vide explicite (data:) => non-null, event defaut "message"', () => {
  expect(parseSseBlock('data:')).toEqual({ event: 'message', data: '', id: null, retry: null });
});

test('sseFeed : pending undefined traite comme "" (fallback ?? gauche)', () => {
  const r = sseFeed(undefined, 'data: x\n\n');
  expect(r.events.length).toBe(1);
  expect(r.events[0].data).toBe('x');
  expect(r.pending).toBe('');
});
test('sseFeed : chunk undefined traite comme "" (fallback ?? droite) => pending inchange', () => {
  const r = sseFeed('data: x\n\n', undefined);
  expect(r.events[0].data).toBe('x');
  expect(r.pending, 'aucun residu injecte').toBe('');
});

test('sseFeed : bloc null (commentaire seul) N EST PAS pousse (if(ev))', () => {
  // ":c" => parseSseBlock null ; "data: x" => event. Total = 1 (le null ne doit pas etre pousse).
  const r = sseFeed('', ':c\n\ndata: x\n\n');
  expect(r.events.length).toBe(1);
  expect(r.events[0].data).toBe('x');
});

// ---- PROPERTY : invariant de chunking (le coeur de la robustesse) ----

test('property : le decoupage en chunks ne change pas les events ni le pending', () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.nat({ max: 500 }), { maxLength: 12 }), (stream, cuts) => {
      const whole = drain(stream, []); // feed en une fois
      const chunked = drain(stream, cuts); // feed decoupe arbitrairement
      expect(chunked.events).toEqual(whole.events);
      expect(chunked.pending).toBe(whole.pending);
    }),
    { numRuns: 500 }
  );
});

test('property : sseFeed ne throw jamais (total) sur entree arbitraire', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (pending, chunk) => {
      sseFeed(pending, chunk); // ne doit pas lever
    })
  );
});

test('property : round-trip — N events data serialises puis parses redonnent les data', () => {
  fc.assert(
    fc.property(fc.array(fc.string().filter((s) => !s.includes('\n') && !s.includes('\r')), { maxLength: 8 }), (datas) => {
      const stream = datas.map((d) => `data: ${d}\n\n`).join('');
      const { events } = drain(stream, []);
      // "data: " retire un espace de tete : on compare a la valeur telle qu'encodee
      expect(events.map((e) => e.data)).toEqual(datas);
    })
  );
});
