// Tests du module PUR deadline.js (course promesse vs echeance). DETERMINISTES : le timer est
// INJECTE, aucun faux timer, aucune attente reelle => mutation-testable sans flake.
// Invariants scelles : un repli UNIQUE (echeance ET rejet), preservation des valeurs falsy,
// et surtout AUCUN unhandledRejection sur un rejet TARDIF (qui tuerait le proxy longtemps apres).

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { withDeadline, defaultDelay } from '../src/deadline.js';

const JAMAIS = () => new Promise(() => {}); // echeance qui n'arrive jamais
const AUSSITOT = () => Promise.resolve(); // echeance deja atteinte

test('la promesse gagne : {ok:true, value}', async () => {
  expect(await withDeadline(Promise.resolve('X'), 10, { delay: JAMAIS })).toEqual({ ok: true, value: 'X' });
});

test('l echeance gagne : {ok:false} (et JAMAIS un rejet)', async () => {
  const r = await withDeadline(new Promise(() => {}), 10, { delay: AUSSITOT });
  expect(r.ok, 'une echeance n est PAS une erreur : c est une decision de repli').toBe(false);
  expect(r.value, 'aucune valeur quand on n a pas gagne').toBeUndefined();
});

test('un REJET vaut echeance : le caller n a qu UN SEUL chemin de repli a ecrire', async () => {
  const r = await withDeadline(Promise.reject(new Error('boom')), 10, { delay: JAMAIS });
  expect(r.ok).toBe(false);
});

test('valeurs FALSY preservees (0, null, false, chaine vide, undefined)', async () => {
  // ⚠️ Tueur de mutant : tester la truthiness de la valeur au lieu du drapeau `ok` ferait passer
  // une resolution legitime a `0`/`null` pour une echeance => repli a tort, donc regression.
  for (const v of [0, null, false, '', undefined]) {
    const r = await withDeadline(Promise.resolve(v), 5, { delay: JAMAIS });
    expect(r.ok, `valeur ${String(v)} : resolution reussie`).toBe(true);
    expect(r.value).toBe(v);
  }
});

test('une valeur NON-promesse est acceptee telle quelle', async () => {
  expect(await withDeadline(42, 5, { delay: JAMAIS })).toEqual({ ok: true, value: 42 });
});

test('le delai est transmis TEL QUEL au timer (aucune arithmetique cachee)', async () => {
  let vu = null;
  const espion = (ms) => { vu = ms; return new Promise(() => {}); };
  await withDeadline(Promise.resolve(1), 1234, { delay: espion });
  expect(vu, 'la borne passee est celle utilisee').toBe(1234);
});

test('options omises : le timer par defaut est utilise sans throw', async () => {
  // La promesse gagne largement : on ne depend d aucune duree reelle (zero flake).
  expect(await withDeadline(Promise.resolve('ok'), 50_000)).toEqual({ ok: true, value: 'ok' });
});

// ---------- property : fonction TOTALE + repli unique ----------
test('property : withDeadline est TOTALE — jamais de throw, `ok` TOUJOURS booleen', async () => {
  // Invariant fort : quelle que soit l'entree (valeur brute, promesse tenue, promesse rompue),
  // le caller recoit TOUJOURS un verdict exploitable. Une exception ici casserait le handshake
  // au pire moment (le repli degrade ne serait jamais envoye => session perdue).
  await fc.assert(
    fc.asyncProperty(fc.anything(), fc.boolean(), async (v, rompue) => {
      const entree = rompue ? Promise.reject(new Error('boom')) : Promise.resolve(v);
      const r = await withDeadline(entree, 5, { delay: JAMAIS });
      return typeof r.ok === 'boolean' && r.ok === !rompue;
    }),
    { numRuns: 120 }
  );
});

test('property : une valeur tenue est rendue TELLE QUELLE (aucune transformation)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.anything(), async (v) => {
      const r = await withDeadline(Promise.resolve(v), 5, { delay: JAMAIS });
      return r.ok === true && Object.is(r.value, v); // Object.is : gere NaN et -0
    }),
    { numRuns: 120 }
  );
});

