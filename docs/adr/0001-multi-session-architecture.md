# ADR 0001 — Architecture multi-session (profil persistant partagé)

- **Statut** : PROPOSÉ — en attente d'audit externe avant implémentation.
- **Date** : 2026-07-11
- **Contexte d'usage** : plusieurs sessions du client MCP tournent en parallèle (cas normal, prévisible), toutes veulent piloter le même navigateur à profil persistant (login conservé).

---

## 1. Problème

Chaque session MCP spawn actuellement son propre proxy → son propre backend `@playwright/mcp` → **tous ouvrent le même `--user-data-dir`**. Or Chromium n'autorise **qu'un seul process par dossier de profil** (`SingletonLock`, comportement voulu, pas un bug — confirmé doc officielle `@playwright/mcp` : « a persistent profile can only be used by one browser instance at a time »).

Le design actuel résout la collision par un lock coopératif « le plus récent gagne, les autres abdiquent » + boot-sweep. Conséquence en multi-session réel : **la session neuve tue le navigateur vivant d'une session sœur** → erreur d'`initialize` affichée (rouge) chez la session frappée. Symptôme observé 2026-07-11.

## 2. Contraintes dures (non négociables)

0. **JAMAIS modifier `@playwright/mcp`/Playwright.** On reste un **simple proxy**. Le daemon EST `@playwright/mcp` **nu** (aucun fork/patch/interne touché), invoqué uniquement via **flags CLI officiels documentés**. Le proxy ne dépend que de DEUX surfaces publiques : le **protocole MCP** (versionné) + les **flags CLI documentés**. Passthrough aveugle conservé (`tools/list` aspiré tel quel, tout relayé). → **Toute update Microsoft qui préserve ces surfaces publiques ne casse PAS le proxy.** C'est LA raison d'être du projet, prioritaire sur toute autre considération d'archi.
1. **Login Google partagé DOIT persister** entre sessions → profil persistant obligatoire, pas de contexte isolé jetable.
2. **Anti-détection intacte** : aucun flag de lancement navigateur ajouté/retiré. L'anti-détection actuelle = `channel: chrome` (vrai Chrome) + profil réel avec vrai login. `navigator.webdriver=true` est déjà présent (spec W3C) ; on ne dégrade pas, on n'ajoute pas `--no-sandbox`/`--enable-automation`.
3. **0-human** : zéro friction, zéro intervention manuelle en régime permanent.
4. **Multi-session TOUJOURS** : N sessions concurrentes, tout le temps, sans casse.
5. **Zéro régression** : le leak P0 (orphelins Chrome) et le kill-du-frère NE reviennent PAS.

## 3. Options considérées

| # | Option | Verdict |
|---|--------|---------|
| A | **Statu quo** (« le plus récent gagne ») | ❌ Tue les sessions sœurs vivantes. |
| B | **Propriété coopérative par profil** (premier détenteur garde, 2ᵉ session reçoit « occupé ») | 🟡 Zéro collision, zéro régression, mais **une seule session pilote un profil à la fois**. Simple, sûr, limité. |
| C | **Daemon persistant par profil + pont stdio↔HTTP par session** (`--port` + `--shared-browser-context`) | ✅ **Recommandé.** Officiel Microsoft, dissout SingletonLock + leak + kill-frère par construction. |
| D | **Contexte isolé par session** (`concurrent-playwright-mcp`) | ❌ Chaque session = cookies isolés → **perd le login Google**. Disqualifié par contrainte #1. |

## 4. Décision recommandée : Option C

### Principe
- **Un daemon `@playwright/mcp` long-vivant PAR profil** (un pour `work`, un pour `personal`), lancé en transport HTTP (`--port`, bind **127.0.0.1 uniquement**) avec `--user-data-dir` du profil + `--shared-browser-context`.
- **Seul le daemon ouvre le profil** → un seul process Chromium par profil → SingletonLock jamais en conflit.
- **Notre proxy (`src/index.js`) devient un pont léger stdio↔HTTP par session** : parle MCP stdio au client (Claude), MCP Streamable HTTP au daemon. Les 3 outils maison (`switch/current/restart_profile`) et le passthrough restent identiques côté client.
- **Cycle de vie du daemon** : démarré à la demande (1ʳᵉ session qui demande le profil), gardé vivant entre sessions (le login persiste), supervisé (respawn sur crash), arrêté sur idle long configurable.

### Pourquoi C dissout les anciens bugs (réponse à la crainte de régression)
Le leak P0 venait de *proxys-par-session qui spawnent Chrome puis sont abandonnés*. En C, **aucune session ne spawne Chrome** — seul le daemon le fait, une fois, supervisé. Une session qui meurt = un pont stdio qui meurt (EOF), le daemon continue (voulu). **Il n'y a plus rien à abandonner.** Le leak n'est pas « re-corrigé », il est **hors de l'espace d'états**.

### Pourquoi `switch_profile` cesse d'être dangereux
Un daemon PAR profil → `switch_profile` = le pont se branche sur un autre daemon. Aucune session n'arrache le contexte d'une autre (contrairement à un daemon unique qui commuterait de profil).

## 5. Anti-détection — analyse (contrainte #2)

