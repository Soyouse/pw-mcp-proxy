// GATE : aucun fichier SUIVI ne doit contenir de code instrumenté par Stryker.
//
// 🔴 LA CLASSE FERMÉE ICI (incident réel du parc, 09/08/2026 — wz-design-engine) :
//    avec `inPlace`, Stryker ne restaure les sources qu'en fin de run NORMALE. Un
//    timeout, un kill ou un crash saute cette étape ⇒ des fichiers SOURCES restent
//    truffés d'instrumentation sur le disque — et **les tests restent VERTS**, car
//    l'instrumentation est transparente. Le commit suivant embarque alors un moteur
//    corrompu, SANS AUCUN SYMPTÔME. C'est la définition même de la régression
//    silencieuse : rien ne rougit, et la faute part en production.
//
// ⚠️ Ce gate ne remplace PAS le réflexe (`git checkout -- .` + purge du bac à sable
//    après tout run interrompu) : il le rend inutile en le rendant mécanique.
//
// ⚠️ PÉRIMÈTRE = les fichiers SUIVIS PAR GIT, jamais le disque : le bac à sable
//    `.stryker-tmp/` est gitignoré et contient LÉGITIMEMENT des copies instrumentées.
//    Le juger reviendrait à un mur de faux rouges, donc à un gate qu'on débranche.
//
// ⚠️ HARNAIS : ce fichier ne SPAWNE aucun process durable — il n'a donc rien à faire passer par
//    `tests/harness.js` (dont le rôle est le tracking/kill des process qui SURVIVENT au test).
//    Le seul appel externe est un `execFileSync('git', ...)` SYNCHRONE : le process est mort au
//    retour, fuite impossible, ratchet non concerné. MÊME forme et MÊME justification que
//    `arborescence-gate.test.js`. 🛑 NE JAMAIS le convertir en spawn asynchrone.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ⚠️ JETONS COMPOSÉS À L'EXÉCUTION, jamais écrits d'un seul tenant : sinon CE FICHIER
//    se dénoncerait lui-même et il faudrait s'auto-exempter — une exemption qui, une
//    fois posée, masquerait aussi une vraie instrumentation de ce même fichier.
const JETONS = ["stry" + "MutAct_", "stry" + "NS_", "stry" + "Cov_"];

// EXEMPTIONS — fichiers qui citent LÉGITIMEMENT un jeton parce qu'ils le DÉTECTENT.
// ⚠️ CLIQUET : une exemption périmée (fichier disparu, ou ne citant plus rien) est
//    ROUGE elle aussi. Une liste d'exemptions qu'on n'élague jamais finit par tout couvrir.
// Mesuré à la pose (20/08/2026) : AUCUN fichier suivi ne cite de jeton ⇒ liste vide.
const EXEMPTIONS = {};

function fichiersSuivis() {
  // ⚠️ Hors d'un arbre git (bac à sable Stryker), git rend ZÉRO ou THROW. C'est une MESURE
  //    IMPOSSIBLE, jamais un défaut — les confondre produit un verdict MENTEUR.
  try {
    const sortie = execFileSync("git", ["ls-files"], { cwd: RACINE, encoding: "utf8" });
    return sortie.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// PRÉCONDITION D'ENVIRONNEMENT : les sources doivent être atteignables ET suivies.
// 🛑 Ce skip ne rend PAS le gate inerte — la CI et les runs locaux tournent dans le vrai
//    dépôt, et c'est là que ce gate mord.
const MESURABLE = existsSync(path.join(RACINE, "package.json")) && fichiersSuivis().length > 0;

function contientUnJeton(chemin) {
  let brut;
  try {
    brut = readFileSync(path.join(RACINE, chemin), "utf8");
  } catch {
    return false; // fichier suivi mais absent du disque (checkout partiel) : pas notre sujet
  }
  return JETONS.some((j) => brut.includes(j));
}

describe.skipIf(!MESURABLE)("gate — aucune source suivie n'est instrumentée par Stryker (SKIP hors arbre git : mesure impossible)", () => {
  const suivis = fichiersSuivis();

  it("⚠️ anti-sonde-muette : le relevé voit bien des fichiers", () => {
    // Sans ce volet, un `git ls-files` cassé rendrait le gate VERT PAR VACUITÉ.
    expect(suivis.length).toBeGreaterThan(50);
  });

  it("⚠️ ANTI-INERTE : le détecteur reconnaît une instrumentation RÉELLE", () => {
    // Forme réellement émise par Stryker (fonction de garde + compteur de couverture).
    const echantillon = `function ${JETONS[0]}9fa48(){} if (${JETONS[0]}9fa48("12")) { ${JETONS[2]}.x++; }`;
    expect(JETONS.some((j) => echantillon.includes(j))).toBe(true);
    // Et il ne crie pas sur du code sain.
    expect(JETONS.some((j) => "export const x = 1;".includes(j))).toBe(false);
  });

  it("⛔ aucun fichier suivi non exempté ne porte de jeton d'instrumentation", () => {
    const coupables = suivis.filter((f) => !(f in EXEMPTIONS)).filter(contientUnJeton);
    expect(
      coupables,
      coupables.length
        ? "\n🔴 SOURCES INSTRUMENTÉES COMMITÉES OU EN ATTENTE DE COMMIT :\n" +
          coupables.map((f) => "   - " + f).join("\n") +
          "\n\nUn run Stryker a été interrompu et n'a pas restauré ses sources.\n" +
          "Les tests restent VERTS dans cet état : ne PAS conclure que tout va bien.\n" +
          "Réparer : `git checkout -- .` puis supprimer le bac à sable `.stryker-tmp/`.\n"
        : "",
    ).toEqual([]);
  });

  it("⚠️ cliquet inverse : aucune exemption périmée", () => {
    const perimees = Object.keys(EXEMPTIONS).filter((f) => !suivis.includes(f) || !contientUnJeton(f));
    expect(
      perimees,
      "Exemption(s) qui ne protègent plus rien — les retirer :\n" + perimees.join("\n"),
    ).toEqual([]);
  });

  it("chaque exemption porte une RAISON (une liste sans raison se remplit toute seule)", () => {
    for (const [f, raison] of Object.entries(EXEMPTIONS)) {
      expect(raison.length, f).toBeGreaterThan(20);
    }
  });
});
