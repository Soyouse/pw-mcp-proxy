// GATE STATIQUE — « LE SILENCE SE DÉCLARE », exactement comme le temps.
//
// 🛑 CE QU'ON REFUSE, ET CE QU'ON N'EXIGE PAS. On n'exige PAS que tout `catch` crie : rendre une
// panne visible est un CHANGEMENT DE COMPORTEMENT (payé le 02/08 — une borne posée « en soi » a
// déclenché une boucle de spawn Chrome). Certains silences sont OBLIGATOIRES : logguer l'échec du
// logger est récursif, tuer un process déjà mort est le résultat VOULU.
// Ce qu'on refuse, c'est le silence **NON DÉCLARÉ** — celui dont plus personne ne sait s'il est
// réfléchi ou oublié. Un relecteur ne peut pas faire la différence, et aucun humain ne relit.
//
// ⚠️ NE JAMAIS « corriger » un rouge de ce gate en collant `SILENCE:` sans réfléchir : la question
// à se poser est « qui apprend cette panne, et comment ? ». Si la réponse est PERSONNE et que ça
// compte, il faut un `log(describeError(e))`, pas un marqueur.
// Trouvé par ce raisonnement le 02/08 : un `_tuer(pid)` avalé laissait fuir un serveur avorté qui
// tenait son `--user-data-dir` — il crie désormais.

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
// `catch {}` ou `catch (e) {}` — corps STRICTEMENT vide, donc sans la moindre justification.
const CATCH_MUET = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

const fichiers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

test('GATE : aucun catch silencieux NON DÉCLARÉ dans src/', () => {
  const coupables = [];
  for (const f of fichiers) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    code.split('\n').forEach((ligne, i) => {
      CATCH_MUET.lastIndex = 0;
      if (CATCH_MUET.test(ligne)) coupables.push(`${f}:${i + 1} → ${ligne.trim().slice(0, 80)}`);
    });
  }
  expect(coupables, `Silence NON DÉCLARÉ. Ajouter /* SILENCE: <pourquoi> */ dans le catch — ou, si la panne doit être connue, logguer avec describeError.\n${coupables.join('\n')}`).toEqual([]);
});

// NEGATIVE-CHECK : le détecteur voit-il vraiment un silence non déclaré ? Sans ça, le gate
// pourrait être vert parce qu'il ne détecte RIEN — le pire des faux verts.
test('NEGATIVE-CHECK : le détecteur rougit sur du code fautif fabriqué', () => {
  for (const faute of ['try { a(); } catch {}', 'try { a(); } catch (e) {}', 'try{a()}catch{ }']) {
    CATCH_MUET.lastIndex = 0;
    expect(CATCH_MUET.test(faute), `doit détecter : ${faute}`).toBe(true);
  }
  // ...et NE rougit PAS quand le silence est déclaré (sinon le gate serait inapplicable).
  for (const bon of ['try { a(); } catch { /* SILENCE: process deja mort */ }', 'try { a(); } catch (e) { log(e); }']) {
    CATCH_MUET.lastIndex = 0;
    expect(CATCH_MUET.test(bon), `ne doit PAS rougir : ${bon}`).toBe(false);
  }
});

// ⚠️ CLIQUET : la justification doit être une PHRASE, pas un marqueur vide posé pour taire le gate.
test('GATE : chaque SILENCE porte une raison LISIBLE (jamais un marqueur vide)', () => {
  const faibles = [];
  for (const f of fichiers) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of code.matchAll(/SILENCE:([^*]*)\*\//g)) {
      const raison = m[1].trim();
      if (raison.split(/\s+/).length < 4) faibles.push(`${f} → « ${raison} »`);
    }
  }
  expect(faibles, `Justification trop courte pour apprendre quoi que ce soit :\n${faibles.join('\n')}`).toEqual([]);
});
