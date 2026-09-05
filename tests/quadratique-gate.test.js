// ─────────────────────────────────────────────────────────────────────────────
// GATE « LA COMPLEXITÉ SE DÉCLARE » — 3ᵉ jumeau du TEMPS (`no-inference-gate`) et de l'ESPACE.
//
// ⚠️ POURQUOI CE GATE EXISTE
//    Un défaut d'échelle ne « ralentit » pas : il FERME UN CONTRAT, et son retrofit est
//    prohibitif ⇒ il appartient à la SPEC, jamais à un réglage ultérieur. La règle vivait EN
//    PROSE dans CLAUDE.md et a été violée PLUSIEURS FOIS dans la même session, par l'agent qui
//    venait de l'appliquer dix minutes plus tôt. Le biais est STRUCTUREL : on raisonne sur ce
//    qu'on MESURE, et on mesure toujours le PRÉSENT. ⇒ De la prose ne refuse rien.
//
// ⚠️ SÉPARATION DES RÔLES, ne jamais la fusionner (même patron que le gate temporel) :
//      • `rules/no-undeclared-quadratic.yml` = DÉTECTION exacte, AUCUNE exemption dedans
//      • CE FICHIER                          = POLITIQUE (budget par fichier) + CLIQUET
//    Deux jeux d'exemptions divergeraient en silence.
//
// 🛑 NE JAMAIS remonter un `max` pour faire passer un push. Le cliquet ne DESCEND que.
// 🛑 NE JAMAIS modifier du code de production pour faire baisser un compte au moment de poser le
//    gate : le budget DÉCLARE l'existant, il ne le corrige pas.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RACINE, scanRegle, scanRegleSansCache, invaliderCacheAstGrep, parFichier } from './ast-grep.js';

const REGLE = path.join(RACINE, 'rules', 'no-undeclared-quadratic.yml');

// ⚠️ SOUS STRYKER, CE GATE NE LIT PAS NOTRE CODE — il lit du code INSTRUMENTÉ, dont les gardes
//    ajoutées par l'instrumentation FABRIQUENT des imbrications qui n'existent nulle part chez
//    nous. 🛑 Ce n'est PAS un assouplissement : il tourne INTÉGRALEMENT dans `npm test`, sur les
//    sources RÉELLES (et `vitest.pure.config.js` ne l'inclut pas). On refuse seulement de juger
//    du code qui n'est pas le nôtre.
const SOUS_STRYKER = RACINE.includes('.stryker-tmp');

// PÉRIMÈTRE = `src/`, TOUT le code qui tourne (même périmètre que le gate temporel : le runtime
// de ce dépôt vit intégralement là, et rien d'autre n'est livré).
const PERIMETRE = ['src'];

// ── LIGNE DE BASE, GÉNÉRÉE PAR MESURE le 2026-08-20 avec l'outil QUI GATE ────
// (ast-grep + rules/no-undeclared-quadratic.yml : 9 fichiers / 17 occurrences. Jamais un chiffre
//  choisi, jamais recopié d'un autre dépôt — un chiffre choisi serait le jugement d'un jour.)
//
// ⚠️ `DETTE_HERITEE` = la MESURE DU JOUR, PAS un blanc-seing et PAS une justification : personne
//    n'a instruit ces 9 fichiers un par un. Le volet ⑤ en DISPENSE la justification À DESSEIN —
//    en exiger une produirait 9 phrases INVENTÉES, qui feraient croire les cas tranchés. Une
//    justification fausse est PIRE que pas de justification.
// CONDITION DE SORTIE : zéro entrée `DETTE_HERITEE` restante.
const CLASSES = new Set(['O(N)', 'O(N log N)', 'DETTE', 'DETTE_HERITEE']);

