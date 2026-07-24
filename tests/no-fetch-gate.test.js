// GATE STATIQUE fails-closed : fetch est BANNI dans http-transport.js.
// Pourquoi (mesure prod 22-23/07/2026 + doc officielle undici Client.md, verifiee 2026-07-24) :
// fetch (undici) applique un bodyTimeout PAR DEFAUT de 300 s entre deux chunks, non desactivable
// sans dispatcher undici custom (= dependance runtime, interdite par l'invariant zero-dep).
// Consequences : flux GET SSE idle coupe toutes les ~5 min (« SSE read err: terminated » en boucle)
// + la reponse SSE d'un POST d'action LONGUE (upload 12 min, flux muet = contrat Streamable HTTP)
// serait TUEE a 300 s = reponse perdue. Le transport DOIT rester sur node:http (aucun timeout de
// body par defaut) ; la liveness est garantie par le watchdog ping (backend.js), JAMAIS par un
// timeout d'inactivite. Reintroduire fetch ici = reintroduire la classe de bug entiere => ROUGE.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('http-transport.js ne contient AUCUN appel fetch (bodyTimeout undici 300 s = flux SSE tues)', () => {
  const code = fs.readFileSync(path.join(SRC, 'http-transport.js'), 'utf8');
  // On cherche un APPEL (`fetch(`), pas le mot dans un commentaire : strip des commentaires d'abord.
  const sansCommentaires = code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(/\bfetch\s*\(/.test(sansCommentaires), 'fetch() detecte dans http-transport.js — INTERDIT (cf entete de ce test)').toBe(false);
  expect(sansCommentaires.includes("from 'node:http'"), 'le transport doit rester sur node:http').toBe(true);
});
