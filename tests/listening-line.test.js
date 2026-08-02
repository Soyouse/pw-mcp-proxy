// PUR + property — lecture de l'annonce de disponibilite du serveur @playwright/mcp.
// Cible Stryker : src/listening-line.js
//
// ENJEU : cette ligne REMPLACE le poll de readiness (une inference + un delai) par un FAIT emis
// par l'autorite concernee. Si le parseur rate l'annonce, le daemon n'annonce jamais et le profil
// est mort — d'ou property-test (parseur = signal obligatoire de la doctrine) + sorties EXACTES.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { findListeningUrl, feedListening, MAX_PENDING } from '../src/listening-line.js';

test('lit l annonce reelle de @playwright/mcp', () => {
  expect(findListeningUrl('Listening on http://localhost:14013', 14013)).toBe('http://localhost:14013');
});

test('accepte un wording DIFFERENT (le libelle appartient a Microsoft, pas a nous)', () => {
  expect(findListeningUrl('MCP server ready at http://127.0.0.1:9222/mcp now', 9222)).toBe('http://127.0.0.1:9222/mcp');
  expect(findListeningUrl('=> https://localhost:8080/x', 8080)).toBe('https://localhost:8080/x');
});

test('ignore une annonce portant un AUTRE port (jamais le serveur d un autre profil)', () => {
  expect(findListeningUrl('Listening on http://localhost:14013', 9999)).toBe(null);
});

// ⚠️ Le `\b` apres le port : sans lui, 1401 matcherait l'annonce de 14013 => on brancherait le
// proxy sur le serveur d'un AUTRE profil = action sur le mauvais compte Google.
test('un port PREFIXE d un autre ne matche pas (1401 vs 14013)', () => {
  expect(findListeningUrl('Listening on http://localhost:14013', 1401)).toBe(null);
});

test('fonction TOTALE : entrees absurdes => null, jamais un throw', () => {
  for (const [c, p] of [[null, 80], [undefined, 80], [42, 80], ['x', 0], ['x', -1], ['x', 1.5], ['x', null]]) {
    expect(findListeningUrl(c, p)).toBe(null);
  }
});

test('rien a annoncer => null', () => {
  expect(findListeningUrl('demarrage en cours...', 14013)).toBe(null);
  expect(findListeningUrl('', 14013)).toBe(null);
});

// ── flux incremental ────────────────────────────────────────────────────────────────────────
test('annonce COUPEE entre deux fragments : reconstituee', () => {
  const a = feedListening('', 'Listening on http://loca', 14013);
  expect(a.url).toBe(null);
  const b = feedListening(a.pending, 'lhost:14013\n', 14013);
  expect(b.url).toBe('http://localhost:14013');
  expect(b.pending, 'le tampon est vide une fois l URL trouvee').toBe('');
});

test('tampon BORNE : un serveur bavard qui n annonce jamais ne fait pas enfler la memoire', () => {
  let pending = '';
  for (let i = 0; i < 50; i++) pending = feedListening(pending, 'x'.repeat(1000), 14013).pending;
  expect(pending.length).toBeLessThanOrEqual(MAX_PENDING);
});

test('tampon borne : l annonce reste lisible meme apres beaucoup de bruit AVANT elle', () => {
  let pending = '';
  for (let i = 0; i < 50; i++) pending = feedListening(pending, 'bruit '.repeat(200), 14013).pending;
  const r = feedListening(pending, ' Listening on http://localhost:14013\n', 14013);
  expect(r.url, 'on conserve la FIN du flux : l annonce arrive apres le bruit').toBe('http://localhost:14013');
});

// ── property : le DECOUPAGE ne change JAMAIS le resultat (meme invariant que sse-parse) ──────
test('PROPERTY : quel que soit le decoupage en fragments, l URL extraite est la MEME', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1024, max: 65535 }),
      fc.string({ maxLength: 40 }),
      fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 20 }),
      (port, bruit, coupes) => {
        const url = `http://localhost:${port}/mcp`;
        const flux = `${bruit.replace(/[:/]/g, ' ')}Listening on ${url}\n`;
        // decoupage arbitraire du MEME flux
        let pending = '';
        let trouve = null;
        let i = 0;
        for (const n of [...coupes, flux.length]) {
          if (i >= flux.length) break;
          const r = feedListening(pending, flux.slice(i, i + n), port);
          pending = r.pending;
          if (r.url) { trouve = r.url; break; }
          i += n;
        }
        // le flux entier d'un coup doit donner exactement la meme chose
        const direct = findListeningUrl(flux, port);
        return trouve === null || trouve === direct;
      }
    ),
    { numRuns: 200 }
  );
});