const BUDGET = {
  'src/http-transport.js': { max: 2, classe: 'DETTE_HERITEE' },
  // Posé le 05/09/2026 (`attendreLibre`) : la boucle de sondage relit `tenants.filter(vivant)` — les
  // tenants sont les PID qui nomment UN dossier d'instance (un Chrome + son serveur : 2-3 process,
  // bornés par l'instance, jamais par la flotte), et le nombre de tours est borné par le budget.
  'src/identity-store.js': {
    max: 1,
    classe: 'O(N)',
    pourquoi: 'sondage des tenants d UN dossier d instance (2-3 PID, bornés par l instance et non par la flotte) répété au pas du budget de libération : linéaire en tours × tenants, jamais un produit de deux collections',
  },
  'src/janitor-pure.js': { max: 3, classe: 'DETTE_HERITEE' },
  'src/janitor.js': { max: 1, classe: 'DETTE_HERITEE' },
  'src/jsonrpc.js': { max: 1, classe: 'DETTE_HERITEE' },
  'src/manager.js': { max: 1, classe: 'DETTE_HERITEE' },
  'src/prockill-pure.js': { max: 3, classe: 'DETTE_HERITEE' },
  'src/prockill.js': { max: 3, classe: 'DETTE_HERITEE' },
  'src/router.js': { max: 1, classe: 'DETTE_HERITEE' },
  'src/sse-parse.js': { max: 2, classe: 'DETTE_HERITEE' },
};

const scan = () => parFichier(scanRegle(REGLE, PERIMETRE));

const AIDE =
  "\n→ SORTIE : index inversé / Map / Set — élaguer ce qu'on PROUVE hors seuil." +
  '\n→ Vraiment borné (profils déclarés, en-têtes, sessions) ? Déclarer la classe O(N) + le POURQUOI.' +
  '\n🛑 JAMAIS un algorithme probabiliste (LSH/échantillonnage) : un faux négatif a un coût client.';

