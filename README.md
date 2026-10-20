# jira-api2-mcp

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
- [Versions et dépendances](#versions-et-dépendances)
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

  La commande `jira-api2-mcp` (champ `bin` du paquet) ne passe pas d'option à Node : pour elle, définissez `NODE_OPTIONS=--use-system-ca` dans l'environnement, ou `NODE_EXTRA_CA_CERTS`.

## Installation

Le serveur a besoin d'un **catalogue des opérations** (`catalog/catalog.json`). Il est généré depuis les WADL de l'instance AGRICA, **versionné** dans git et inclus dans le paquet publié. Trois façons d'obtenir un serveur prêt à l'emploi :

### A. Depuis le paquet produit par la CI

Si le dépôt publie le paquet (voir « CI »), il contient déjà `dist/` et le catalogue de votre instance.

1. Téléchargez l'artefact `jira-api2-mcp-package` depuis l'exécution du workflow, ou avec `gh run download <run-id> -n jira-api2-mcp-package`. Il contient `agrica-jira-api2-mcp-<version>.tgz`.
2. Décompressez le paquet et installez ses dépendances de production :
   ```bash
   tar -xzf agrica-jira-api2-mcp-<version>.tgz # crée le dossier package/
   cd package
   npm install --omit=dev
   npm audit --omit=dev
   ```
3. Le serveur se lance avec `node --use-system-ca dist/index.js` (voir « Brancher le serveur sur un client MCP »).

On utilise `npm install` et non `npm ci`, parce qu'un paquet produit par `npm pack` ne contient pas `package-lock.json`. Les dépendances directes sont figées par version exacte dans `package.json` ; les dépendances transitives sont résolues au moment de l'installation, d'où le `npm audit`.

### B. Depuis le registre npm de GitHub (GitHub Packages)

Chaque version publiée (voir « Versions et dépendances ») est sur le registre npm de GitHub, sous le nom `@agrica/jira-api2-mcp`. Ce paquet contient le catalogue versionné (`catalog/catalog.json`) : aucun `JIRA_CATALOG_PATH` n'est nécessaire.

1. GitHub Packages exige un jeton, même pour lire un paquet. Créez un _personal access token_ avec le droit `read:packages`, puis ajoutez-le à votre `~/.npmrc` **utilisateur** (jamais à un fichier versionné) :
   ```
   @agrica:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=VOTRE_JETON_GITHUB
   ```
2. Installez le paquet :
   ```bash
   npm install -g @agrica/jira-api2-mcp            # dernière version stable
   npm install -g @agrica/jira-api2-mcp@<version>  # version précise
   ```
   Les pré-versions (`1.2.0-rc.1`, par exemple) sont publiées sous l'étiquette `next` : `npm install -g @agrica/jira-api2-mcp@next`.
3. Le serveur installé se trouve dans `$(npm root -g)/@agrica/jira-api2-mcp/dist/index.js` : c'est le chemin à donner à `node --use-system-ca` (voir « Brancher le serveur sur un client MCP »). La commande `jira-api2-mcp` est aussi disponible ; pour une autorité de certification privée, elle demande `NODE_OPTIONS=--use-system-ca` (voir « Prérequis »).

Mettre à jour : `npm install -g @agrica/jira-api2-mcp@latest`.

### C. Depuis les sources

Le PAT n'est utilisé qu'en lecture pour télécharger les WADL.

**bash (Linux, macOS, Git Bash) :**

```bash
git clone <url-du-dépôt> jira-api2-mcp && cd jira-api2-mcp
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
git clone <url-du-dépôt> jira-api2-mcp; cd jira-api2-mcp
npm ci
$env:JIRA_BASE_URL = 'https://jira.example.com'   # exemple fictif
$pat = Read-Host -MaskInput 'PAT'; $env:JIRA_PAT = $pat; Remove-Variable pat
npm run catalog:fetch; npm run catalog:build; npm run catalog:check
npm run build
```

Points d'attention :

- **Première génération.** Tant que `catalog/source-lock.json` n'existe pas, ou si l'instance ne correspond plus au verrou, `catalog:check` échoue : suivez « Catalogue et revue » (revue des candidats, puis `catalog:build -- --update-lock`).
- **Relecteur à renseigner.** `catalog/access-decisions.json` est livré avec une décision dont le relecteur est un modèle (`<identité git du relecteur>`) : `catalog:build` s'arrête tant qu'une personne n'a pas relu cette décision et remplacé ce modèle par son identité git (voir « Catalogue et revue »).
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

| Variable                   | Requis | Défaut                 | Rôle                                                                                                                                                             |
| -------------------------- | ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`            | oui    | —                      | URL de l'instance, par exemple `https://jira.example.com` (valeur fictive). HTTPS exigé par défaut. Ni identifiants, ni paramètres, ni fragment.                 |
| `JIRA_PAT`                 | oui    | —                      | Personal Access Token, envoyé en `Authorization: Bearer` ; caractères ASCII visibles uniquement (espaces de début et de fin retirés)                             |
| `JIRA_ALLOW_WRITES`        | non    | `false`                | active les 10 outils d'écriture dédiés et `jira_call_write_operation`                                                                                            |
| `JIRA_ENABLE_XRAY`         | non    | `false`                | expose les opérations Xray du catalogue dans les outils génériques                                                                                               |
| `JIRA_ALLOW_INSECURE_HTTP` | non    | `false`                | accepte `http://` pour des tests locaux exceptionnels (avertissement au démarrage)                                                                               |
| `JIRA_TIMEOUT_MS`          | non    | `30000`                | délai maximal par tentative de requête (au plus `600000`, soit 10 min)                                                                                           |
| `JIRA_MAX_RESPONSE_BYTES`  | non    | `5242880`              | taille maximale d'une réponse HTTP (5 Mio) ; au-delà, la lecture est interrompue (au plus `268435456`, 256 Mio)                                                  |
| `JIRA_MAX_OUTPUT_CHARS`    | non    | `100000`               | taille maximale du texte rendu au modèle, messages d'erreur compris ; au-delà, la sortie est tronquée avec la mention « output truncated » (au plus `100000000`) |
| `JIRA_CATALOG_PATH`        | non    | `catalog/catalog.json` | emplacement du catalogue (le défaut est résolu par rapport au dossier d'installation, pas au répertoire courant)                                                 |

Valeurs booléennes acceptées : `true`, `false`, `1`, `0`. Les valeurs numériques sont des entiers décimaux positifs (`0x10` ou `1e3` sont refusés). Toute autre valeur est refusée au démarrage avec un message qui nomme la variable, sans reprendre la valeur du PAT ni l'URL. Une variable facultative vide (`""`, fréquent dans les configurations MCP) est traitée comme absente.

**URL de base.** Une URL avec chemin de contexte est prise en charge, par exemple `https://jira.example.com/jira` (valeur fictive) : les chemins du catalogue restent en `/rest/...`. La barre oblique finale est ignorée. Une URL qui contient des identifiants (`https://user:motdepasse@…`), des paramètres (`?…`) ou un fragment (`#…`) est refusée au démarrage : les identifiants finiraient dans les messages d'erreur, et les paramètres ou le fragment avaleraient le chemin REST.

**Xray.** `JIRA_ENABLE_XRAY` agit seulement sur le serveur :

- désactivé, les opérations Xray n'apparaissent pas dans `jira_list_operations`, et un appel à une opération Xray est refusé avec un message qui indique l'option ;
- le catalogue reste généré et revu avec les opérations Xray si le plugin est installé : on peut donc activer Xray plus tard sans régénérer le catalogue ;
- activé alors que le catalogue ne contient aucune opération Xray, le serveur affiche un avertissement au démarrage et le signale aussi au modèle (description de `jira_list_operations` et instructions du serveur).

**Journal de démarrage** (sur stderr, sans l'URL de l'instance) :

```text
[jira-api2-mcp] ready (read-only; Xray disabled; catalog: 812 operations from Jira 8.20.0, WADL fetched 2026-10-11T08:00:00.000Z)
```

## Brancher le serveur sur un client MCP

Le serveur parle MCP sur **stdin/stdout** ; il se lance avec :

```bash
node --use-system-ca /chemin/vers/jira-api2-mcp/dist/index.js
```

Ne mettez **jamais le PAT en clair** dans un fichier de configuration versionné ou dans une ligne de commande (historique du shell) : passez-le par l'environnement.

### Claude Code

La procédure suppose le paquet installé depuis GitHub Packages (méthode B). Depuis les sources (méthode C), remplacez le chemin du serveur par `/chemin/vers/jira-api2-mcp/dist/index.js`. Dans les deux cas, le catalogue est trouvé dans `catalog/` : `JIRA_CATALOG_PATH` ne sert qu'à en utiliser un autre.

**1. Préparer le poste**

- Installez le paquet (méthode B) : il contient le catalogue.
- Repérez le chemin du serveur installé : `npm root -g` donne le dossier des paquets globaux, et le serveur est `<ce dossier>/@agrica/jira-api2-mcp/dist/index.js`.
- Placez le PAT Jira dans une variable d'environnement **utilisateur**, jamais dans un fichier ni sur une ligne de commande. Sous Windows, sans laisser le jeton dans l'historique :
  ```powershell
  [Environment]::SetEnvironmentVariable('JIRA_PAT', (Read-Host -MaskInput 'PAT Jira'), 'User')
  ```
  Sous Linux ou macOS, ajoutez `export JIRA_PAT=…` à un fichier de profil lisible par vous seul. Relancez ensuite le terminal et Claude Code pour qu'ils voient la variable.

**2. Enregistrer le serveur (ligne de commande)**

`--scope user` rend le serveur disponible dans tous vos projets. Sans cette option, il ne l'est que dans le projet courant (`local`).

bash :

```bash
claude mcp add jira --scope user \
  -e JIRA_BASE_URL=https://jira.example.com \
  -e JIRA_ALLOW_WRITES=false \
  -- node --use-system-ca "$(npm root -g)/@agrica/jira-api2-mcp/dist/index.js"
```

PowerShell :

```powershell
claude mcp add jira --scope user `
  -e JIRA_BASE_URL=https://jira.example.com `
  -e JIRA_ALLOW_WRITES=false `
  -- node --use-system-ca "$(npm root -g)/@agrica/jira-api2-mcp/dist/index.js"
```

Le PAT n'apparaît pas dans la commande : le serveur hérite de `JIRA_PAT` depuis l'environnement de Claude Code. Si un serveur porte déjà le nom `jira`, choisissez-en un autre (`jira-api2`, par exemple) ou supprimez l'ancien avec `claude mcp remove jira --scope user`.

**Ou bien : fichier `.mcp.json` (portée projet)**

1. Copiez `.mcp.json.example` en `.mcp.json` à la racine de votre projet (ce fichier est ignoré par git dans ce dépôt ; ajoutez-le aussi au `.gitignore` de votre projet).
2. Adaptez le chemin et l'URL :
   ```json
   {
     "mcpServers": {
       "jira": {
         "command": "node",
         "args": [
           "--use-system-ca",
           "/chemin/vers/node_modules/@agrica/jira-api2-mcp/dist/index.js"
         ],
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
   Claude Code remplace `${JIRA_PAT}` par la variable d'environnement du même nom. Si votre PAT est déjà dans une variable portant un autre nom, utilisez ce nom, par exemple `"JIRA_PAT": "${USER_TOKEN_JIRA}"`.

Sous Windows, écrivez les chemins avec des barres obliques ou des antislashs doublés, par exemple `"C:/outils/npm/node_modules/@agrica/jira-api2-mcp/dist/index.js"`.

**3. Vérifier**

- `claude mcp list` affiche le serveur et son état ; dans une session, `/mcp` doit le montrer connecté.
- Au démarrage, le serveur écrit sur stderr une ligne `[jira-api2-mcp] ready (read-only; …; catalog: N operations from Jira x.y.z, …)`. En cas d'échec, `/mcp` donne le message d'erreur (voir « Dépannage »).
- Demandez par exemple « qui suis-je dans Jira ? » : Claude appelle `jira_get_current_user`.

**Autorité de certification d'entreprise.** Si la connexion échoue avec `UNABLE_TO_GET_ISSUER_CERT` alors que `--use-system-ca` est présent, l'autorité n'est pas dans le magasin du système : retirez `--use-system-ca` et ajoutez `-e NODE_EXTRA_CA_CERTS=/chemin/vers/ca.pem`, ou `"NODE_EXTRA_CA_CERTS"` dans `env`.

**Mettre à jour.** `npm install -g @agrica/jira-api2-mcp@latest`, puis relancez Claude Code. Le chemin du serveur ne change pas. Après une mise à jour de Jira ou d'un plugin, régénérez le catalogue (« Catalogue et revue ») et recopiez-le à son emplacement.

### Autres clients MCP

Tout client qui lance un serveur stdio convient : même commande, mêmes variables d'environnement. Pour activer les écritures, mettez `JIRA_ALLOW_WRITES` à `true` ; idéalement avec un PAT distinct, dont le compte a les droits d'écriture nécessaires et pas plus.

## Outils MCP

Conventions communes :

- **Ticket** : `issueKey` accepte une clé (`DEMO-123`) ou un identifiant numérique (`10001`).
- **Projet** : `projectKey` est la clé du projet (`DEMO`).
- **Pagination** : `startAt` (défaut `0`) et `maxResults` (1 à 100 ; 0 à 100 pour `jira_search_issues`, où `0` ne renvoie que `total`). `jira_list_boards` et `jira_list_sprints` sont limités à **1 à 50** : Jira Agile renvoie au plus 50 éléments par page (une valeur plus grande est ramenée à 50 sans erreur). `jira_get_sprint_issues` est une recherche et accepte 1 à 100. La réponse contient `startAt`, `maxResults` et `total` quand Jira les fournit ; les pages des tableaux et des sprints peuvent donner `isLast` à la place de `total` : la page suivante commence à `startAt` + nombre d'éléments reçus, jusqu'à `isLast: true`.
- **Champs** : `fields` est une liste d'identifiants (`["summary","status","customfield_10001"]`) ; `["*all"]` renvoie tous les champs (réponse volumineuse) et c'est la seule façon de les demander : une liste vide est refusée. Sans `fields`, `jira_search_issues` et `jira_get_sprint_issues` renvoient la liste par défaut (`summary`, `status`, `assignee`, `reporter`, `priority`, `issuetype`, `created`, `updated`), tandis que `jira_get_issue` renvoie tous les champs.
- **Textes** : wiki markup Jira (API v2), pas ADF. Utilisateurs identifiés par leur `name` (login).
- **Réponses** : le JSON renvoyé par Jira, tronqué au-delà de `JIRA_MAX_OUTPUT_CHARS`. Une erreur Jira est rendue comme une erreur d'outil avec le statut HTTP et les messages de Jira.
- **Annotations** : `lecture` = `readOnlyHint` ; `écriture` = modification non destructive (`idempotente` : la rejouer ne change rien, `idempotentHint`) ; `destructif` = `destructiveHint` (le client MCP peut demander une confirmation).
- Les paramètres marqués **\*** sont obligatoires.

### Métadonnées (lecture)

| Outil                        | Rôle                                                                                                                                                                                                  | Paramètres                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `jira_get_server_info`       | Version, numéro de build et URL de base de Jira                                                                                                                                                       | —                                                                                                    |
| `jira_get_current_user`      | Utilisateur propriétaire du PAT                                                                                                                                                                       | —                                                                                                    |
| `jira_search_users`          | Recherche d'utilisateurs par login, nom ou fragment d'e-mail                                                                                                                                          | `query`\*, `maxResults` (défaut 20)                                                                  |
| `jira_list_projects`         | Projets visibles (id, clé, nom, type)                                                                                                                                                                 | `query` (fragment de clé ou de nom, sans casse ni accents)                                           |
| `jira_get_project`           | Détail d'un projet : composants, versions, types de tickets (peut être gros)                                                                                                                          | `projectKey`\*                                                                                       |
| `jira_get_project_statuses`  | Statuts disponibles par type de ticket dans un projet                                                                                                                                                 | `projectKey`\*                                                                                       |
| `jira_list_fields`           | Champs système et personnalisés avec leurs identifiants et leurs noms JQL (`clauseNames`, ex. `cf[10001]`)                                                                                            | `query` (nom ou id, sans casse ni accents, ex. `"sprint"`, `"10001"`), `customOnly` (défaut `false`) |
| `jira_list_issue_link_types` | Types de liens utilisables avec `jira_link_issues` : id, nom, texte sortant (`outward`, ex. « blocks ») et entrant (`inward`, ex. « is blocked by »). Pour le sens d'un lien, voir `jira_link_issues` | —                                                                                                    |

### Tickets (lecture)

| Outil                  | Rôle                                                                                                                                                                                                                                                             | Paramètres                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jira_search_issues`   | Recherche JQL (envoyée en `POST /rest/api/2/search`, ce qui permet des JQL longues)                                                                                                                                                                              | `jql`\*, `fields`, `expand` (chaîne séparée par des virgules ou liste, ex. `"renderedFields,changelog"`), `startAt`, `maxResults` (0 à 100, défaut 25 ; `0` ne renvoie que `total`) |
| `jira_get_issue`       | Un ticket ; restreignez `fields` pour garder une réponse courte                                                                                                                                                                                                  | `issueKey`\*, `fields`, `expand` (liste, ex. `["renderedFields","changelog","transitions"]`)                                                                                        |
| `jira_get_transitions` | Transitions de workflow disponibles sur un ticket                                                                                                                                                                                                                | `issueKey`\*, `includeFields` (défaut `false` ; `true` renvoie les champs de l'écran de chaque transition)                                                                          |
| `jira_get_comments`    | Commentaires d'un ticket                                                                                                                                                                                                                                         | `issueKey`\*, `startAt`, `maxResults` (défaut 50), `orderBy` (`created` ou `-created`)                                                                                              |
| `jira_get_create_meta` | Champs requis et valeurs autorisées pour créer un ticket dans un projet. Sans `issueType`, la réponse couvre tous les types et peut être tronquée. Si Jira renvoie `projects: []` (projet ou type inconnu, ou pas le droit de créer), la réponse porte un `hint` | `projectKey`\*, `issueType` (nom exact, casse et accents compris, ex. `"Task"` ; voir `jira_get_project`)                                                                           |
| `jira_get_edit_meta`   | Champs modifiables d'un ticket ; si la réponse est vide, passez par une transition                                                                                                                                                                               | `issueKey`\*                                                                                                                                                                        |

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

| Outil                   | Annotation             | Rôle                                                                                                                                                               | Paramètres                                                                                                                                                                                                                        |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jira_create_issue`     | écriture               | Crée un ticket. Utilisez d'abord `jira_get_create_meta` pour les champs requis. Une sous-tâche demande un type sous-tâche et `fields.parent` = `{"key":"DEMO-1"}`. | `projectKey`\*, `issueType`\* (nom), `summary`\*, `description` (wiki markup), `fields` (id de champ → valeur)                                                                                                                    |
| `jira_update_issue`     | écriture               | Modifie un ticket : `fields` fixe des valeurs, `update` applique des opérations                                                                                    | `issueKey`\*, `fields`, `update` (ex. `{"labels":[{"add":"x"}]}`), `notifyUsers` (`false` supprime la notification ; réservé aux administrateurs Jira ou du projet, sinon HTTP 403 et rien n'est modifié)                         |
| `jira_transition_issue` | écriture               | Fait avancer un ticket dans son workflow                                                                                                                           | `issueKey`\*, `transitionId`\* (id numérique, voir `jira_get_transitions`), `fields`, `comment` (wiki markup)                                                                                                                     |
| `jira_add_comment`      | écriture               | Ajoute un commentaire, éventuellement restreint à un groupe ou un rôle                                                                                             | `issueKey`\*, `body`\*, `visibility` (`{"type":"group"\|"role","value":"…"}`)                                                                                                                                                     |
| `jira_assign_issue`     | écriture (idempotente) | Assigne un ticket                                                                                                                                                  | `issueKey`\*, `username`\* (login, ex. `"jdoe"` ; `null` pour désassigner ; `"-1"` pour l'assignation automatique)                                                                                                                |
| `jira_add_worklog`      | écriture               | Saisit du temps passé                                                                                                                                              | `issueKey`\*, `timeSpent`\* (ex. `"2h 30m"`, `"1.5h"`, `"1w 2d"`), `started` (voir ci-dessous), `comment`, `adjustEstimate` (`auto` par défaut, `new`, `manual`, `leave`), `newEstimate` (avec `new`), `reduceBy` (avec `manual`) |
| `jira_link_issues`      | écriture               | Crée un lien entre deux tickets (sens : voir ci-dessous, à vérifier après création)                                                                                | `linkType`\* (nom, ex. `"Relates"`, `"Blocks"`, `"Duplicate"`), `inwardIssue`\*, `outwardIssue`\*, `comment`                                                                                                                      |
| `jira_add_attachment`   | écriture               | Joint un fichier **du disque de la machine qui exécute le serveur** ; un dossier ou un fichier vide est refusé avant l'appel                                       | `issueKey`\*, `filePath`\* (chemin absolu)                                                                                                                                                                                        |
| `jira_delete_issue`     | destructif             | Supprime définitivement un ticket. Irréversible.                                                                                                                   | `issueKey`\*, `deleteSubtasks` (défaut `false`)                                                                                                                                                                                   |

Valeurs de `fields` : les listes de sélection s'écrivent `{"value":"…"}`, les composants `[{"name":"…"}]`, les utilisateurs `{"name":"jdoe"}`. Exemple : `{"customfield_10001":{"value":"Production"},"components":[{"name":"Backend"}]}`. Si `description` est donnée à la fois en paramètre et dans `fields`, le paramètre l'emporte.

`started` (`jira_add_worklog`) : format Jira `yyyy-MM-ddTHH:mm:ss.SSS±HHMM`, avec le décalage horaire. Les formes ISO 8601 terminées par `Z` ou `±HH:MM`, avec ou sans millisecondes, sont converties dans ce format ; toute autre valeur (date seule, heure sans fuseau…) est refusée avant l'appel. Sans `started`, Jira prend l'heure courante.

Sens d'un lien (`jira_link_issues`) : il est contre-intuitif et **non garanti**. Jira enregistre très probablement « `inwardIssue` <texte sortant> `outwardIssue` » : avec le type `Blocks` (sortant « blocks »), `inwardIssue: "DEMO-1"` et `outwardIssue: "DEMO-2"` devraient donner « DEMO-1 blocks DEMO-2 ». `jira_list_issue_link_types` donne les textes sortant et entrant de chaque type. Pour un type orienté, vérifiez toujours le résultat avec `jira_get_issue` (`fields: ["issuelinks"]`) sur `inwardIssue` : une entrée dont `type.outward` vaut « blocks » et dont `outwardIssue` est DEMO-2 le confirme. Si le sens est inversé, supprimez ce lien (`jira_call_write_operation`, `DELETE /rest/api/2/issueLink/{linkId}`, où `linkId` est l'`id` de l'entrée) et recréez-le en échangeant les tickets.

`jira_add_attachment` lit **n'importe quel fichier accessible** au compte qui exécute le serveur : aucune restriction de chemin ni confirmation supplémentaire. N'activez les écritures que dans un contexte où c'est acceptable.

### Agile

| Outil                        | Annotation             | Rôle                                                                           | Paramètres                                                                                                   |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `jira_list_boards`           | lecture                | Tableaux Scrum / Kanban                                                        | `projectKeyOrId`, `name`, `type` (`scrum` ou `kanban`), `startAt`, `maxResults` (1 à 50, défaut 50)          |
| `jira_list_sprints`          | lecture                | Sprints d'un tableau Scrum (un tableau Kanban n'en a pas : Jira répond 400)    | `boardId`\*, `state` (liste parmi `future`, `active`, `closed`), `startAt`, `maxResults` (1 à 50, défaut 50) |
| `jira_get_sprint_issues`     | lecture                | Tickets d'un sprint, éventuellement filtrés en JQL                             | `sprintId`\*, `jql`, `fields`, `startAt`, `maxResults` (1 à 100, défaut 50)                                  |
| `jira_move_issues_to_sprint` | écriture (idempotente) | Déplace jusqu'à 50 tickets dans un sprint ; ils quittent leur sprint précédent | `sprintId`\*, `issueKeys`\* (1 à 50 clés ou ids) — seulement si `JIRA_ALLOW_WRITES=true`                     |

### Outils génériques (catalogue)

Ils couvrent les opérations qui n'ont pas d'outil dédié. Démarche : chercher, décrire, puis appeler.

| Outil                       | Annotation | Rôle                                                                                                                                                                   | Paramètres                                                                                                                                                                                                                               |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jira_list_operations`      | lecture    | Cherche dans le catalogue ; tous les termes doivent figurer dans l'id (`"METHOD /path"`) ou le résumé. Chaque résultat indique sa classe d'accès.                      | `query` (ex. `"worklog"`, `"sprint issue"`), `api` (`api`, `agile`, et `xray` si activé), `method` (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`), `access` (`read`, `write`, `destructive`), `limit` (1 à 100, défaut 20) |
| `jira_describe_operation`   | lecture    | Définition complète : classe d'accès et son origine, paramètres de chemin et de requête (type, requis si déclaré, répétable), types de corps acceptés, contrôles faits | `operationId`\*                                                                                                                                                                                                                          |
| `jira_call_read_operation`  | lecture    | Appelle une opération classée `read` (y compris des POST revus comme lectures). Un corps binaire (fichier) n'est pas transmis au modèle : seule une note est renvoyée  | `operationId`\*, `pathParams`, `query`, `body`                                                                                                                                                                                           |
| `jira_call_write_operation` | destructif | Appelle une opération classée `write` ou `destructive` — seulement si `JIRA_ALLOW_WRITES=true`                                                                         | `operationId`\*, `pathParams`, `query`, `body`                                                                                                                                                                                           |

Contrôles faits avant l'appel :

- `operationId` doit exister dans le catalogue (et appartenir à une famille activée) ;
- `pathParams` : tous les paramètres du chemin sont requis, typés, encodés ; `..`, `.` et les valeurs vides sont refusés ;
- `query` : seuls les paramètres déclarés sont acceptés, avec leur type ; une liste n'est acceptée que pour un paramètre répétable ;
  - une valeur typée (entier, nombre, booléen) est envoyée telle quelle : entourée d'espaces, ou en hexadécimal (`0x10`), elle est refusée ;
  - un paramètre déclaré requis peut être omis s'il a une valeur par défaut ; une liste vide compte comme absente ;
- `body` : refusé si l'opération n'accepte pas de corps, ou pour un GET / HEAD ; seul le JSON est envoyé, accepté quand le WADL déclare un type JSON (`application/json`, `…+json`), un type générique (`*/*`, `application/*`) ou aucun type. Le WADL ne décrit pas le contenu du corps : c'est Jira qui le valide.

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
  - Une méthode PUT, PATCH ou DELETE ne peut jamais être classée `read`, ni par une décision de revue ni dans un catalogue chargé (`JIRA_CATALOG_PATH`) ; un POST classé `read` (recherche JQL) doit venir d'une décision de revue. Le client HTTP refuse aussi ces combinaisons.
  - Des heuristiques de chemin désignent les opérations à revoir : GET dont le nom évoque un effet de bord, POST dont le nom évoque une lecture, POST/PUT/PATCH dont le nom évoque une suppression.
  - **Ces heuristiques ne détectent rien** : chaque candidat est décidé par une personne, et `npm run catalog:check` bloque tant qu'un candidat n'est pas décidé.
- **Risque résiduel sur les GET.**
  - Les GET qui ne sont pas des candidats restent `read` sans revue individuelle ; leur `accessReason` le signale (`not individually reviewed`).
  - Un GET à effet de bord dont le nom paraît anodin ne serait donc pas signalé.
  - Ce risque est accepté explicitement à chaque livraison, dans une note de `docs/delivery/`.
  - **La barrière effective reste les permissions Jira du PAT utilisé.**
- **Annotations MCP.** Ce sont des **indications** pour le client MCP, par exemple pour qu'il demande une confirmation ; elles ne protègent rien.
- **Reprises.** Seules les lectures sont réessayées, avec 2 reprises au maximum :
  - sur 429, 502, 503, 504, délai dépassé, erreur réseau transitoire (connexion coupée ou refusée, DNS momentanément indisponible) ou coupure pendant la réception ;
  - pas sur une erreur déterministe (redirection, certificat, URL ou en-tête invalide), ni sur le délai dépassé d'une lecture en POST (recherche JQL lourde) ;
  - `Retry-After` est lu en secondes ou en date HTTP ; si Jira demande d'attendre plus de 10 s, l'erreur 429 ou 503 est renvoyée sans nouvelle tentative, avec la valeur de `Retry-After` ;
  - sans `Retry-After`, l'attente (0,5 s puis 1 s au plus) est en partie aléatoire, pour que des appels parallèles ne se relancent pas ensemble ;
  - une écriture n'est jamais rejouée.
- **Annulation.** Si le client MCP annule un appel, la requête Jira en cours est interrompue et n'est pas réessayée. Une écriture déjà reçue par Jira a pu être appliquée : vérifiez son état avant de la relancer. Si Jira avait déjà répondu 2xx, le message dit que l'écriture A été appliquée (« the write WAS applied »).
- **Écritures à l'issue incertaine.**
  - Quand une écriture échoue après avoir pu atteindre Jira, avant toute réponse 2xx (délai dépassé, connexion coupée, annulation, coupure pendant la lecture d'une réponse d'erreur, page HTML à la place de JSON, réponse HTTP 500, 502 ou 504 — un proxy peut abandonner pendant que Jira applique l'écriture), le message se termine par « The operation may already have been applied by Jira: check its state before retrying. » : vérifiez l'état dans Jira avant de relancer.
  - Une connexion refusée ou impossible à établir (`ECONNREFUSED`, `ENOTFOUND`, certificat), ou une requête refusée avant l'envoi (port interdit, en-tête invalide), ne porte pas cet avertissement : la requête n'est pas partie.
  - Quand Jira a répondu 2xx mais que le corps de la réponse est illisible (trop gros, JSON invalide, connexion coupée ou délai dépassé pendant sa lecture), l'outil renvoie un succès : « … succeeded (HTTP 201): the write WAS applied, but its response could not be read (…) ». Ne relancez pas l'écriture.
- **Réponse HTML.** Une réponse 2xx en HTML là où Jira doit répondre en JSON (page de connexion d'un proxy d'authentification ou d'un SSO) est une erreur, « unexpected HTML response instead of JSON », et non un succès.
- **Transport.**
  - **HTTPS est exigé par défaut.**
  - Une URL `http://` n'est acceptée qu'avec `JIRA_ALLOW_INSECURE_HTTP=true`, pour des tests locaux exceptionnels. Le serveur affiche alors un avertissement au démarrage, car le PAT circule en clair.
  - Les redirections sont refusées.
  - Toute requête part vers `<JIRA_BASE_URL>/rest/…` : un chemin qui contient un segment `.` ou `..`, un séparateur encodé (`%2e`, `%2f`, `%5c`), une barre oblique inverse, un `;` (Tomcat lit `..;/` comme `..`), un `?` ou un `#` est refusé, à la génération du catalogue, à son chargement et à l'envoi de la requête. Une valeur de paramètre de chemin ne peut contenir ni `/` ni `\`.
- **Taille.**
  - Au-delà de `JIRA_MAX_RESPONSE_BYTES`, la lecture est interrompue et une erreur est renvoyée.
  - La sortie destinée au modèle est limitée à `JIRA_MAX_OUTPUT_CHARS`, avec la mention « output truncated ».
- **Secrets et inventaire.**
  - Le PAT n'est jamais journalisé ni versionné (`npm run secrets:scan`, qui cherche aussi l'hôte de l'instance quand `JIRA_BASE_URL` est défini). Il n'apparaît pas non plus dans les erreurs renvoyées au modèle, même quand une page de proxy le renvoie ; le nom d'hôte de l'instance, les adresses IP et les noms de certificat en sont aussi retirés.
  - L'URL de l'instance n'est pas journalisée au démarrage ; les scripts qui appellent Jira n'affichent qu'une ligne d'erreur nettoyée (sans hôte, adresse IP ni détail de certificat).
  - Les WADL et les rapports de l'inventaire ne sont pas versionnés (les WADL contiennent l'URL de l'instance). Le catalogue `catalog/catalog.json` l'est, pour être inclus dans le paquet : il ne contient ni URL d'instance ni PAT, mais il révèle la version de Jira et la liste de ses opérations REST.

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
2. **la première fois, avant tout `catalog:build`** : relire la décision livrée pour `POST /rest/api/2/search` dans `catalog/access-decisions.json`, remplacer son relecteur modèle `<identité git du relecteur>` par votre identité git, et sa date par celle de la relecture ; sinon `catalog:build` s'arrête avec « replace the placeholder reviewer in catalog/access-decisions.json after reviewing the decision » ;
3. `catalog:fetch`, puis `catalog:build` ;
4. décider chaque candidat listé dans `catalog/review.md`, dans `catalog/access-decisions.json` (raison, relecteur, date) ;
5. `catalog:build -- --update-lock`, puis `npm run verify` ;
6. pull request relue par une seconde personne.

**Contrôles de la génération** (`catalog:fetch`, `catalog:build` et `catalog:check`) :

- **WADL inutilisable.** Un fichier vide, une page HTML (connexion SSO, proxy, erreur), un document sans `<application>` ni `<resources>`, ou un WADL sans aucune opération est refusé : `catalog:fetch` n'écrit alors aucun fichier, et `catalog:build` ne génère rien, donc `--update-lock` ne peut pas verrouiller un catalogue vide. Une `base` relative ou absente est signalée avec le nom du WADL.
- **Décisions.** Chaque entrée de `catalog/access-decisions.json`, même obsolète, est contrôlée ; chaque problème est affiché sur sa ligne, avec l'opération concernée :
  - `access` vaut exactement `read`, `write` ou `destructive` ;
  - `reason` et `reviewedBy` sont renseignés et ne sont pas des modèles (`<…>`, `TODO`, `TBD`, `?`, `x`, `xxx`…) ; une identité « Nom <courriel> » est acceptée ;
  - `reviewedOn` est une vraie date `AAAA-MM-JJ`, pas dans le futur (un jour de marge pour les fuseaux horaires).
- **Schéma du serveur.** Le catalogue généré passe par la même validation qu'au démarrage du serveur (chemins, classes d'accès, identifiants, comptes par famille) : un catalogue que le serveur refuserait échoue dès la génération.
- **Doublons.** Une même méthode et un même chemin déclarés deux fois dans un WADL sont fusionnés (paramètres réunis, corps accepté si l'une des déclarations l'accepte, première description gardée) et leur nombre est affiché. Les paramètres `matrix`, `header` et `plain`, que les outils génériques ne savent pas envoyer, sont comptés et signalés.
- **Xray absent.** Les décisions qui portent sur Xray (`/rest/raven/`) sont conservées sans être signalées comme obsolètes quand le plugin n'est pas installé.
- **Différences.** `catalog/last-diff.md` et le résumé `lastChange` du verrou comparent le catalogue au **dernier catalogue verrouillé**, et non à la génération précédente : `catalog:build` puis `catalog:build -- --update-lock` montrent tous deux les opérations ajoutées ou supprimées par la mise à jour de Jira.
  - Le verrou ne contient que l'empreinte des opérations ; leur liste est gardée localement dans `catalog/lock-baseline.json` (non versionné), écrit par `--update-lock`.
  - Si cette copie a été supprimée, un `catalog/catalog.json` encore identique au verrou sert de référence, de même que le catalogue qui vient d'être généré : sur un nouveau clone dont les WADL correspondent encore au verrou, la différence est donc vide.
  - Sur un nouveau clone dont les WADL ont changé depuis le verrou, la référence est déclarée inconnue (`baseline: "unknown"`, comptes `null`) plutôt que de donner un faux résultat.
  - Un `--update-lock` qui ne change ni version, ni fichiers, ni opérations laisse le verrou intact.
- **CI.** Avec `CI=true`, les listes d'opérations (différences, décisions obsolètes) sont remplacées par leur nombre.

## CI (GitHub Actions)

Le workflow `.github/workflows/ci.yml` comprend deux jobs :

- **`static`** : format, lint, types, tests, couverture et recherche de secrets, sur un runner GitHub-hosted, sans secret.
- **`catalog-and-package`** : récupération des WADL, génération et vérification du catalogue, build, test de fumée en lecture seule, création et conservation du paquet.

**Environnement `jira`.** Le job `catalog-and-package` exécute le code de la branche (scripts, `package.json`) avec le PAT, éventuellement sur un runner situé dans le réseau interne. Ses secrets sont donc rangés dans un environnement GitHub protégé, et non au niveau du dépôt :

1. Créez l'environnement `jira` (_Settings › Environments › New environment_).
2. Déplacez-y les secrets `JIRA_READONLY_PAT` et `JIRA_BASE_URL`, puis supprimez-les des secrets du dépôt.
3. Activez **Required reviewers** : chaque exécution du job attend l'approbation d'une autre personne avant qu'une étape ne reçoive le PAT.
4. Dans **Deployment branches and tags**, choisissez **Protected branches only** : une branche non protégée ne peut pas atteindre les secrets. C'est pourquoi le job Jira ne s'exécute que pour les pushes sur `main` et les lancements manuels sur une branche protégée, jamais pour une pull request : l'environnement la refuserait (exécution en échec au lieu d'être ignorée).

**À configurer** (_Settings › Environments_ pour les secrets, _Settings › Secrets and variables › Actions_ pour les variables). Tous les noms sont des exemples, à adapter :

| Type                             | Nom                 | Contenu                                                                            |
| -------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| Secret de l'environnement `jira` | `JIRA_READONLY_PAT` | PAT d'un compte Jira sans droit d'écriture                                         |
| Secret de l'environnement `jira` | `JIRA_BASE_URL`     | URL de l'instance (un secret, pour être masquée dans les journaux)                 |
| Variable                         | `JIRA_CI_ENABLED`   | `true` pour activer le job Jira                                                    |
| Variable                         | `SMOKE_PROJECT`     | clé d'un projet lisible par ce compte                                              |
| Variable                         | `JIRA_RUNNER_LABEL` | label du runner du job Jira (par défaut `ubuntu-latest`)                           |
| Variable                         | `PUBLISH_ARTIFACT`  | `true` pour conserver le paquet comme artefact (dépôt privé ou interne uniquement) |

**Runner self-hosted.** Il est nécessaire dans deux cas :

- l'instance n'est pas joignable depuis Internet ;
- elle utilise une autorité de certification privée.

Placez alors le runner dans un réseau qui atteint l'instance, installez l'autorité dans son magasin système, et indiquez son label dans `JIRA_RUNNER_LABEL`. De préférence, utilisez un runner éphémère, ou réservez son groupe de runners à ce dépôt et à ce workflow : son espace de travail persiste sinon d'un job à l'autre.

Si `JIRA_CI_ENABLED` ne vaut pas `true`, le job Jira est ignoré ; il l'est aussi pour toutes les pull requests et pour Dependabot. Une pull request n'exécute que le job `static`, sans secret.

**Paquet.** Le job crée le paquet avec `npm run package` (recompilation complète de `dist/`), puis `scripts/check-package.ts` vérifie son contenu : fichiers attendus présents (`package.json`, `README.md`, `dist/index.js` avec sa ligne `#!/usr/bin/env node`, `dist/catalog/load.js`, `catalog/catalog.json`), aucun fichier hors liste, ni PAT, ni nom d'hôte de l'instance.

## Versions et dépendances

**Dependabot** (`.github/dependabot.yml`) ouvre chaque lundi des pull requests de mise à jour :

- **npm** : la version épinglée est remplacée par la nouvelle (`versioning-strategy: increase`, les versions restent exactes) ; les mises à jour mineures et correctives des outils de développement sont regroupées dans une seule pull request, les dépendances d'exécution (`@modelcontextprotocol/server`, `zod`) arrivent séparément ;
- **GitHub Actions** : les actions des workflows, regroupées.

Ces pull requests n'exécutent que le job `static` (format, lint, types, tests, recherche de secrets), sans aucun secret. Relisez le journal des modifications d'une dépendance d'exécution avant de fusionner. Activez aussi les _Dependabot alerts_ et _security updates_ dans _Settings › Code security_ pour recevoir les alertes de vulnérabilité.

**Publier une version** (workflow `.github/workflows/release.yml`) :

1. Sur `main` à jour, avec une CI verte : `npm version patch` (ou `minor`, `major`, `prerelease --preid rc`). La commande met à jour `package.json` et `package-lock.json`, crée le commit et le tag `v<version>`.
2. Poussez le commit et le tag : `git push --follow-tags`.
3. Le workflow `release`, déclenché par le tag `v*.*.*` :
   - vérifie que le tag correspond à la version de `package.json` ;
   - relance `npm run check` ;
   - retire `"private": true` de `package.json`, crée le paquet avec `npm run package` et le contrôle (`check-package` : fichiers attendus, catalogue présent et accepté par le serveur, aucun secret) ;
   - publie ce paquet sur GitHub Packages (`@agrica/jira-api2-mcp`, étiquette `latest`, ou `next` pour une pré-version) ;
   - crée la release GitHub, avec des notes générées à partir des pull requests et sans fichier joint : le paquet s'installe depuis GitHub Packages (méthode B). Un tag contenant `-` (par exemple `v1.2.0-rc.1`) produit une _pre-release_.

Le workflow n'utilise aucun secret Jira, seulement le jeton GitHub avec les droits `contents: write` et `packages: write`. Le paquet publié contient le catalogue versionné, tel qu'il est dans le commit du tag : régénérez-le (`catalog:fetch`, `catalog:build`) et commitez-le avant de publier une version.

`package.json` reste marqué `"private": true` dans le dépôt : un `npm publish` lancé depuis un poste, où un catalogue a pu être généré, est refusé. Seul le workflow `release`, qui ne génère jamais de catalogue, lève cette protection.

## Développement

| Commande                                           | Effet                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                                      | lance le serveur depuis les sources, avec rechargement                                       |
| `npm run build` / `npm start`                      | vide puis recompile `dist/` / lance le serveur compilé                                       |
| `npm run clean`                                    | supprime `dist/`                                                                             |
| `npm run package`                                  | recompile `dist/` puis crée le paquet `agrica-jira-api2-mcp-<version>.tgz` (voir ci-dessous) |
| `npm test` / `npm run test:watch`                  | tests (sans Jira ni catalogue généré), une fois / en continu                                 |
| `npm run coverage`                                 | tests avec couverture (seuils : 90 % lignes, fonctions, instructions ; 85 % branches)        |
| `npm run format` / `npm run format:check`          | met en forme / vérifie la mise en forme (oxfmt)                                              |
| `npm run lint` / `npm run typecheck`               | oxlint / contrôle des types                                                                  |
| `npm run secrets:scan`                             | cherche des secrets dans les fichiers suivis et non ignorés par git                          |
| `npm run check`                                    | format, lint, types, couverture, recherche de secrets                                        |
| `npm run verify`                                   | `check` + `catalog:check`                                                                    |
| `npm run smoke`                                    | test de fumée réel en lecture seule (après `npm run build` ; `SMOKE_PROJECT` requis)         |
| `npm run catalog:fetch`, `build`, `check`, `drift` | catalogue : voir « Installation » et « Catalogue et revue »                                  |

**Paquet local.** `.npmrc` contient `ignore-scripts=true` (aucun script de dépendance ne s'exécute à l'installation) ; un simple `npm pack` saute donc le script `prepack` et emballerait `dist/` tel quel, éventuellement périmé. Utilisez `npm run package`, qui lance `npm pack --ignore-scripts=false` : `prepack` recompile alors `dist/` à partir de zéro. Sans catalogue généré, contrôlez le paquet avec `node scripts/check-package.ts --no-catalog agrica-jira-api2-mcp-<version>.tgz` (la CI, elle, exige le catalogue).

**Règle d'or :** stdout est le canal MCP. N'utilisez jamais `console.log` (oxlint le refuse).

## Dépannage

| Symptôme                                                       | Cause probable et solution                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration — JIRA_BASE_URL: …`                     | URL absente ou invalide, ou `http://` sans `JIRA_ALLOW_INSECURE_HTTP=true`.                                                  |
| `Operation catalog not found at …`                             | `catalog/catalog.json` absent : voir « Installation », ou définir `JIRA_CATALOG_PATH`.                                       |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | Autorité de certification privée non visible de Node : `--use-system-ca` ou `NODE_EXTRA_CA_CERTS`.                           |
| `ENOTFOUND`, `ECONNREFUSED`, délai dépassé                     | Instance non joignable : réseau, VPN ou proxy (`HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1`).                           |
| `unexpected HTML response instead of JSON`                     | Un proxy d'authentification ou un SSO répond à la place de Jira : vérifiez `JIRA_BASE_URL` (chemin de contexte) et le proxy. |
| `redirects are refused`                                        | Jira ou un proxy redirige (souvent vers une page de connexion) : vérifiez `JIRA_BASE_URL` et le SSO.                         |
| `may already have been applied by Jira`                        | L'écriture a pu être appliquée : vérifiez son état dans Jira avant de la relancer.                                           |
| 401                                                            | PAT invalide ou expiré.                                                                                                      |
| 403                                                            | Le compte du PAT n'a pas la permission Jira nécessaire.                                                                      |
| Les outils d'écriture n'apparaissent pas                       | `JIRA_ALLOW_WRITES` n'est pas à `true` (lecture seule par défaut).                                                           |
| Opération Xray refusée ou absente                              | `JIRA_ENABLE_XRAY` n'est pas à `true`, ou le plugin Xray n'était pas installé lors de la génération du catalogue.            |
| `catalog:check` échoue                                         | Verrou absent ou différent de l'instance, ou candidat non revu : voir « Catalogue et revue ».                                |

## Notes Jira Server / Data Center

- **API v2.** Textes en wiki markup (pas ADF), utilisateurs identifiés par `name`.
- **Champs personnalisés.** Leurs identifiants (`customfield_NNNNN`) varient d'une instance à l'autre : retrouvez-les avec `jira_list_fields` (par exemple `query: "sprint"`).
- **`editmeta` vide.** Si `editmeta` est vide pour un ticket, la modification passe par une transition : `jira_get_transitions` avec `includeFields: true`, puis `jira_transition_issue`.
