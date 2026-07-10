# pw-mcp-proxy

Multiplexeur MCP **transparent** multi-profil pour [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp).
Expose **un seul** jeu d'outils (les `browser_*` du backend + `switch_profile` / `current_profile` / `restart_profile`)
et route vers le profil actif. Chaque profil = un serveur `@playwright/mcp@latest` **isolé** (son propre
`--user-data-dir` : cookies/session séparés).

**Zéro dépendance runtime. Zéro hardcode de tools. Zéro hardcode personnel (tout en JSON). Increvable aux updates.**

## Pourquoi

Deux comptes dans un seul profil de navigateur = re-auth permanente, session qui saute. La vraie
isolation = **un `--user-data-dir` par identité**. Ce proxy rend cette isolation utilisable depuis un
client MCP avec un seul jeu d'outils + un switch à la volée.

## Increvable & officiel (par conception)

> **Passthrough par défaut, intercept minimal.**

Le proxy ne s'appuie QUE sur des interfaces **officielles et documentées** :
- le **protocole MCP** (stdio, versionné) — il parle MCP au backend, jamais l'interne de Playwright ;
- les **flags CLI documentés** de `@playwright/mcp` (`--user-data-dir`, `--caps`), fournis **par ta config** ;
- la **gestion de process de l'OS** (pour l'auto-réparation, cf. plus bas).

`router.js` aspire `tools/list` du backend **tel quel** et relaie **tout** le reste aveuglément (dans les
deux sens). Microsoft ajoute un `browser_*` ou une méthode MCP ? Ça passe **sans toucher au proxy**. Seuls
`initialize`, `tools/list`, `ping` et `tools/call {switch,current,restart}_profile` sont interceptés.

## Auto-réparation (0 intervention)

Un profil Chromium ne tolère qu'**un seul** process à la fois (`SingletonLock` — comportement voulu de
Chromium, pas un bug). Le proxy s'auto-protège contre les process fantômes :
- **tree-kill** à l'arrêt d'un backend (tue l'arbre, y compris le Chrome petit-enfant — sinon il garde le verrou) ;
- **boot-sweep** au démarrage : tue tout process orphelin tenant un de *tes* `--user-data-dir`, avant de servir ;
- **lock single-instance coopératif** : un proxy neuf fait abdiquer proprement les anciens (zéro zombie) ;
- **`restart_profile{profile}`** : outil pour libérer un profil bloqué à la demande (tree-kill + respawn chirurgical).

> Sécurité : le balayage cible **uniquement** les `--user-data-dir` déclarés dans ta config — jamais ton navigateur personnel.

## Garde anti-collision

Si une future version du backend exposait un outil du même nom qu'un des nôtres, le tool **backend garde son
nom** (passthrough intact) et le nôtre passe sous `proxy_<name>` + une alerte est émise. Aucun nom n'est
jamais masqué en silence.

## Installation

```bash
git clone <repo> && cd pw-mcp-proxy
cp profiles.example.json profiles.json   # puis édite tes profils (chemins absolus)
npm test                                 # optionnel : vérifie
```

Déclare-le dans le `~/.mcp.json` de ton client MCP :
```json
"browser": { "type": "stdio", "command": "node", "args": ["/absolute/path/to/pw-mcp-proxy/src/index.js"] }
```

## Config — `profiles.json` (hot-reload par mtime, aucun restart)

Copie de `profiles.example.json`. **Rien n'est hardcodé** : tout vient d'ici.

```json
{
  "defaultProfile": "work",
  "backend": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
  "caps": [],
  "ntfyUrl": "",
  "profiles": {
    "work":     { "userDataDir": "/absolute/path/.pw-profiles/work",     "label": "Work" },
    "personal": { "userDataDir": "/absolute/path/.pw-profiles/personal", "label": "Personal" }
  }
}
```

- `userDataDir` = chemin **absolu**, un par identité (cookies/session isolés). Chaque profil démarre déconnecté → login une fois, puis persiste.
- Ajouter un profil = un bloc de plus + save (hot-reload). Un profil peut surcharger `backend` → multiplexe **n'importe quel** serveur MCP, pas que Playwright.
- `caps` = flags `--caps` officiels de `@playwright/mcp` (ex. `["storage"]` pour les outils cookie/localStorage).
- `ntfyUrl` (optionnel) = ton propre topic [NTFY](https://ntfy.sh) pour les alertes (vide = désactivé ; l'env `PW_MCP_NTFY_URL` prime).

## Tests

- `npm test` (`node --test`, 61 tests) : intégration via **faux backends MCP en node** + logique pure.
- `npm run test:mut` : mutation [Stryker](https://stryker-mutator.io) sur les modules purs (gate `break=94`).
- CI = matrice **ubuntu + windows** (preuve cross-OS) + gate mutation.
- ⚠️ Les tests ne spawnent **jamais** un vrai navigateur (déterministes, zéro réseau).

## Architecture (`src/`)

| Fichier | Rôle |
|---|---|
| `index.js` | Entry. boot-sweep → lock → sert. stdin → Router → backends → stdout (JSON-RPC pur). |
| `jsonrpc.js` | Framing ndjson (1 ligne = 1 message). |
| `backend.js` | Un serveur MCP enfant isolé. Handshake, forwarding bidirectionnel, respawn, tree-kill à l'arrêt. |
| `manager.js` | Config + pool de backends + profil actif + hot-reload + `restartProfile`. |
| `router.js` | Passthrough par défaut ; intercept switch/current/restart_profile ; garde anti-collision. |
| `collision.js` | *(pur)* détection/résolution des collisions de noms de tools. |
| `spec.js` | *(pur)* construction des args backend depuis la config. |
| `prockill.js` / `prockill-pure.js` | kill d'arbre de process + balayage par `user-data-dir` (I/O + décision pure). |
| `lock.js` | lock single-instance coopératif (abdication des anciens proxys). |
| `notify.js` | alerte best-effort (log + NTFY optionnel), zéro dépendance. |
| `logger.js` | Logs → stderr/fichier. **Jamais stdout.** |

## Licence

MIT.