test('PROPERTY : ne rend JAMAIS une URL dont le port differe de celui demande', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1024, max: 65535 }),
      fc.integer({ min: 1024, max: 65535 }),
      (attendu, annonce) => {
        const r = findListeningUrl(`Listening on http://localhost:${annonce}/mcp`, attendu);
        if (r === null) return true;
        return r.includes(`:${attendu}`); // jamais le serveur d'un autre profil
      }
    ),
    { numRuns: 300 }
  );
});

// ── durcissement mutation (Stryker) : chaque test vise un mutant PRECIS ────────────────────────
test('pending non-string (premier appel, valeur absurde) : traite comme vide, jamais un throw', () => {
  const r = feedListening(null, 'Listening on http://localhost:14013\n', 14013);
  expect(r.url).toBe('http://localhost:14013');
  expect(feedListening(undefined, 'rien\n', 14013).url).toBe(null);
  expect(feedListening(42, 'rien\n', 14013).url).toBe(null);
});

test('chunk non-string : ignore, le pending est conserve INTACT', () => {
  const r = feedListening('debut sans fin de ligne', null, 14013);
  expect(r.url).toBe(null);
  expect(r.pending, 'le pending ne doit pas etre perdu ni corrompu').toBe('debut sans fin de ligne');
});

// ⚠️ vise `rest.slice(nl + 1)` : un decalage ferait relire un bout de la ligne precedente.
test('PLUSIEURS lignes dans un seul fragment : l annonce est trouvee sur la 3e', () => {
  const r = feedListening('', 'demarrage\nchargement du profil\nListening on http://localhost:14013\n', 14013);
  expect(r.url).toBe('http://localhost:14013');
});

// ⚠️ vise `rest.slice(0, nl)` : sans la borne, l'URL d'une ligne SUIVANTE serait lue trop tot,
// et surtout une URL a cheval sur deux lignes serait recollee (le bug corrige ce matin).
test('une URL COUPEE par un saut de ligne n est JAMAIS recollee', () => {
  const r = feedListening('', 'http://localhost:140\n13/mcp\n', 14013);
  expect(r.url, 'deux lignes distinctes ne forment pas une annonce').toBe(null);
});

test('lignes AVANT l annonce : aucune ne doit produire de faux positif', () => {
  const r = feedListening('', 'port 14013 reserve\nautre chose\nok http://localhost:14013/mcp\n', 14013);
  expect(r.url, 'seule une vraie URL compte, pas le nombre nu dans du texte').toBe('http://localhost:14013/mcp');
});

// ⚠️ vise la comparaison `rest.length > MAX_PENDING` (mutant `>=`) et le signe de `slice(-N)`.
test('BORNE exacte du tampon : a MAX_PENDING pile, rien n est tronque', () => {
  const exact = 'a'.repeat(MAX_PENDING);
  expect(feedListening('', exact, 14013).pending.length).toBe(MAX_PENDING);
  const trop = 'b'.repeat(MAX_PENDING + 10);
  const r = feedListening('', trop, 14013);
  expect(r.pending.length).toBe(MAX_PENDING);
  expect(r.pending.endsWith('b'), 'on garde la FIN du flux, pas le debut').toBe(true);
});

// ⚠️ vise `return { pending: '', url }` : garder le reliquat rejouerait l'annonce a l'infini.
test('apres une annonce trouvee, le tampon est VIDE (pas de re-annonce en boucle)', () => {
  const r = feedListening('', 'Listening on http://localhost:14013\nsuite\n', 14013);
  expect(r.url).toBe('http://localhost:14013');
  expect(r.pending).toBe('');
});

// ⚠️ vise le littéral de la regex : guillemets/apostrophes bornent l'URL (JSON de log structuré).
test('URL entouree de guillemets (log JSON) : les delimiteurs ne sont pas avales', () => {
  expect(findListeningUrl('{"msg":"http://localhost:14013/mcp"}', 14013)).toBe('http://localhost:14013/mcp');
  expect(findListeningUrl("ready at 'http://localhost:14013/x'", 14013)).toBe('http://localhost:14013/x');
});

test('protocole : http ET https acceptes, mais pas un schema arbitraire', () => {
  expect(findListeningUrl('ws://localhost:14013/mcp', 14013)).toBe(null);
  expect(findListeningUrl('ftp://localhost:14013', 14013)).toBe(null);
});
