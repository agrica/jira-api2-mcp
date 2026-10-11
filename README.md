# jira-mcp

Serveur MCP (stdio) générique pour **Jira Software Server / Data Center 8.x** (REST API v2).

> Les valeurs d'exemple de ce document sont **fictives** : `https://jira.example.com`, projet `DEMO`, ticket `DEMO-123`, utilisateur `jdoe`, champ `customfield_10001`, secret `JIRA_READONLY_PAT`. Remplacez-les par les vôtres, sans jamais les versionner si elles sont sensibles.

## Sommaire

- [Portée](#portée)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Configuration](#configuration)
- [Brancher le serveur sur un client MCP](#brancher-le-serveur-sur-un-client-mcp)
- [Outils MCP](#outils-mcp)
- [Sécurité](#sécurité)
- [Catalogue et revue](#catalogue-et-revue)
- [CI (GitHub Actions)](#ci-github-actions)
- [Développement](#développement)
- [Dépannage](#dépannage)
- [Notes Jira Server / Data Center](#notes-jira-server--data-center)

## Portée

- **31 outils** au total : 27 outils dédiés (recherche JQL, tickets, transitions, commentaires, worklogs, liens, pièces jointes, tableaux, sprints, métadonnées) et 4 outils génériques.
- Les outils génériques donnent accès aux opérations **décrites dans les WADL de votre instance** pour **REST API v2**, **Agile 1.0** et **Xray** (si le plugin est installé, et **désactivé par défaut** : voir `JIRA_ENABLE_XRAY`), via `jira_list_operations` → `jira_describe_operation` → `jira_call_read_operation` / `jira_call_write_operation`.
- **Lecture seule par défaut** : les 11 outils d'écriture (10 dédiés et `jira_call_write_operation`) n'existent que si `JIRA_ALLOW_WRITES=true`.

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

- **Node.js** 24.11 ou plus récent (`node --version`).
- **npm** 11 (livré avec Node 24).
- **Réseau.** La machine qui exécute le serveur doit joindre l'instance Jira en HTTPS. Derrière un proxy, définissez `HTTPS_PROXY` / `NO_PROXY` et `NODE_USE_ENV_PROXY=1` pour que le `fetch` de Node les utilise.
- **PAT (Personal Access Token).** Créez-le dans Jira (_Profil › Personal Access Tokens_) avec un compte dont les **permissions Jira sont minimales** pour l'usage visé : pour un usage en lecture, un compte sans droit d'écriture.
- **Autorité de certification privée.** Si l'instance utilise une autorité privée, rendez-la visible de Node, de l'une de ces deux façons :
  - installez-la dans le magasin de certificats du système, puis lancez Node avec `--use-system-ca` (les scripts npm et les exemples ci-dessous le font déjà) ;
  - ou définissez `NODE_EXTRA_CA_CERTS=<chemin du fichier PEM>`.

  Ne désactivez jamais la vérification TLS.

## Installation

Le serveur a besoin d'un **catalogue des opérations** (`catalog/catalog.json`). Il est propre à chaque instance et **n'est pas dans git**. Deux façons d'obtenir un serveur prêt à l'emploi :

### A. Depuis le paquet produit par la CI

Si le dépôt publie le paquet (voir « CI »), il contient déjà `dist/` et le catalogue de votre instance.

1. Téléchargez l'artefact `jira-mcp-package` depuis l'exécution du workflow, ou avec `gh run download <run-id> -n jira-mcp-package`. Il contient `jira-mcp-<version>.tgz`.
2. Décompressez le paquet et installez ses dépendances de production :
   ```bash
   tar -xzf jira-mcp-<version>.tgz        # crée le dossier package/
   cd package
   npm install --omit=dev
   npm audit --omit=dev
   ```
3. Le serveur se lance avec `node --use-system-ca dist/index.js` (voir « Brancher le serveur sur un client MCP »).

On utilise `npm install` et non `npm ci`, parce qu'un paquet produit par `npm pack` ne contient pas `package-lock.json`. Les dépendances directes sont figées par version exacte dans `package.json` ; les dépendances transitives sont résolues au moment de l'installation, d'où le `npm audit`.

### B. Depuis les sources

Le PAT n'est utilisé qu'en lecture pour télécharger les WADL.

**bash (Linux, macOS, Git Bash) :**

```bash
git clone <url-du-dépôt> jira-mcp && cd jira-mcp
npm ci
export JIRA_BASE_URL=https://jira.example.com   # exemple fictif : URL de votre instance
read -rs JIRA_PAT && export JIRA_PAT            # saisie masquée, rien dans l'historique
npm run catalog:fetch      # télécharge les WADL et serverInfo
npm run catalog:build      # génère catalog/catalog.json
npm run catalog:check      # contrôle bloquant (verrou, décisions, revue)
npm run build              # compile dist/
```

**PowerShell (Windows) :**

```powershell
git clone <url-du-dépôt> jira-mcp; cd jira-mcp
npm ci
$env:JIRA_BASE_URL = 'https://jira.example.com'   # exemple fictif
$pat = Read-Host -MaskInput 'PAT'; $env:JIRA_PAT = $pat; Remove-Variable pat
npm run catalog:fetch; npm run catalog:build; npm run catalog:check
npm run build
```

Points d'attention :

- **Première génération.** Tant que `catalog/source-lock.json` n'existe pas, ou si l'instance ne correspond plus au verrou, `catalog:check` échoue : suivez « Catalogue et revue » (revue des candidats, puis `catalog:build -- --update-lock`).
- **Instance sans Xray.** Le WADL Xray est facultatif : un 404 est consigné et la génération continue.
- **Sans catalogue,** le serveur s'arrête au démarrage avec un message qui indique ces commandes.

### Vérifier l'installation

```bash
npm run smoke    # après npm run build ; JIRA_BASE_URL, JIRA_PAT et SMOKE_PROJECT requis
```

Le test de fumée lance le serveur compilé en lecture seule et vérifie :

- qu'aucun outil d'écriture n'est exposé et que tous sont annotés en lecture ;
- `jira_get_server_info` (et que la version de Jira correspond au catalogue) et `jira_get_current_user` (PAT valide) ;
- une recherche JQL sur `SMOKE_PROJECT` ;
- un appel générique en lecture, et le refus d'une écriture par `jira_call_read_operation`.

Il n'affiche que des libellés `PASS` / `FAIL` et des comptes, jamais l'URL ni le contenu des réponses.

## Configuration

Le serveur se configure uniquement par variables d'environnement.

| Variable                   | Requis | Défaut                 | Rôle                                                                                                             |
| -------------------------- | ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`            | oui    | —                      | URL de l'instance, par exemple `https://jira.example.com` (valeur fictive). HTTPS exigé par défaut.              |
| `JIRA_PAT`                 | oui    | —                      | Personal Access Token, envoyé en `Authorization: Bearer`                                                         |
| `JIRA_ALLOW_WRITES`        | non    | `false`                | active les 10 outils d'écriture dédiés et `jira_call_write_operation`                                            |
| `JIRA_ENABLE_XRAY`         | non    | `false`                | expose les opérations Xray du catalogue dans les outils génériques                                               |
| `JIRA_ALLOW_INSECURE_HTTP` | non    | `false`                | accepte `http://` pour des tests locaux exceptionnels (avertissement au démarrage)                               |
| `JIRA_TIMEOUT_MS`          | non    | `30000`                | délai maximal par tentative de requête                                                                           |
| `JIRA_MAX_RESPONSE_BYTES`  | non    | `5242880`              | taille maximale d'une réponse HTTP (5 Mio) ; au-delà, la lecture est interrompue                                 |
| `JIRA_MAX_OUTPUT_CHARS`    | non    | `100000`               | taille maximale du texte rendu au modèle ; au-delà, la sortie est tronquée avec la mention « output truncated »  |
| `JIRA_CATALOG_PATH`        | non    | `catalog/catalog.json` | emplacement du catalogue (le défaut est résolu par rapport au dossier d'installation, pas au répertoire courant) |

Valeurs booléennes acceptées : `true`, `false`, `1`, `0`. Toute autre valeur est refusée au démarrage avec un message qui nomme la variable.

**URL de base.** Une URL avec chemin de contexte est prise en charge, par exemple `https://jira.example.com/jira` (valeur fictive) : les chemins du catalogue restent en `/rest/...`. La barre oblique finale est ignorée.

**Xray.** `JIRA_ENABLE_XRAY` agit seulement sur le serveur :

- désactivé, les opérations Xray n'apparaissent pas dans `jira_list_operations`, et un appel à une opération Xray est refusé avec un message qui indique l'option ;
- le catalogue reste généré et revu avec les opérations Xray si le plugin est installé : on peut donc activer Xray plus tard sans régénérer le catalogue ;
- activé alors que le catalogue ne contient aucune opération Xray, le serveur affiche un avertissement au démarrage.

**Journal de démarrage** (sur stderr, sans l'URL de l'instance) :

```text
[jira-mcp] ready (read-only; Xray disabled; catalog: 812 operations from Jira 8.20.0, WADL fetched 2026-10-11T08:00:00.000Z)
```

## Brancher le serveur sur un client MCP

Le serveur parle MCP sur **stdin/stdout** ; il se lance avec :

```bash
node --use-system-ca /chemin/vers/jira-mcp/dist/index.js
```

Ne mettez **jamais le PAT en clair** dans un fichier de configuration versionné ou dans une ligne de commande (historique du shell) : passez-le par l'environnement.

### Claude Code (fichier `.mcp.json`)

1. Copiez `.mcp.json.example` en `.mcp.json` à la racine de votre projet (ce fichier est ignoré par git dans ce dépôt ; ajoutez-le aussi au `.gitignore` de votre projet).
2. Adaptez le chemin et l'URL :
   ```json
   {
     "mcpServers": {
       "jira": {
         "command": "node",
         "args": ["--use-system-ca", "/chemin/vers/jira-mcp/dist/index.js"],
         "env": {
           "JIRA_BASE_URL": "https://jira.example.com",
           "JIRA_PAT": "${JIRA_PAT}",
           "JIRA_ALLOW_WRITES": "false",
           "JIRA_ENABLE_XRAY": "false"
         }
       }
     }
   }
   ```
   `${JIRA_PAT}` est remplacé par Claude Code à partir de votre environnement.
3. Définissez `JIRA_PAT` dans l'environnement qui lance Claude Code, puis vérifiez avec `/mcp` que le serveur `jira` est connecté.

Sous Windows, utilisez un chemin avec des barres obliques ou des antislashs doublés, par exemple `"C:/outils/jira-mcp/dist/index.js"`.

### Claude Code (ligne de commande)

```bash
claude mcp add jira \
  -e JIRA_BASE_URL=https://jira.example.com \
  -e JIRA_ALLOW_WRITES=false \
  -- node --use-system-ca /chemin/vers/jira-mcp/dist/index.js
```

Le PAT n'est pas passé ici : il est hérité de l'environnement qui lance Claude Code.

### Autres clients MCP

Tout client qui lance un serveur stdio convient : même commande, mêmes variables d'environnement. Pour activer les écritures, mettez `JIRA_ALLOW_WRITES` à `true` ; idéalement avec un PAT distinct, dont le compte a les droits d'écriture nécessaires et pas plus.

## Outils MCP

Conventions communes :

- **Ticket** : `issueKey` accepte une clé (`DEMO-123`) ou un identifiant numérique (`10001`).
- **Projet** : `projectKey` est la clé du projet (`DEMO`).
- **Pagination** : `startAt` (défaut `0`) et `maxResults` (1 à 100) ; la réponse contient `startAt`, `maxResults` et `total` quand Jira les fournit.
- **Champs** : `fields` est une liste d'identifiants (`["summary","status","customfield_10001"]`) ; `["*all"]` renvoie tous les champs (réponse volumineuse). Défaut des recherches : `summary`, `status`, `assignee`, `reporter`, `priority`, `issuetype`, `created`, `updated`.
- **Textes** : wiki markup Jira (API v2), pas ADF. Utilisateurs identifiés par leur `name` (login).
- **Réponses** : le JSON renvoyé par Jira, tronqué au-delà de `JIRA_MAX_OUTPUT_CHARS`. Une erreur Jira est rendue comme une erreur d'outil avec le statut HTTP et les messages de Jira.
- **Annotations** : `lecture` = `readOnlyHint` ; `écriture` = modification non destructive ; `destructif` = `destructiveHint` (le client MCP peut demander une confirmation).
- Les paramètres marqués **\*** sont obligatoires.

### Métadonnées (lecture)

| Outil                        | Rôle                                                                         | Paramètres                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jira_get_server_info`       | Version, numéro de build et URL de base de Jira                              | —                                                                                                    |
| `jira_get_current_user`      | Utilisateur propriétaire du PAT                                              | —                                                                                                    |
| `jira_search_users`          | Recherche d'utilisateurs par login, nom ou fragment d'e-mail                 | `query`\*, `maxResults` (défaut 20)                                                                  |
| `jira_list_projects`         | Projets visibles (id, clé, nom, type)                                        | —                                                                                                    |
| `jira_get_project`           | Détail d'un projet : composants, versions, types de tickets (peut être gros) | `projectKey`\*                                                                                       |
| `jira_get_project_statuses`  | Statuts disponibles par type de ticket dans un projet                        | `projectKey`\*                                                                                       |
| `jira_list_fields`           | Champs système et personnalisés avec leurs identifiants                      | `query` (nom ou id, sans casse ni accents, ex. `"sprint"`, `"10001"`), `customOnly` (défaut `false`) |
| `jira_list_issue_link_types` | Noms des types de liens utilisables avec `jira_link_issues`                  | —                                                                                                    |

### Tickets (lecture)

| Outil                  | Rôle                                                                                | Paramètres                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `jira_search_issues`   | Recherche JQL (envoyée en `POST /rest/api/2/search`, ce qui permet des JQL longues) | `jql`\*, `fields`, `expand` (chaîne séparée par des virgules, ex. `"renderedFields,changelog"`), `startAt`, `maxResults` (défaut 25) |
| `jira_get_issue`       | Un ticket ; restreignez `fields` pour garder une réponse courte                     | `issueKey`\*, `fields`, `expand` (liste, ex. `["renderedFields","changelog","transitions"]`)                                         |
| `jira_get_transitions` | Transitions de workflow disponibles sur un ticket                                   | `issueKey`\*, `includeFields` (défaut `false` ; `true` renvoie les champs de l'écran de chaque transition)                           |
| `jira_get_comments`    | Commentaires d'un ticket                                                            | `issueKey`\*, `startAt`, `maxResults` (défaut 50), `orderBy` (`created` ou `-created`)                                               |
| `jira_get_create_meta` | Champs requis et valeurs autorisées pour créer un ticket dans un projet             | `projectKey`\*, `issueType` (nom, ex. `"Task"`)                                                                                      |
| `jira_get_edit_meta`   | Champs modifiables d'un ticket ; si la réponse est vide, passez par une transition  | `issueKey`\*                                                                                                                         |

Exemple d'appel de `jira_search_issues` :

```json
{
  "jql": "project = DEMO AND statusCategory != Done ORDER BY created DESC",
  "fields": ["summary", "status", "assignee"],
  "maxResults": 10
}
```

### Tickets (écriture, si `JIRA_ALLOW_WRITES=true`)

Aucune écriture n'est rejouée automatiquement, même après une erreur réseau.

| Outil                   | Annotation | Rôle                                                                            | Paramètres                                                                                                                           |
| ----------------------- | ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `jira_create_issue`     | écriture   | Crée un ticket. Utilisez d'abord `jira_get_create_meta` pour les champs requis. | `projectKey`\*, `issueType`\* (nom), `summary`\*, `description` (wiki markup), `fields` (id de champ → valeur)                       |
| `jira_update_issue`     | écriture   | Modifie un ticket : `fields` fixe des valeurs, `update` applique des opérations | `issueKey`\*, `fields`, `update` (ex. `{"labels":[{"add":"x"}]}`), `notifyUsers` (défaut `true`)                                     |
| `jira_transition_issue` | écriture   | Fait avancer un ticket dans son workflow                                        | `issueKey`\*, `transitionId`\* (id numérique, voir `jira_get_transitions`), `fields`, `comment` (wiki markup)                        |
| `jira_add_comment`      | écriture   | Ajoute un commentaire, éventuellement restreint à un groupe ou un rôle          | `issueKey`\*, `body`\*, `visibility` (`{"type":"group"\|"role","value":"…"}`)                                                        |
| `jira_assign_issue`     | écriture   | Assigne un ticket                                                               | `issueKey`\*, `username`\* (login, ex. `"jdoe"` ; `null` pour désassigner ; `"-1"` pour l'assignation automatique)                   |
| `jira_add_worklog`      | écriture   | Saisit du temps passé                                                           | `issueKey`\*, `timeSpent`\* (ex. `"2h 30m"`, `"1.5h"`, `"1w 2d"`), `started` (format Jira `2026-10-11T09:00:00.000+0200`), `comment` |
| `jira_link_issues`      | écriture   | Crée un lien entre deux tickets                                                 | `linkType`\* (nom, ex. `"Relates"`, `"Blocks"`, `"Duplicate"`), `inwardIssue`\*, `outwardIssue`\*, `comment`                         |
| `jira_add_attachment`   | écriture   | Joint un fichier **du disque de la machine qui exécute le serveur**             | `issueKey`\*, `filePath`\* (chemin absolu)                                                                                           |
| `jira_delete_issue`     | destructif | Supprime définitivement un ticket. Irréversible.                                | `issueKey`\*, `deleteSubtasks` (défaut `false`)                                                                                      |

Valeurs de `fields` : les listes de sélection s'écrivent `{"value":"…"}`, les composants `[{"name":"…"}]`, les utilisateurs `{"name":"jdoe"}`. Exemple : `{"customfield_10001":{"value":"Production"},"components":[{"name":"Backend"}]}`. Si `description` est donnée à la fois en paramètre et dans `fields`, le paramètre l'emporte.

`jira_add_attachment` lit **n'importe quel fichier accessible** au compte qui exécute le serveur : aucune restriction de chemin ni confirmation supplémentaire. N'activez les écritures que dans un contexte où c'est acceptable.

### Agile

| Outil                        | Annotation | Rôle                                               | Paramètres                                                                                           |
| ---------------------------- | ---------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jira_list_boards`           | lecture    | Tableaux Scrum / Kanban                            | `projectKeyOrId`, `name`, `type` (`scrum` ou `kanban`), `startAt`, `maxResults` (défaut 50)          |
| `jira_list_sprints`          | lecture    | Sprints d'un tableau Scrum                         | `boardId`\*, `state` (liste parmi `future`, `active`, `closed`), `startAt`, `maxResults` (défaut 50) |
| `jira_get_sprint_issues`     | lecture    | Tickets d'un sprint, éventuellement filtrés en JQL | `sprintId`\*, `jql`, `fields`, `startAt`, `maxResults` (défaut 50)                                   |
| `jira_move_issues_to_sprint` | écriture   | Déplace jusqu'à 50 tickets dans un sprint          | `sprintId`\*, `issueKeys`\* (1 à 50 clés ou ids) — seulement si `JIRA_ALLOW_WRITES=true`             |

### Outils génériques (catalogue)

Ils couvrent les opérations qui n'ont pas d'outil dédié. Démarche : chercher, décrire, puis appeler.

| Outil                       | Annotation | Rôle                                                                                                                                                                   | Paramètres                                                                                                                                                                                                   |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jira_list_operations`      | lecture    | Cherche dans le catalogue ; tous les termes doivent figurer dans l'id (`"METHOD /path"`) ou le résumé. Chaque résultat indique sa classe d'accès.                      | `query` (ex. `"worklog"`, `"sprint issue"`), `api` (`api`, `agile`, et `xray` si activé), `method` (`GET`, `POST`, `PUT`, `DELETE`), `access` (`read`, `write`, `destructive`), `limit` (1 à 100, défaut 20) |
| `jira_describe_operation`   | lecture    | Définition complète : classe d'accès et son origine, paramètres de chemin et de requête (type, requis si déclaré, répétable), types de corps acceptés, contrôles faits | `operationId`\*                                                                                                                                                                                              |
| `jira_call_read_operation`  | lecture    | Appelle une opération classée `read` (y compris des POST revus comme lectures)                                                                                         | `operationId`\*, `pathParams`, `query`, `body`                                                                                                                                                               |
| `jira_call_write_operation` | destructif | Appelle une opération classée `write` ou `destructive` — seulement si `JIRA_ALLOW_WRITES=true`                                                                         | `operationId`\*, `pathParams`, `query`, `body`                                                                                                                                                               |

Contrôles faits avant l'appel :

- `operationId` doit exister dans le catalogue (et appartenir à une famille activée) ;
- `pathParams` : tous les paramètres du chemin sont requis, typés, encodés ; `..`, `.` et les valeurs vides sont refusés ;
- `query` : seuls les paramètres déclarés sont acceptés, avec leur type ; une liste n'est acceptée que pour un paramètre répétable ;
- `body` : refusé si l'opération n'accepte pas de corps, ou pour un GET / HEAD ; seul le JSON est accepté. Le WADL ne décrit pas le contenu du corps : c'est Jira qui le valide.

Exemple :

```json
{
  "operationId": "GET /rest/api/2/issue/{issueIdOrKey}/worklog",
  "pathParams": { "issueIdOrKey": "DEMO-123" }
}
```

`jira_call_write_operation` est annoté `destructiveHint: true` **par choix conservateur**, même pour une modification courante, car il peut aussi appeler des suppressions.

## Sécurité

- **Lecture seule par défaut.** `JIRA_ALLOW_WRITES=true` active les outils d'écriture (dont `jira_add_attachment`) et `jira_call_write_operation`. Le client HTTP refuse en plus toute requête non `read` quand les écritures sont désactivées.
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
- **Reprises.** Seules les lectures sont réessayées : sur 429, 502, 503, 504, erreur réseau ou coupure pendant la réception, avec 2 reprises au maximum. Si Jira demande d'attendre plus de 10 s (`Retry-After`), l'erreur 429 est renvoyée sans nouvelle tentative. Une écriture n'est jamais rejouée.
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
  - L'URL de l'instance n'est pas journalisée au démarrage ; les scripts qui appellent Jira n'affichent qu'une ligne d'erreur nettoyée (sans hôte, adresse IP ni détail de certificat).
  - L'inventaire des endpoints (WADL, `catalog/catalog.json`, rapports) **n'est pas versionné**.

## Catalogue et revue

| Commande                                 | Effet                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run catalog:fetch`                  | télécharge les WADL et `serverInfo` (PAT, lecture seule)                     |
| `npm run catalog:build`                  | génère `catalog/catalog.json`, `catalog/last-diff.md` et `catalog/review.md` |
| `npm run catalog:build -- --update-lock` | réécrit `catalog/source-lock.json` (refusé si une revue est en attente)      |
| `npm run catalog:check`                  | contrôle bloquant : verrou, cohérence, décisions, revue                      |
| `npm run catalog:drift`                  | compare l'instance au verrou (code de sortie 2 si dérive)                    |

**Première génération, ou après une mise à jour de Jira ou d'un plugin :**

1. `catalog:drift` (sauf la première fois) ;
2. `catalog:fetch`, puis `catalog:build` ;
3. décider chaque candidat listé dans `catalog/review.md`, dans `catalog/access-decisions.json` (raison, relecteur, date) ;
4. `catalog:build -- --update-lock`, puis `npm run verify` ;
5. pull request relue par une seconde personne.

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

## Développement

| Commande                        | Effet                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`                   | lance le serveur depuis les sources, avec rechargement                               |
| `npm run build` / `npm start`   | compile `dist/` / lance le serveur compilé                                           |
| `npm test` / `npm run coverage` | tests unitaires (sans Jira, sans catalogue généré)                                   |
| `npm run check`                 | format, lint, types, couverture, recherche de secrets                                |
| `npm run verify`                | `check` + `catalog:check`                                                            |
| `npm run smoke`                 | test de fumée réel en lecture seule (après `npm run build` ; `SMOKE_PROJECT` requis) |

**Règle d'or :** stdout est le canal MCP. N'utilisez jamais `console.log` (oxlint le refuse).

## Dépannage

| Symptôme                                                       | Cause probable et solution                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration — JIRA_BASE_URL: …`                     | URL absente ou invalide, ou `http://` sans `JIRA_ALLOW_INSECURE_HTTP=true`.                                       |
| `Operation catalog not found at …`                             | `catalog/catalog.json` absent : voir « Installation », ou définir `JIRA_CATALOG_PATH`.                            |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | Autorité de certification privée non visible de Node : `--use-system-ca` ou `NODE_EXTRA_CA_CERTS`.                |
| `ENOTFOUND`, `ECONNREFUSED`, délai dépassé                     | Instance non joignable : réseau, VPN ou proxy (`HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1`).                |
| 401                                                            | PAT invalide ou expiré.                                                                                           |
| 403                                                            | Le compte du PAT n'a pas la permission Jira nécessaire.                                                           |
| Les outils d'écriture n'apparaissent pas                       | `JIRA_ALLOW_WRITES` n'est pas à `true` (lecture seule par défaut).                                                |
| Opération Xray refusée ou absente                              | `JIRA_ENABLE_XRAY` n'est pas à `true`, ou le plugin Xray n'était pas installé lors de la génération du catalogue. |
| `catalog:check` échoue                                         | Verrou absent ou différent de l'instance, ou candidat non revu : voir « Catalogue et revue ».                     |

## Notes Jira Server / Data Center

- **API v2.** Textes en wiki markup (pas ADF), utilisateurs identifiés par `name`.
- **Champs personnalisés.** Leurs identifiants (`customfield_NNNNN`) varient d'une instance à l'autre : retrouvez-les avec `jira_list_fields` (par exemple `query: "sprint"`).
- **`editmeta` vide.** Si `editmeta` est vide pour un ticket, la modification passe par une transition : `jira_get_transitions` avec `includeFields: true`, puis `jira_transition_issue`.