- Les flags ajoutés (`--port`, `--host 127.0.0.1`, `--shared-browser-context`) sont **transport/session**, PAS des flags Blink/navigateur → **fingerprint inchangé**.
- `--user-data-dir`, `channel`, `caps` : repris **verbatim** de `profiles.json`, identiques à aujourd'hui.
- **Interdits explicites** : `--no-sandbox` (artefact Docker, révélateur), `--enable-automation`, `--headless` sur les profils réels. `--disable-blink-features=AutomationControlled` reste un choix **config** (absent aujourd'hui) — l'archi ne le pose pas d'office.
- Le partage de contexte n'expose aucune surface réseau supplémentaire à la cible : le navigateur émet exactement les mêmes requêtes.

## 6. Frictions possibles (0-human) + mitigation

| # | Friction | Mitigation |
|---|----------|-----------|
| F1 | Daemon pas démarré (1ʳᵉ session) | Pont démarre le daemon à la demande + attend `/health` prêt (timeout borné, retry). |
| F2 | Daemon crash → tous les ponts orphelins | Supervision : respawn ; ponts re-tentent la connexion HTTP (backoff). |
| F3 | Port déjà pris | Port dérivé du profil + sonde ; si occupé par un daemon À NOUS (handshake version OK) → réutiliser ; sinon échec bruyant. |
| F4 | Daemon en vieux code après update | **Handshake de version** pont↔daemon ; mismatch → daemon invité à s'arrêter, pont en relance un neuf. |
| F5 | `switch_profile` pendant qu'une sœur bosse | Daemon par profil → aucun arrachement (cf §4). |
| F6 | Google détecte l'automation, coupe la session | Pré-existant, orthogonal à l'archi. Daemon persistant = login vit plus longtemps → re-auth PLUS rare. Re-login = manuel (documenté). |
| F7 | Deux agents agissent sur le même onglet | Convention : un onglet par session (via `browser_tabs`) ; verrou consultatif « onglet occupé » best-effort. **Collision toujours VISIBLE, jamais silencieuse.** |
| F8 | Daemon idle qui traîne (RAM) | Idle-timeout configurable (défaut généreux pour préserver le login) ; arrêt propre tree-kill. |
| F9 | Le pont meurt sans fermer proprement | Daemon insensible (il ne dépend pas d'un pont) ; pont = process trivial, pas de Chrome à fuir. |
| F10 | Sécurité transport local | Bind **127.0.0.1** strict, jamais `0.0.0.0`. Optionnel : token d'en-tête local. |
| F11 | Drift protocole pont↔daemon aux updates | Les deux parlent MCP standard → passthrough increvable, même philosophie qu'aujourd'hui. |
| F12 | Spécificités Windows (daemon détaché survivant à la session) | Daemon spawné `detached`, découplé du process parent ; NE PAS tree-kill le daemon à la fin d'une session (seulement à l'idle-timeout / arrêt explicite). |

## 7. Contrat anti-régression (la garantie)

Implémentation conditionnée à **DEUX invariants testés ENSEMBLE**, verts simultanément avant merge :

1. **Anti-leak (conservé)** : un détenteur de profil dont le client est mort → nettoyé ; zéro orphelin Chrome. *(le test de repro du leak reste VERT)*.
2. **Survie de la sœur (nouveau)** : une session B qui rejoint pendant que A pilote → **A n'est jamais tuée**, B multiplexe (ou reçoit « occupé » propre en option B). *(nouveau test)*.

Si un jour l'un casse l'autre → **ROUGE au push**. On ne troque jamais un bug contre l'autre en silence.

Modules purs conservés sous Stryker (`break=94`, cliquet). Nouveau code de décision (choix daemon existant vs neuf, parsing santé, version-match) **isolé hors I/O** → testable/mutable ; l'I/O (spawn daemon, HTTP) = tests live/intégration.

## 8. Questions ouvertes pour l'auditeur

1. **C vs B** : le daemon+pont (C) vaut-il sa complexité, ou la propriété coopérative simple (B, une session à la fois par profil) suffit-elle au besoin réel (piloter rarement 2 agents SIMULTANÉMENT sur le même compte) ?
2. `--shared-browser-context` : le partage d'onglets entre sessions est-il un risque sémantique acceptable, ou faut-il une discipline d'onglet-par-session dans le pont ?
3. Cycle de vie daemon : idle-timeout vs keep-alive permanent — quel défaut pour 0-human sans gaspiller la RAM ?
4. Supervision : superviseur maison minimal vs dépendance adoptée — la contrainte « zéro dépendance runtime » tient-elle encore avec un daemon ?

## Sources

- Playwright MCP — options (`--shared-browser-context`, `--isolated`, `--port`, `--host`) : https://playwright.dev/mcp/configuration/options
- microsoft/playwright-mcp (README, transport HTTP) : https://github.com/microsoft/playwright-mcp
- Issue #1530 — named session management (persistent context save/restore) : https://github.com/microsoft/playwright-mcp/issues/1530
- concurrent-playwright-mcp (contextes isolés par session) : https://glama.ai/mcp/servers/dgutierrez1/concurrent-playwright-mcp
- Chromium — User Data Directory / SingletonLock : https://www.chromium.org/user-experience/user-data-directory/
- Playwright — Browser contexts / persistent context : https://playwright.dev/docs/browser-contexts
- Anti-détection 2026 (`--disable-blink-features=AutomationControlled`, `navigator.webdriver`) : https://alterlab.io/blog/playwright-bot-detection-what-actually-works-in-2026
