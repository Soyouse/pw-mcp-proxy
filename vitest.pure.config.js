// Config vitest DEDIEE aux fichiers de tests des modules PURS (cibles Stryker vitest-runner).
// Referencee explicitement par stryker.conf.json (vitest.configFile) : Stryker ne DOIT jamais
// tourner sur les tests spawn/integration (I/O reelle, hors mutation par doctrine) -> mutant run
// sur tout le repo serait a la fois FAUX (mute des fonctions pures via des tests d'I/O sans lien)
// et CATASTROPHIQUE en duree (spawn de vrais process/serveurs a CHAQUE mutant).
// `npm run test:pure` l'utilise aussi (sous-ensemble rapide, parallele par defaut).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ⚠️ TOUTE ENTRÉE DOIT EXISTER — scellé par `arborescence-gate.test.js`.
    // Vitest IGNORE EN SILENCE un `include` qui ne matche rien : une suite renommée sort
    // donc de la MUTATION sans un mot, et le score reste vert sur un périmètre AMPUTÉ.
    // Mesuré 02/08/2026 : 4 entrées fantômes (server-registry, listening-line,
    // proc-identity-pure, clock) survivaient à l'amputation du superviseur.
    include: [
      'tests/pure.test.js', // collision + prockill-pure + spec + spawn-cmd
      'tests/sse-parse.test.js',
      'tests/log-rotate.test.js',
      'tests/auto-restart.test.js',
      'tests/freeze-report.test.js',
      'tests/budget.test.js',
      'tests/daemon-protocol.test.js',
      'tests/deadline.test.js',
      'tests/error-detail.test.js',
      'tests/channel-name.test.js',
      'tests/janitor.test.js', // decision du concierge (victimesConcierge) — PURE + property
    ],
    globals: false,
  },
});
