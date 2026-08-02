// Fixture POSIX — cree une VRAIE socket orpheline : on ecoute, on annonce, puis le process
// se fait TUER (SIGKILL) sans jamais appeler close(). Le fichier socket survit sur disque.
//
// ⚠️ Un `server.close()` NE CONVIENT PAS pour fabriquer une orpheline : Node supprime le fichier
//    au close (mesure CI 2026-08-02 — c'est ce qui a fait rougir ubuntu/macOS sur un test FAUX).
//    Seule la mort brutale du processus laisse le fichier derriere elle : c'est exactement le
//    scenario reel qu'on doit couvrir (crash du proxy pendant qu'il tient le canal).
// ⚠️ Argv parse par `find`, jamais positionnel : le harnais injecte un token de suite en plus.

import net from 'node:net';
import process from 'node:process';

const arg = process.argv.find((a) => a.startsWith('--sock='));
if (!arg) {
  process.stderr.write('orphan-socket: --sock=<chemin> manquant\n');
  process.exit(2);
}

const server = net.createServer();
server.on('error', (e) => {
  process.stderr.write(`orphan-socket: ${e.code || e.message}\n`);
  process.exit(3);
});
server.listen(arg.slice('--sock='.length), () => {
  process.stdout.write('READY\n'); // le test attend ce signal AVANT de tuer (zero course)
});
