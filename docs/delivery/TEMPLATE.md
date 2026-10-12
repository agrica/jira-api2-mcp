# Livraison jira-api2-mcp <version> — <AAAA-MM-JJ>

| Élément                        | Valeur                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Jira (verrou)                  | <jiraVersion> (build <jiraBuildNumber>), WADL du <fetchedAt>                                      |
| Opérations                     | api <n> / agile <n> / xray <n>                                                                    |
| Empreinte des opérations       | <operationsSha256 (12 premiers caractères)>                                                       |
| Dernier changement             | +<added> −<removed> ~<changed> (ou « référence inconnue » si la référence n'était pas disponible) |
| Candidats à la revue           | <total> — tous décidés : oui/non                                                                  |
| GET non revus individuellement | <n>                                                                                               |
| `npm run verify`               | OK / KO                                                                                           |
| `npm run catalog:drift`        | pas de dérive / dérive                                                                            |
| `npm run smoke`                | PASS / FAIL                                                                                       |
| Exécution GitHub Actions       | <identifiant de l'exécution>                                                                      |

## Risque résiduel accepté : GET non revus individuellement

Les <n> GET non revus individuellement sont classés `read` par la règle par défaut. Un GET à effet de bord dont le chemin ne contient aucun mot-clé révélateur ne serait pas signalé.

Mesures en place :

- revue des candidats ;
- marquage `not individually reviewed` ;
- PAT aux permissions limitées pour les usages en lecture.

Risque accepté par : <nom, rôle> — le <date>
