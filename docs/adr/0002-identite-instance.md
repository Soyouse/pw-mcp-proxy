# ADR 0002 — Une INSTANCE par client, l'IDENTITÉ en snapshot (2026-09-05)

**Statut** : accepté, implémenté, mesuré sur le vrai binaire (`contract-live`, `@playwright/mcp@0.0.80`).
**Remplace** la partie « serveur HTTP partagé par profil, N clients » de l'ADR 0001.

## Contexte

Le proxy servait UN serveur `@playwright/mcp` par profil, partagé par N clients grâce à
`--shared-browser-context`. Le 03/09/2026, quatre sous-agents lancés en parallèle se sont volé les
onglets ; deux agents sur deux profils « isolés » se fermaient mutuellement le navigateur. La cause
n'était pas diagnostiquée ; la règle de repli était « un seul agent navigateur à la fois ».

Le 04/09, mesure sur le vrai binaire, deux clients HTTP sur UN serveur :

| Mode | Pages | Cookies |
|---|---|---|
| `--isolated` | indépendantes | séparés |
| `--user-data-dir` + `--shared-browser-context` (= profils réels) | **B écrase la page de A** | partagés |
| `--user-data-dir` seul, 2 clients | « Browser is already in use » | — |

Le partage n'était donc pas un mode coopératif : c'était la collision. Et l'issue upstream demandant
un `sessionId` par client (microsoft/playwright #40585, mai 2026) est fermée sans réponse.

## Décision

1. **Une socket = une instance.** Le daemon reste unique (vue globale, parent de tout, refcount
   tenu par le noyau), mais il ne partage plus rien : chaque client obtient son serveur, son Chrome,
   son dossier jetable. Deux clients de la même identité = deux instances (le daemon AVERTIT — les
   sites peuvent déconnecter l'une des deux, Browserbase le documente —, il n'interdit pas).
2. **Identité = snapshot du `user-data-dir` sans caches**, dans un coffre plafonné (par identité,
   total, rétention — défauts Steel : 300 Mo, 30 j). C'est l'unité de Browserbase (« Contexts »),
   Steel (« Profiles »), Kernel. Un fichier de cookies (`storage-state`) ne suffit pas : Google lie
   ses sessions à l'appareil (DBSC, Chrome 146+, tous comptes, non désactivable) — mesuré le 05/09 :
   cookies seuls MORTS à 10 min, snapshot du dossier CONNECTÉ à 40 min. Une identité Google est
   donc épinglée à la machine qui l'a fait naître.
3. **`--isolated` n'est pas le mode du parallélisme.** Il donne N contextes dans un Chrome (moins
   cher), mais `detectincognitojs@1.9.0` le voit comme navigation privée (timing d'écritures
   IndexedDB `durability:'strict'` — propriété physique d'un stockage en mémoire, aucun flag ne la
   maquille) ; un profil persistant est vu « normal ». Sentinelle permanente dans `contract-live`.
4. **Rangement = kill → `exit` du gardien (noyau) → attendre que le dossier se laisse renommer
   (Chrome est un petit-enfant : sa fin n'est notifiée par personne et ses fichiers restent
   verrouillés sous Windows) → snapshot retour atomique (rename) → rm.** Un rangement en vol retient
   le daemon (mesuré : sans ça, `process.exit` au milieu d'une copie).
5. **Loopback Windows** : libuv ne retransmet pas les SYN vers 127.x (mesuré : `connect ETIMEDOUT`
   par fenêtres pendant un lancement de Chrome). Réponse : keep-alive + rejeu d'un `connect` échoué au
   calendrier du noyau (1 s, 2 s). `bindHost` hors loopback est une option gardée mais mesurée
   (+2 s par connexion sur carte virtuelle), pas le défaut. `--allowed-hosts` : jamais (la couche MCP
   compare `Host` entier, son défaut est déjà juste — 8/8 rouges avec le flag).

## Options écartées

- **Garder le contexte partagé** — c'est la collision mesurée.
- **Pool de contextes chauds prêtant des onglets** — pas d'onglet par client en contexte partagé, même
  en 0.0.80 (mesuré).
- **`--isolated` + `storage-state`** — détecté privé, et les cookies seuls meurent (DBSC).
- **Fermes communautaires (`playwright-parallel-mcp`…)** — réimplémentent ce que le daemon fait.

## Conséquences

- Coût : un Chrome par agent (~0,5 Go RAM) ⇒ ~10-15 agents par poste, puis des nœuds. La seule limite
  est le matériel branché — c'est la cible.
- `PW_MCP_PROFILE` épingle un proxy sur un profil ; N entrées MCP = N agents parallèles.
- Contrat S2/S3 du skill réécrit ; `--shared-browser-context` interdit par gate AST.
- Mesure de clôture : BACKLOG § SWARM §10.
