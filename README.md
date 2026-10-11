# jira-mcp

Serveur MCP (stdio) générique pour **Jira Software Server / Data Center 8.x** (REST API v2).

> Les valeurs d'exemple de ce document sont **fictives** : `https://jira.example.com`, projet `DEMO`, utilisateur `jdoe`, secret `JIRA_READONLY_PAT`. Remplacez-les par les vôtres, sans jamais les versionner si elles sont sensibles.

## Portée

- Environ 25 outils dédiés : recherche JQL, tickets, transitions, commentaires, worklogs, liens, pièces jointes, tableaux et sprints.
- Les opérations **décrites dans les WADL de votre instance** pour **REST API v2**, **Agile 1.0** et **Xray** (si installé, et **désactivé par défaut** : voir `JIRA_ENABLE_XRAY`), via `jira_list_operations` → `jira_describe_operation` → `jira_call_read_operation` / `jira_call_write_operation`.

**Non couvert :**

- Jira Service Management ;
- les API REST des autres plugins ;
- les API annexes de Jira (`/rest/greenhopper`, `/rest/auth`, `/rest/pat`, `/rest/dev-status`, `/rest/plugins`, `/rest/applinks`).

**Limites des WADL :**

- pas de schéma de corps, et rien qui dise si un corps est requis ;
- paramètres requis rarement déclarés ;
- **aucune information sur les effets de bord** ;
- inventaire figé à la date du téléchargement.

## Prérequis

- **Node.js** 24.11 ou plus récent.
- **Réseau.** La machine qui exécute le serveur doit joindre l'instance Jira en HTTPS.
- **PAT.** Créez-le avec un compte dont les **permissions Jira sont minimales** pour l'usage visé : en lecture, un compte sans droit d'écriture.
- **Autorité de certification privée.** Si l'instance utilise une autorité privée, rendez-la visible de Node, de l'une de ces deux façons :
  - installez-la dans le magasin de certificats du système, puis lancez Node avec `--use-system-ca` (les scripts npm le font déjà) ;
  - ou définissez `NODE_EXTRA_CA_CERTS=<chemin du fichier PEM>`.

  Ne désactivez jamais la vérification TLS.

## Sécurité

- **Lecture seule par défaut.** `JIRA_ALLOW_WRITES=true` active les outils d'écriture (dont `jira_add_attachment`) et `jira_call_write_operation`.
- **Classe d'accès.** Chaque opération du catalogue a une classe : `read`, `write` ou `destructive`.
  - Elle vient d'une règle par défaut, selon la méthode HTTP, ou d'une **décision de revue signée**, consignée dans `catalog/access-decisions.json`.
  - Des heuristiques de chemin désignent les opérations à revoir : GET dont le nom évoque un effet de bord, POST dont le nom évoque une lecture, POST/PUT/PATCH dont le nom évoque une suppression.
  - **Ces heuristiques ne détectent rien** : chaque candidat est décidé par une personne, et `npm run catalog:check` bloque tant qu'un candidat n'est pas décidé.
- **Risque résiduel sur les GET.**
  - Les GET qui ne sont pas des candidats restent `read` sans revue individuelle ; leur `accessReason` le signale (`not individually reviewed`).
  - Un GET à effet de bord dont le nom paraît anodin ne serait donc pas signalé.
  - Ce risque est accepté explicitement à chaque livraison, dans une note de `docs/delivery/`.
  - **La barrière effective reste les permissions Jira du PAT utilisé.**
- **Annotations MCP.** Ce sont des **indications** pour le client MCP, par exemple pour qu'il demande une confirmation ; elles ne protègent rien.
  - Les outils dédiés ont des annotations précises.
  - `jira_call_write_operation` est annoté `destructiveHint: true` **par choix conservateur**, même pour une modification courante, car il peut aussi appeler des suppressions.
- **Reprises.** Seules les lectures sont réessayées : sur 429, 502, 503, 504 ou erreur réseau, avec 2 reprises au maximum. Une écriture n'est jamais rejouée.
- **Annulation.** Si le client MCP annule un appel, la requête Jira en cours est interrompue et n'est pas réessayée. Une écriture déjà reçue par Jira a pu être appliquée : vérifiez son état avant de la relancer.
- **Transport.**
  - **HTTPS est exigé par défaut.**
  - Une URL `http://` n'est acceptée qu'avec `JIRA_ALLOW_INSECURE_HTTP=true`, pour des tests locaux exceptionnels. Le serveur affiche alors un avertissement au démarrage, car le PAT circule en clair.
  - Les redirections sont refusées.
