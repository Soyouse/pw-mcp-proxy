// Config vitest DEDIEE aux 4 fichiers de tests des modules PURS (cibles Stryker vitest-runner).
// Referencee explicitement par stryker.conf.json (vitest.configFile) : Stryker ne DOIT jamais
// tourner sur les tests spawn/integration (I/O reelle, hors mutation par doctrine) -> mutant run
// sur tout le repo serait a la fois FAUX (mute des fonctions pures via des tests d'I/O sans lien)
// et CATASTROPHIQUE en duree (spawn de vrais process/serveurs a CHAQUE mutant).
// `npm run test:pure` l'utilise aussi (sous-ensemble rapide, parallele par defaut).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/pure.test.js',
      'tests/server-registry.test.js',
      'tests/sse-parse.test.js',
      'tests/log-rotate.test.js',
      'tests/auto-restart.test.js',
    ],
    globals: false,
  },
});
