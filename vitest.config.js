// Config vitest PRINCIPALE : TOUT `npm test` (les 4 modules purs + tous les tests spawn/harness/
// integration). Pour la mutation Stryker (mutants sur les 6 modules purs UNIQUEMENT, jamais l'I/O
// spawn) -> config DEDIEE `vitest.pure.config.js` (referencee par stryker.conf.json).
//
// ⚠️ SERIALISATION OBLIGATOIRE (fileParallelism:false) : les tests spawn (integration,
// collision-integration, multi-agent, supervisor, contract-live) prennent des PORTS et ecrivent
// des REGISTRES FICHIERS PARTAGES (registre superviseur, verrou fichier). node:test les executait
// en serie de facto (chaque fichier = 1 process, mais la contention de ports/registre etait deja
// geree au prix de noms de profil UNIQUES par test) ; vitest PARALLELISE agressivement par defaut
// (plusieurs fichiers en vol simultanement) => sans serialisation, on AGGRAVE la flakiness de
// contention deja observee sur ce projet (registre superviseur partage, verrou fichier). La
// solution la PLUS SIMPLE qui garantit ZERO execution concurrente de fichiers de test = desactiver
// le parallelisme de fichiers globalement (les 4 tests purs sont rapides, le cout est negligeable
// sur le run complet). NE JAMAIS repasser fileParallelism a true sans reintroduire une isolation
// stricte des ports/registres entre fichiers spawn.
//
// ⚠️ pool:'forks' (1 process OS par fichier, comme node:test) : preserve le modele du harnais
// (tests/harness.js) qui identifie SES process via PROC_MARK = `PWMCP_TEST_${process.pid}` -- avec
// le pool 'threads' par defaut, plusieurs fichiers de test partageraient le MEME process.pid (les
// worker_threads ne creent pas de nouveau process OS), ce qui casserait l'hypothese "1 marqueur
// unique par fichier de test" du ratchet anti-fuite. 'forks' = 1 vrai process Node par fichier.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    globals: false,
    pool: 'forks',
    fileParallelism: false,
    // 🛑 DOIT DÉPASSER `READY_TIMEOUT_MS` (90 s, budget.js) + une marge — sinon un test ne peut
    // JAMAIS observer le chemin qu'il est censé couvrir : vitest l'abat AVANT que le code n'ait
    // rendu son verdict. Incohérence introduite le 02/08 en portant la readiness de 20 s à 90 s :
    // 3 tests LIVE sont tombés à 30 s pile, en accusant le produit alors que c'était la config.
    // ⚠️ UN TIMEOUT EST UNE BORNE, PAS UNE ATTENTE : il n'allonge AUCUN test qui passe, il ne
    // touche que ce qui dépasse. Le monter ne coûte donc RIEN — et évite un rouge qui ment.
    // ⚠️ Si `READY_TIMEOUT_MS` remonte un jour, CETTE valeur remonte avec (gate ci-dessous).
    testTimeout: 150000,
    hookTimeout: 30000,
  },
});
