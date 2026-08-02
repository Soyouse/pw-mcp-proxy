// GATE — `tsc --checkJs` sur `src/` : ZÉRO erreur, et ça le reste.
//
// 🛑 POURQUOI CE GATE EXISTE. Le typage a trouvé, en une seule passe, une classe d'erreurs que
// 322 tests verts ne voyaient pas — parce qu'elle vit sur des chemins RARES (une raison de rejet
// qui n'est pas une `Error`, une option de constructeur non déclarée, un `READY_TIMEOUT_MS` utilisé
// sans import qui n'aurait explosé que le jour où un appelant omettrait le budget).
// Ce sont exactement les bugs qu'un test d'intégration ne rencontre jamais et qu'un utilisateur, si.
//
// ⚠️ ZÉRO `.ts`, ZÉRO build, ZÉRO dépendance runtime : on annote en **JSDoc**, TypeScript n'est
// qu'un vérificateur (devDependency). NE JAMAIS convertir le projet en TypeScript pour faire
// passer ce gate — ce serait échanger un invariant du dépôt contre du confort.
// ⚠️ La bonne façon de le faire passer est de RESSERRER le type (décrire ce que le code lit
// vraiment), jamais de l'élargir en `any` ni d'ajouter `@ts-ignore`.

import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('GATE : `npm run typecheck` ne rapporte AUCUNE erreur', () => {
  let sortie = '';
  try {
    // ⚠️ `execFileSync` synchrone assumé (cf harnais) : le process est mort au retour.
    execFileSync('npm', ['run', '--silent', 'typecheck'], { cwd: RACINE, encoding: 'utf8', shell: true });
  } catch (e) {
    // ⚠️ tsc sort en code NON-ZÉRO dès qu'il trouve : le rapport est dans stdout, pas stderr.
    sortie = (e?.stdout || '') + (e?.stderr || '');
  }
  const erreurs = sortie.split('\n').filter((l) => l.includes('error TS'));
  expect(erreurs, `Typage cassé — RESSERRER le type (jamais \`any\` ni @ts-ignore) :\n${erreurs.join('\n')}`).toEqual([]);
}, 120000);