- **Taille.**
  - Au-delà de `JIRA_MAX_RESPONSE_BYTES`, la lecture est interrompue et une erreur est renvoyée.
  - La sortie destinée au modèle est limitée à `JIRA_MAX_OUTPUT_CHARS`, avec la mention « output truncated ».
- **Secrets et inventaire.**
  - Le PAT n'est jamais journalisé ni versionné (`npm run secrets:scan`).
  - L'URL de l'instance n'est pas journalisée au démarrage.
  - L'inventaire des endpoints (WADL, `catalog/catalog.json`, rapports) **n'est pas versionné**.

## Configuration

| Variable                   | Requis | Défaut                 | Rôle                                                                                                |
| -------------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`            | oui    | —                      | URL de l'instance, par exemple `https://jira.example.com` (valeur fictive). HTTPS exigé par défaut. |
| `JIRA_PAT`                 | oui    | —                      | Personal Access Token (Bearer)                                                                      |
| `JIRA_ALLOW_WRITES`        | non    | `false`                | active les écritures                                                                                |
| `JIRA_ALLOW_INSECURE_HTTP` | non    | `false`                | accepte `http://` pour des tests locaux exceptionnels (avertissement au démarrage)                  |
| `JIRA_TIMEOUT_MS`          | non    | `30000`                | délai par requête                                                                                   |
| `JIRA_MAX_RESPONSE_BYTES`  | non    | `5242880`              | taille maximale d'une réponse HTTP                                                                  |
| `JIRA_MAX_OUTPUT_CHARS`    | non    | `100000`               | taille maximale du texte rendu au modèle                                                            |
| `JIRA_CATALOG_PATH`        | non    | `catalog/catalog.json` | emplacement du catalogue                                                                            |
| `JIRA_ENABLE_XRAY`         | non    | `false`                | expose les opérations Xray du catalogue                                                             |

`JIRA_ENABLE_XRAY` agit seulement sur le serveur. Le catalogue reste généré et revu avec les opérations Xray si le plugin est installé : on peut donc activer Xray plus tard sans régénérer le catalogue. Si l'option est activée mais que le catalogue ne contient aucune opération Xray, le serveur affiche un avertissement au démarrage.

Une URL de base avec chemin de contexte est prise en charge, par exemple `https://jira.example.com/jira` (valeur fictive) : les chemins du catalogue restent en `/rest/...`.

## Installation

Le catalogue des opérations (`catalog/catalog.json`) est propre à chaque instance et **n'est pas dans git**. Deux façons de l'obtenir :

1. **Artefact du workflow GitHub Actions** (si le dépôt le publie, voir « CI ») :
   1. Téléchargez l'artefact `jira-mcp-package` depuis l'exécution du workflow, ou avec `gh run download <run-id> -n jira-mcp-package`. Il contient `jira-mcp-<version>.tgz`.
   2. Décompressez le paquet, puis installez ses dépendances de production :
      ```bash
      tar -xzf jira-mcp-<version>.tgz        # crée le dossier package/
      cd package
      npm install --omit=dev
      ```
   3. Le serveur se lance avec `node --use-system-ca dist/index.js`.

   On utilise `npm install` et non `npm ci`, parce qu'un paquet produit par `npm pack` ne contient pas `package-lock.json`. Les dépendances directes sont figées par version exacte dans `package.json`. Les dépendances transitives sont résolues au moment de l'installation : refaites `npm audit --omit=dev` après l'installation.

2. **Depuis les sources** (PAT requis, lecture seule) :
   ```bash
   npm ci
   export JIRA_BASE_URL=https://jira.example.com   # exemple fictif : URL de votre instance
   read -rs JIRA_PAT && export JIRA_PAT
   npm run catalog:fetch && npm run catalog:build && npm run catalog:check
   npm run build
   ```
   `catalog:check` échoue si l'instance ne correspond plus au verrou versionné (`catalog/source-lock.json`). Dans ce cas, voir « Catalogue et revue ».

