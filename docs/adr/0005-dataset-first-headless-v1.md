# ADR-0005 — Gate V1 dataset-first et headless

- Statut : **Accepté**
- Date : **2026-07-19**
- Révisé : **2026-07-20**
- Décideur : Leandre Desmaretz
- RFC liés : [RFC-0003](../rfcs/0003-dataset-first-headless-v1.md),
  [RFC-0004](../rfcs/0004-headless-transport-slices.md),
  [RFC-0005](../rfcs/0005-recipe-apply-rest-sdk-cli.md),
  [RFC-0006](../rfcs/0006-recipe-application-watch.md),
  [RFC-0007](../rfcs/0007-recipe-application-export.md)

## Contexte

La gate précédente exigeait la plateforme générique, quatre surfaces clientes,
une console, HITL et délégation avant de prouver le parcours dataset attendu.
[RFC-0003](../rfcs/0003-dataset-first-headless-v1.md) conserve l'analyse et
les compromis du pivot produit.

## Décision

La V1 OSS est un moteur headless d'enrichissement de datasets : import JSONL ou
CSV, recette versionnée par champ, run durable, résultat de cellule traçable et
export. API et CLI doivent appeler les mêmes use cases. Le SDK TypeScript est
leur client partagé ; MCP est P1 et la console P2.

Le modèle public local ajoute `Dataset`, `Field`, `Record`,
`EnrichmentRecipe` et `CellResult`, sans dupliquer `Run`. Ni LLM, ni service
Kurobara Cloud, ni UI n'est obligatoire. HITL et délégation restent des capacités
architecturales ultérieures, pas des critères de la première release.

La compatibilité agentique porte sur les surfaces API/CLI neutres. La gate exige
au moins une exécution réelle par un coding agent, pas la qualification
simultanée de chaque outil cité comme exemple ; les autres résultats alimentent
une matrice de compatibilité non bloquante.

La première surface entrante acceptée est `datasets.import@1.0.0` :
`POST /v1/dataset-imports` reçoit un multipart ordonné `metadata` puis `source`.
Le SDK TypeScript porte le client streaming commun et la CLI le consomme via
`dataset import`. Cette décision reste locale et expérimentale ; elle ne publie
ni package, ni endpoint hébergé, ni surface MCP.

La deuxième surface est `recipes.apply@1.0.0` : un `application_id` stable
enregistre ou rejoue la recette et son graphe, puis réconcilie chaque cellule
vers un run durable, un calcul partagé, un cache frais ou une liaison existante.
Quote, input validé, run, événement, outbox, `CellResult` et liaison sont
atomiques par cellule ; aucune transaction globale ni second lifecycle
d'application n'est introduit. Le budget public est explicitement un budget par
cellule. Une application interrompue reprend par replay de la même intention.

La troisième surface est `recipe-applications.get@1.0.0`. Elle projette un
snapshot PostgreSQL agrégé sans créer de lifecycle d'application. Le SDK porte
la lecture commune et `recipe watch` la poll avec timeout explicite. Un calcul
exact déjà actif est lié durablement à chaque application observatrice avant le
retour d'apply ; aucune seconde exécution ni dépense n'est créée. SSE reste une
décision et une tranche distinctes.

La quatrième surface est `recipe-applications.export@1.0.0`. Elle prévalide
puis streame l'overlay exact CSV ou JSONL depuis l'état durable, avec longueur
et SHA-256 vérifiés. Ce download éphémère ne crée ni artifact, ni `export_id`,
ni rétention ; le lifecycle d'export durable d'API-002 reste une décision et
une tranche séparées.

## Conséquences

- les tickets produit KRB pilotent désormais le chemin critique ;
- les fondations runtime déjà livrées sont réutilisées, pas remplacées ;
- les providers doivent converger vers la même capability et le même résultat ;
- les gates roadmap, architecture, backlog et QA doivent rester alignées ;
- toute future rupture des primitives publiées suit un nouveau RFC et une
  version majeure.