test('property : echeance atteinte => TOUJOURS {ok:false}, quelle que soit la promesse', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 100000 }), async (ms) => {
      const r = await withDeadline(new Promise(() => {}), ms, { delay: AUSSITOT });
      return r.ok === false && r.value === undefined;
    }),
    { numRuns: 60 }
  );
});

test('REJET TARDIF apres echeance : AUCUN unhandledRejection (invariant vital)', async () => {
  // ⚠️ La promesse perdante continue de vivre (rien n est annulable en JS). Si son rejet n etait pas
  // absorbe, il remonterait en unhandledRejection LONGTEMPS apres, et tuerait le proxy alors que
  // plus personne n attend ce resultat. C est CE test qui scelle le catch no-op de deadline.js.
  const vus = [];
  const onUnhandled = (e) => vus.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejeter;
    const tardive = new Promise((_, rej) => { rejeter = rej; });
    const r = await withDeadline(tardive, 1, { delay: AUSSITOT });
    expect(r.ok, 'l echeance a bien gagne').toBe(false);
    rejeter(new Error('rejet tardif')); // arrive APRES que le caller soit passe a autre chose
    await new Promise((res) => setTimeout(res, 30)); // laisse le temps a l event de remonter
    expect(vus.length, 'le rejet tardif DOIT etre absorbe').toBe(0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---------- defaultDelay : le SEUL morceau non deterministe, rendu mutation-testable par injection ----
// ⚠️ Sans ces tests, Stryker laissait 7 mutants VIVANTS ici (score 58,82 %) : le corps du timer par
// defaut n'etait exerce par AUCUN test, puisque tous injectent leur propre `delay`. Un trou de mutation
// n'est jamais « juste un chiffre » : il signifie qu'on peut casser ce code sans qu'aucun test ne crie.
test('defaultDelay : passe la borne TELLE QUELLE au timer (aucune arithmetique cachee)', async () => {
  // ⚠️ Tueur du mutant `setTimeout(resolve, 0)` : une echeance instantanee ferait repondre DEGRADE a
  // TOUS les handshakes (liste d'outils amputee en permanence) — la regression du ratio 0.4, en pire.
  let vu = null;
  const faux = (cb, ms) => { vu = ms; cb(); return null; };
  await defaultDelay(1234, { timer: faux });
  expect(vu, 'le delai demande est celui arme').toBe(1234);
});

test('defaultDelay : unref() APPELE sur le handle (le timer ne retient jamais l event loop)', async () => {
  // ⚠️ Tueur du mutant qui supprime `unref()` : sans lui, le proxy REFUSE de s arreter tant qu une
  // echeance court (jusqu a 24 s de retard a chaque fermeture de fenetre Claude). Bug invisible en
  // test classique, tres visible a l usage.
  let unrefAppele = 0;
  const handle = { unref: () => { unrefAppele++; } };
  const faux = (cb) => { cb(); return handle; };
  await defaultDelay(5, { timer: faux });
  expect(unrefAppele, 'unref appele exactement une fois').toBe(1);
});

test('defaultDelay : handle SANS unref (hors Node) => aucun throw', async () => {
  // ⚠️ Tueur des mutants sur la garde `t && typeof t.unref === 'function'` : la retirer ferait planter
  // le proxy dans tout runtime dont setTimeout ne rend pas un objet Node (navigateur, Deno, Bun).
  await expect(defaultDelay(1, { timer: (cb) => { cb(); return 7; } })).resolves.toBeUndefined();
  await expect(defaultDelay(1, { timer: (cb) => { cb(); return null; } })).resolves.toBeUndefined();
  await expect(defaultDelay(1, { timer: (cb) => { cb(); return { unref: 'pas une fonction' }; } })).resolves.toBeUndefined();
});

test('defaultDelay : le VRAI timer resout bien (aucun override) — borne courte, zero flake', async () => {
  await expect(defaultDelay(5)).resolves.toBeUndefined();
});