describe.skipIf(SOUS_STRYKER)('la complexité se déclare — parcours imbriqués (AST)', () => {
  // ── ANTI-SONDE-MUETTE ──────────────────────────────────────────────────────
  // ⚠️ Sans ce volet, une règle cassée, un binaire absent ou un périmètre vide rendraient `{}` ⇒
  //    TOUS les autres volets passeraient au vert PAR VACUITÉ. C'est la pire panne possible d'un
  //    gate : celle qui ressemble à une bonne nouvelle.
  // 🔍 MESURÉ à la pose : ast-grep rend un JSON VIDE, en sortie 0, quand on lui donne un chemin
  //    HORS du projet — un scan muet est un mode de panne RÉEL ici, pas théorique.
  test('le scan MESURE réellement quelque chose', () => {
    expect(
      Object.keys(scan()).length,
      'Le scan ne rend AUCUN fichier — règle cassée, binaire absent ou périmètre vide.\n' +
        'Un budget confronté à zéro mesure serait vert POUR TOUJOURS.'
    ).toBeGreaterThan(0);
  });

  // ── ① FICHIER NON DÉCLARÉ = TENU À ZÉRO ────────────────────────────────────
  test('aucun parcours imbriqué dans un fichier NON déclaré', () => {
    const clandestins = Object.entries(scan()).filter(([f]) => !BUDGET[f]);
    expect(
      clandestins,
      'Parcours imbriqué NON DÉCLARÉ : ' +
        clandestins.map(([f, n]) => `${f}(${n})`).join(', ') +
        '\nUn fichier absent du budget est tenu à ZÉRO — c\'est ce qui donne 100 % de la règle sur' +
        '\ntout code NEUF sans exiger de réparer d\'abord tout l\'existant.' +
        AIDE
    ).toEqual([]);
  });

  // ── ② CLIQUET MONTANT ──────────────────────────────────────────────────────
  test('aucun budget dépassé (le cliquet ne remonte jamais)', () => {
    const par = scan();
    const trop = Object.entries(BUDGET)
      .filter(([f, e]) => (par[f] || 0) > e.max)
      .map(([f, e]) => `${f} : ${par[f]} > ${e.max}`);
    expect(
      trop,
      'Budget de complexité DÉPASSÉ :\n  ' +
        trop.join('\n  ') +
        '\n🛑 NE PAS remonter le `max`. Ce serait déclarer que le code a le droit d\'empirer.' +
        AIDE
    ).toEqual([]);
  });

  // ── ③ CLIQUET INVERSE : un progrès non enregistré se REPERD ─────────────────
  test('aucun progrès non enregistré (cliquet inverse)', () => {
    const par = scan();
    const baisses = Object.entries(BUDGET)
      .filter(([f, e]) => (par[f] || 0) < e.max && (par[f] || 0) > 0)
      .map(([f, e]) => `${f} : ${par[f]} < ${e.max}`);
    expect(
      baisses,
      'Progrès NON ENREGISTRÉ :\n  ' +
        baisses.join('\n  ') +
        '\n→ Baisser le `max` à la valeur mesurée, dans le MÊME geste. Sans ça le terrain gagné' +
        '\n  est repris en silence par le prochain, qui a droit à l\'ancien plafond.'
    ).toEqual([]);
  });

  // ── ④ ZÉRO ENTRÉE FANTÔME ──────────────────────────────────────────────────
  // ⚠️ Même classe de défaut que celle trouvée le 03/08 dans le gate temporel : `supervisor.js`
  //    supprimé, ses budgets restés ⇒ un fichier recréé aurait hérité du droit, gate au vert.
  test('aucune entrée périmée au budget', () => {
    const par = scan();
    const fantomes = Object.keys(BUDGET).filter((f) => !par[f]);
    expect(
      fantomes,
      'Entrée de budget qui ne correspond à RIEN : ' +
        fantomes.join(', ') +
        '\n→ Fichier supprimé/renommé, ou occurrences toutes corrigées : RETIRER la ligne.' +
        '\n⚠️ Une entrée fantôme est un PERMIS DORMANT : un fichier recréé hériterait du droit.'
    ).toEqual([]);
  });

  // ── ⑤ LA DÉCLARATION DOIT DIRE QUELQUE CHOSE ───────────────────────────────
  test('toute entrée porte une classe connue, et toute entrée INSTRUITE se justifie', () => {
    const inconnues = Object.entries(BUDGET)
      .filter(([, e]) => !CLASSES.has(e.classe))
      .map(([f, e]) => `${f} (classe ${e.classe})`);
    expect(
      inconnues,
      `Classe hors liste FERMÉE : ${inconnues.join(', ')}\nClasses admises : ${[...CLASSES].join(' · ')}`
    ).toEqual([]);

    const sansPourquoi = Object.entries(BUDGET)
      .filter(([, e]) => e.classe !== 'DETTE_HERITEE' && String(e.pourquoi || '').length <= 60)
      .map(([f]) => f);
    expect(
      sansPourquoi,
      `Entrée instruite SANS justification (>60 car.) : ${sansPourquoi.join(', ')}\n` +
        '→ Écrire sur QUOI porte la boucle interne et pourquoi elle est bornée.'
    ).toEqual([]);

    // ⚠️ Un budget mesure la QUANTITÉ, jamais la GRAVITÉ — même leçon que l'`impact` exigé sur
    //    les dettes du gate temporel : on relit « N en dette » sans voir laquelle casse.
    const sansImpact = Object.entries(BUDGET)
      .filter(([, e]) => e.classe === 'DETTE' && String(e.impact || '').length < 40)
      .map(([f]) => f);
    expect(
      sansImpact,
      `DETTE sans impact CHIFFRÉ (≥40 car.) : ${sansImpact.join(', ')}\n` +
        '→ Écrire ce que ça coûte à 10 000 : « à 5 000 éléments = 12,5 M de paires ».'
    ).toEqual([]);
  });
});