Sans catalogue, le serveur s'arrête au démarrage avec un message qui indique ces commandes.

## Utilisation avec Claude Code

1. Copiez `.mcp.json.example` en `.mcp.json` (ce fichier est ignoré par git).
2. Adaptez le chemin et l'URL.
3. Définissez `JIRA_PAT` dans votre environnement.

## CI (GitHub Actions)

Le workflow `.github/workflows/ci.yml` comprend deux jobs :

- **`static`** : format, lint, types, tests, couverture et recherche de secrets, sur un runner GitHub-hosted, sans secret.
- **`catalog-and-package`** : récupération des WADL, génération et vérification du catalogue, build, test de fumée en lecture seule, création et conservation du paquet.

**À configurer dans le dépôt** (_Settings › Secrets and variables › Actions_). Tous les noms sont des exemples, à adapter :

| Type     | Nom                 | Contenu                                                                            |
| -------- | ------------------- | ---------------------------------------------------------------------------------- |
| Secret   | `JIRA_READONLY_PAT` | PAT d'un compte Jira sans droit d'écriture                                         |
| Secret   | `JIRA_BASE_URL`     | URL de l'instance (un secret, pour être masquée dans les journaux)                 |
| Variable | `JIRA_CI_ENABLED`   | `true` pour activer le job Jira                                                    |
| Variable | `SMOKE_PROJECT`     | clé d'un projet lisible par ce compte                                              |
| Variable | `JIRA_RUNNER_LABEL` | label du runner du job Jira (par défaut `ubuntu-latest`)                           |
| Variable | `PUBLISH_ARTIFACT`  | `true` pour conserver le paquet comme artefact (dépôt privé ou interne uniquement) |

**Runner self-hosted.** Il est nécessaire dans deux cas :

- l'instance n'est pas joignable depuis Internet ;
- elle utilise une autorité de certification privée.

Placez alors le runner dans un réseau qui atteint l'instance, installez l'autorité dans son magasin système, et indiquez son label dans `JIRA_RUNNER_LABEL`.

Si `JIRA_CI_ENABLED` ne vaut pas `true`, le job Jira est ignoré.

## Catalogue et revue

| Commande                                 | Effet                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run catalog:fetch`                  | télécharge les WADL et `serverInfo` (PAT, lecture seule)                     |
| `npm run catalog:build`                  | génère `catalog/catalog.json`, `catalog/last-diff.md` et `catalog/review.md` |
| `npm run catalog:build -- --update-lock` | réécrit `catalog/source-lock.json` (refusé si une revue est en attente)      |
| `npm run catalog:check`                  | contrôle bloquant : verrou, cohérence, décisions, revue                      |
| `npm run catalog:drift`                  | compare l'instance au verrou (code de sortie 2 si dérive)                    |

**Après une mise à jour de Jira ou d'un plugin :**

1. `catalog:drift` ;
2. `catalog:fetch`, puis `catalog:build` ;
3. décider chaque candidat listé dans `catalog/review.md`, dans `catalog/access-decisions.json` (raison, relecteur, date) ;
4. `catalog:build -- --update-lock`, puis `npm run verify` ;
5. pull request relue par une seconde personne.

## Développement

| Commande                        | Effet                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `npm test` / `npm run coverage` | tests unitaires (sans Jira, sans catalogue généré)                                   |
| `npm run check`                 | format, lint, types, couverture, recherche de secrets                                |
| `npm run verify`                | `check` + `catalog:check`                                                            |
| `npm run smoke`                 | test de fumée réel en lecture seule (après `npm run build` ; `SMOKE_PROJECT` requis) |

**Règle d'or :** stdout est le canal MCP. N'utilisez jamais `console.log` (oxlint le refuse).

## Notes Jira Server / Data Center

- **API v2.** Textes en wiki markup (pas ADF), utilisateurs identifiés par `name`.
- **Champs personnalisés.** Leurs identifiants (`customfield_NNNNN`) varient d'une instance à l'autre : retrouvez-les avec `jira_list_fields` (par exemple `query: "sprint"`).
- **`editmeta` vide.** Si `editmeta` est vide pour un ticket, la modification passe par une transition : `jira_get_transitions` avec `includeFields: true`, puis `jira_transition_issue`.
