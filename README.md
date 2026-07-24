# pw-mcp-proxy

[![CI](https://github.com/Soyouse/pw-mcp-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/Soyouse/pw-mcp-proxy/actions/workflows/ci.yml)
[![Nightly](https://github.com/Soyouse/pw-mcp-proxy/actions/workflows/nightly.yml/badge.svg)](https://github.com/Soyouse/pw-mcp-proxy/actions/workflows/nightly.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Multiplexeur MCP **transparent**, multi-profil et **multi-agent** pour [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp).
Expose **un seul** jeu d'outils (les `browser_*` du backend + `switch_profile` / `current_profile` / `restart_profile`)
et route vers le profil actif. Chaque profil = un serveur `@playwright/mcp` (version **pinnée**) **isolé**
(son propre `--user-data-dir` : cookies/session séparés).

**Zéro dépendance runtime. Zéro hardcode de tools. Zéro hardcode personnel (tout en JSON). Increvable aux updates.**

## Pourquoi

Deux comptes dans un seul profil de navigateur = re-auth permanente, session qui saute. La vraie
isolation = **un `--user-data-dir` par identité**. Ce proxy rend cette isolation utilisable depuis un
client MCP avec un seul jeu d'outils + un switch à la volée — et depuis **plusieurs agents à la fois**.

## Multi-agent (serveur HTTP partagé, ref-compté)

Un profil Chromium ne tolère qu'**un seul** process navigateur (`SingletonLock` — comportement voulu de
Chromium). Le proxy résout ça avec le transport natif de `@playwright/mcp` :

- chaque profil est servi par **un** serveur `@playwright/mcp --port` long-vivant et **partagé** ;
- chaque instance du proxy (= chaque agent MCP) en est un **client HTTP** (Streamable HTTP, spec MCP) ;
- un **superviseur** gère le cycle de vie : spawn **sérialisé par un verrou fichier dont le protocole est
  prouvé par TLA+/TLC** (exclusion mutuelle du vol de verrou périmé), serveur détaché (survit au proxy
  qui l'a lancé), heartbeats clients, **reaper dead-man** (serveur mort ou sans client → tree-kill),
  self-heal ciblé par `--user-data-dir` ;
- profil persistant partagé ⇒ `--shared-browser-context` (contrat documenté `@playwright/mcp`) : les
  agents **coexistent** sur un navigateur (1 contexte coopératif). Pour du parallélisme indépendant :
  profils `isolated` ou `userDataDir` séparés.

## Increvable & officiel (par conception)

> **Passthrough par défaut, intercept minimal.**

Le proxy ne s'appuie QUE sur des interfaces **officielles et documentées** :
- le **protocole MCP** (stdio côté client, Streamable HTTP côté backend — versionnés) ;
- les **flags CLI documentés** de `@playwright/mcp` (`--port`, `--isolated`, `--user-data-dir`, `--caps`,
  `--shared-browser-context`), fournis **par ta config** ;
- la **gestion de process de l'OS** (auto-réparation).

`router.js` aspire `tools/list` du backend **tel quel** et relaie **tout** le reste aveuglément (dans les
deux sens). Microsoft ajoute un `browser_*` ou une méthode MCP ? Ça passe **sans toucher au proxy**. Seuls
`initialize`, `tools/list`, `ping` et `tools/call {switch,current,restart}_profile` sont interceptés.
Le transport HTTP est écrit sur `node:http` (pas `fetch` : le `bodyTimeout` par défaut d'undici couperait
un flux SSE muet — contrat Streamable HTTP pendant une action longue). Un gate statique scelle ce choix.

## Résilience (0 intervention)

- **Watchdog de liveness** : tant qu'une requête est en vol, le proxy `ping` le backend (utilité MCP
  officielle). K pings sans réponse ⇒ backend déclaré figé ⇒ erreur `-32000` immédiate au client (jamais
  un appel qui pend en silence). Aucun timeout de durée : une action longue légitime (upload de 12 min)
  répond au ping et n'est jamais tuée.
- **Auto-restart** : un backend figé est recyclé automatiquement (anti-boucle déterministe + alerte
  dead-man si ça boucle ou si le respawn échoue).
- **Session morte = backend jeté, jamais ranimé** : si le serveur partagé est remplacé, les requêtes en
  vol sont rejetées immédiatement et le prochain appel reconstruit un client **frais** (session neuve) —
  reprise transparente, prouvée live.
- **Forensique de gel** : sur gel détecté, un rapport riche est logué (pid serveur, Chrome mort/figé,
  requêtes en vol + âge) — un incident n'est jamais un mystère.
- **tree-kill partout** (arrêt de backend, reaper) : le Chrome petit-enfant ne garde jamais le verrou.
- **`restart_profile{profile}`** : libération chirurgicale d'un profil bloqué (tree-kill + respawn).

> Sécurité : tout balayage cible **uniquement** les `--user-data-dir` déclarés dans ta config — jamais ton navigateur personnel.

## Garde anti-collision

Si une future version du backend exposait un outil du même nom qu'un des nôtres, le tool **backend garde son
nom** (passthrough intact) et le nôtre passe sous `proxy_<name>` + une alerte est émise. Aucun nom n'est
jamais masqué en silence.

## Installation

```bash
git clone <repo> && cd pw-mcp-proxy
cp profiles.example.json profiles.json   # puis édite tes profils (chemins absolus)
npm ci && npm test                       # optionnel : vérifie
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
  "http": true,
  "backend": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.78"] },
  "caps": [],
  "ntfyUrl": "",
  "profiles": {
    "work":     { "userDataDir": "/absolute/path/.pw-profiles/work",     "label": "Work" },
    "personal": { "userDataDir": "/absolute/path/.pw-profiles/personal", "label": "Personal" },
    "anon":     { "isolated": true, "label": "Anonyme (éphémère)" }
  }
}
```

- `http: true` = mode **multi-agent** (serveur partagé par profil). Sans lui : child stdio privé (mono-agent).
- `userDataDir` = chemin **absolu**, un par identité (cookies/session isolés). Chaque profil démarre déconnecté → login une fois, puis persiste. `isolated: true` = navigateur éphémère anonyme (exclusif de `userDataDir`).
- La version backend est **pinnée** (jamais `@latest` mouvant) : le nightly la re-valide en continu et [Renovate](./renovate.json) propose les bumps, gatés par ce même nightly.
- Ajouter un profil = un bloc de plus + save (hot-reload). Un profil peut surcharger `backend` → multiplexe **n'importe quel** serveur MCP, pas que Playwright.
- `caps` = flags `--caps` officiels de `@playwright/mcp`. `ntfyUrl` (optionnel) = topic [NTFY](https://ntfy.sh) pour les alertes (l'env `PW_MCP_NTFY_URL` prime).

## Tests & preuves

- `npm test` ([vitest](https://vitest.dev)) : logique pure + intégration via faux backends/serveurs MCP en node — déterministe, zéro navigateur.
- `npm run test:mut` : mutation [Stryker](https://stryker-mutator.io) sur les modules purs (gate `break=94`, cliquet).
- `npm run test:spec` : **preuve formelle TLA+/TLC** du verrou fichier du superviseur (Buggy DOIT violer, Fixed DOIT prouver).
- `npm run coupling` : gates anti-couplage (jscpd + dependency-cruiser).
- `PW_MCP_LIVE=1 npx vitest run tests/contract-live.test.js` : drift-test **contre le vrai `@playwright/mcp`**
  (multi-agent réel, ping, mort de Chrome, serveur tué sous un manager vivant → reprise transparente).
  Exécuté chaque nuit par la CI ([nightly](./.github/workflows/nightly.yml)).
- CI = matrice **ubuntu + windows + macos** + gates mutation/spec/couplage.

## Architecture (`src/`)

| Fichier | Rôle |
|---|---|
| `index.js` | Entry. Boot supervision (reap + reaper) → sert. stdin → Router → backends → stdout (JSON-RPC pur). |
| `router.js` | Passthrough par défaut ; intercept switch/current/restart_profile ; garde anti-collision. |
| `manager.js` | Config + pool de backends + profil actif + hot-reload + auto-restart + rapport de gel. |
| `backend.js` | Logique protocolaire (handshake, mapping d'ids, forward bidir) + watchdog ping. Agnostique au transport. |
| `stdio-transport.js` | Transport child stdio (ndjson, tree-kill à l'arrêt). |
| `http-transport.js` | Client Streamable HTTP MCP sur `node:http` (POST+SSE, session, GET serveur→client, DELETE). |
| `supervisor.js` | Cycle de vie des serveurs partagés : spawn verrouillé, heartbeats, reaper, self-heal. |
| `server-registry.js` | *(pur)* décisions du superviseur : port de rendez-vous, ref-count, reap convergent. |
| `sse-parse.js` | *(pur)* framing SSE incrémental (invariant de chunking property-testé). |
| `spawn-cmd.js` | *(pur)* résolution spawn cross-OS (source unique stdio + superviseur). |
| `collision.js` | *(pur)* détection/résolution des collisions de noms de tools. |
| `spec.js` | *(pur)* construction des args backend depuis la config. |
| `auto-restart.js` | *(pur)* garde anti-boucle du restart automatique. |
| `freeze-report.js` | *(pur)* rapport forensique de gel. |
| `prockill.js` / `prockill-pure.js` | kill d'arbre de process + balayage par `user-data-dir` (I/O + décision pure). |
| `log-rotate.js` / `logger.js` | rotation bornée *(pure)* + logs → stderr/fichier. **Jamais stdout.** |
| `jsonrpc.js` / `notify.js` | framing ndjson · alerte best-effort (log + NTFY optionnel). |

## Licence

MIT.