// ═══ NEGATIVE-CHECK OBLIGATOIRE (anti-gate-creux) ═════════════════════════════
// ⚠️ Un gate non saboté ne prouve RIEN. On prouve que la règle voit ce qu'elle prétend voir, ET
//    qu'elle se tait sur le sain (un gate à faux positifs finit désactivé).
// ⚠️ LES LEURRES VIVENT DANS UN DOSSIER DÉDIÉ, HORS du périmètre de production : écrire un faux
//    fichier dans `src/` ferait rougir `arborescence-gate` et les autres gates statiques — un gate
//    ne doit jamais rendre un AUTRE gate flaky. Le dossier est éphémère et non suivi par git.
describe.skipIf(SOUS_STRYKER)('NEGATIVE-CHECK : la règle voit ce qu\'elle prétend voir', () => {
  const BAC = path.join(RACINE, '.sonde-quadratique');

  function avecLeurre(contenu, verif) {
    fs.mkdirSync(BAC, { recursive: true });
    const nom = '.sonde-quadratique/leurre.js';
    fs.writeFileSync(path.join(BAC, 'leurre.js'), contenu);
    try {
      invaliderCacheAstGrep();
      verif(parFichier(scanRegleSansCache(REGLE, ['.sonde-quadratique'])), nom);
    } finally {
      fs.rmSync(BAC, { recursive: true, force: true });
      invaliderCacheAstGrep(); // sinon un test suivant lirait un cache CONTAMINÉ
    }
  }

  test('une boucle DANS une boucle est DÉTECTÉE', () => {
    avecLeurre(
      'export const f = (xs, ys) => { for (const x of xs) { for (const y of ys) { void x, y; } } };\n',
      (vu, nom) => expect(Object.keys(vu), 'for..of dans for..of DOIT être vu').toContain(nom)
    );
  });

  test('⚠️ un parcours FONCTIONNEL imbriqué est DÉTECTÉ', () => {
    // 🔴 CE VOLET EXISTE PARCE QU'UNE RÈGLE ÉCRITE AVEC DES MÉTAVARIABLES CAPTURANTES LE RATE :
    //    elles s'UNIFIENT entre les deux étages, donc celle liée au tableau extérieur exigerait le
    //    MÊME tableau à l'intérieur. La règle verrait 4 formes sur 5 et aurait l'air correcte.
    //    C'est la forme la plus courante du O(N²) moderne. NE JAMAIS retirer ce volet ni les `_`.
    avecLeurre(
      'export const f = (xs, ys) => xs.map((x) => ys.find((y) => y.id === x.id));\n',
      (vu, nom) => expect(Object.keys(vu), 'parcours fonctionnel imbriqué DOIT être vu').toContain(nom)
    );
  });

  test('une recherche linéaire DANS une boucle est DÉTECTÉE', () => {
    // Le seul O(N²) réellement MESURÉ dans ce parc était un `.find()` DANS une boucle :
    // syntaxiquement ce n'est PAS une boucle imbriquée. Une règle qui ne verrait que
    // `for`-dans-`for` serait donc creuse, et contournable en réécrivant en `.map()`.
    avecLeurre(
      'export const f = (xs, ys) => { for (const x of xs) { if (ys.includes(x)) return x; } };\n',
      (vu, nom) => expect(Object.keys(vu), 'une recherche linéaire en boucle DOIT être vue').toContain(nom)
    );
  });

  test('⚠️ une boucle SIMPLE n\'est PAS comptée (zéro faux positif)', () => {
    avecLeurre(
      'export const f = (xs) => { for (const x of xs) { console.log(x); } };\n',
      (vu, nom) => expect(Object.keys(vu), 'un parcours linéaire ne DOIT PAS compter').not.toContain(nom)
    );
  });

  test('⚠️ une imbrication en COMMENTAIRE ou en CHAÎNE n\'est PAS comptée', () => {
    // Le symétrique : un gate à faux positifs finit désactivé. C'est ce que l'AST supprime — et
    // c'est pourquoi un grep, qui rend un mur de candidats presque tous faux, a été rejeté.
    avecLeurre(
      "// for (const a of b) { for (const c of d) {} }\nexport const s = 'for (x of y) { z.find(w) }';\n",
      (vu, nom) => expect(Object.keys(vu), 'prose et chaînes ne DOIVENT PAS compter').not.toContain(nom)
    );
  });
});
