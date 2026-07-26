# RFC-0005 — Application agrégée d'une recette

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-19
- Supersedes: none
- Related ADRs: ADR-0005

## Summary

Ce RFC fixe la deuxième tranche du parcours headless local :
`recipes.apply@1.0.0` enregistre ou rejoue une recette immuable, crée une
application bornée sur un dataset importé et garantit qu'une passe de fan-out
aboutit, pour chaque cellule, à un `Run` durable, une liaison de cache ou une
liaison déjà existante.

La même opération est projetée en `POST /v1/recipe-applications`,
`recipes.apply()` dans le SDK TypeScript et `recipe apply` dans la CLI. MCP,
watch, export, provider, cloud, publication et déploiement restent hors de cette
tranche.

## Problem

Les primitives recette existent déjà, mais leur composition exige plusieurs
appels internes : enregistrer la recette, figer son graphe de records, résoudre
l'input exact, produire un `RunPlan`, persister cet input puis créer et lier le
`Run`. Exposer ces étapes séparément obligerait un opérateur CLI ou un agent à
reproduire des règles métier et laisserait un intervalle de panne entre le plan
et le run.

Une transaction globale sur jusqu'à 10 000 cellules serait, à l'inverse, trop
longue et empêcherait une reprise progressive. La frontière publique doit donc
porter une identité stable et conserver l'atomicité au niveau où se trouve
l'effet durable : une cellule.

## Goals and non-goals

### Goals

- définir une identité publique `recipes.apply@1.0.0` commune à REST, SDK et
  CLI ;
- faire de `application_id` la clé stable de reprise et de conflit d'intention ;
- enregistrer idempotemment la révision exacte de recette fournie ;
- créer un `Run` canonique par cellule à calculer, sans second lifecycle ;
- persister dans une même transaction par cellule le plan, l'input validé, le
  run, l'événement, l'outbox, le `CellResult` et la liaison de cache ;
- borner le fan-out et conserver budget, deadline, autorité et provenance du
  dataset dans chaque plan ;
- retourner un résumé JSON stable d'une passe de réconciliation ;
- rester local, expérimental et sans appel provider.

### Non-goals

- exécuter ou attendre les runs dans la requête HTTP ;
- créer un job agrégé ou un second orchestrateur d'application ;
- garantir qu'une cellule observée `active` sera liée sans nouvelle passe ;
- ajouter watch, SSE, annulation, export ou MCP ;
- agréger les coûts réels de plusieurs runs dans un nouveau ledger ;
- publier ou stabiliser les packages et endpoints.

## Proposal

### Contrat canonique

`RecipesApplyRequest@1.0.0` contient :

- `application_id`, identité choisie par le client et réutilisée pour reprendre ;
- `authority_envelope_id` ;
- `cell_budget`, limite et unité appliquées séparément à chaque `Run` ;
- `deadline_ms`, deadline absolue partagée puis bornée par l'autorité ;
- `max_cells`, limite positive au plus égale à 10 000 ;
- `recipe`, une `EnrichmentRecipe@1.0.0` complète.

Le workspace n'est jamais choisi séparément : il provient de la clé API
vérifiée et doit correspondre au workspace de la recette et du dataset.
L'acteur authentifié doit porter `recipes:register`, `recipes:apply` et
`plans:quote`. L'enveloppe d'autorité doit porter `recipes:apply` et
`plans:quote`, en plus de couvrir le budget, la deadline et les capabilities du
workflow.

La réponse identifie l'application et la recette, puis compte les cellules de
la passe : runs créés, calculs actifs partagés, résultats de cache liés et
liaisons déjà présentes. La somme de ces quatre compteurs est égale au nombre
total de cellules. Les indicateurs de replay de recette et d'application
décrivent la passe courante ; ils n'autorisent aucun raccourci de validation.

### Sémantique de reprise

La première étape enregistre la recette immuable puis le graphe ordonné de
l'application. Rejouer le même `application_id` avec la même intention relit ce
graphe. Une divergence de dataset, recette, révision, limite ou records retourne
le conflit d'idempotence canonique sans écraser l'état existant.

Le fan-out parcourt ensuite le graphe séquentiellement et avec une mémoire
bornée. Chaque cellule est réconciliée ainsi :

1. une liaison existante est un no-op ;
2. un résultat frais est épinglé comme cache ;
3. un calcul portant la même identité exacte est rapporté `active` ;
4. sinon l'input exact est validé, quoté, persisté et consommé par un nouveau
   `Run` dans une transaction PostgreSQL unique.

Une panne après certaines cellules ne les annule pas et ne duplique pas leurs
effets. Le client rejoue la même requête : les cellules liées deviennent des
no-op et seules les cellules restantes avancent. Aucun plan non consommé n'est
laissé par l'intervalle quote/création, puisque cet intervalle se trouve dans la
même transaction de cellule.

Une cellule `active` peut appartenir à une autre application concurrente. Cette
tranche ne crée pas de watcher durable : après terminaison du run partagé, une
nouvelle passe avec le même `application_id` épingle le résultat s'il est encore
frais.

### Validation de l'input exact

Le catalogue ajoute `RecipeCellInput@1.0.0`, schéma JSON canonique de l'input
normalisé construit depuis le record, les champs source, la recette et la
révision de workflow. Un workflow utilisable par `recipe apply` référence
exactement ce contrat dans son snapshot. L'API enregistre ce schéma auprès du
validator JSON Schema ; elle ne marque pas un payload interne comme validé par
simple assertion de type.

### Projections

- REST : `POST /v1/recipe-applications`, requête et succès JSON ;
- SDK TypeScript : `client.recipes.apply(request)` ;
- CLI : `recipe apply --request <file>`, sortie JSON sur stdout, problèmes JSON
  sur stderr et codes de sortie issus du catalogue ;
- MCP : projection différée, sans tool exécutable dans cette tranche.

## Public contracts and compatibility

Les nouveaux schémas et l'opération commencent en `1.0.0`, restent
`local-development-only` et utilisent le namespace `.invalid`. Le chemin REST,
les noms de champs, la portée par cellule du budget, l'identité de reprise et la
sémantique des compteurs sont donc des choix versionnés.

La réponse décrit une passe de réconciliation et peut évoluer entre deux appels
si un run concurrent termine. L'idempotence garantit l'absence de duplication
de l'intention et des effets durables ; elle ne fige pas une photographie
obsolète de l'application.

## Security, privacy and agent authority

L'adapter HTTP dérive acteur, permissions, workspace et corrélation de la clé
vérifiée et du contexte serveur. Ni la CLI ni le SDK ne peuvent injecter un
acteur. La recette, l'application, le dataset, les records, les snapshots et les
runs restent qualifiés par le même workspace.

`max_cells`, `cell_budget` et `deadline_ms` bornent explicitement l'autorité
d'une commande agentique. Cette tranche n'appelle aucun provider ; les runs
créés restent soumis aux contrôles d'autorité, de routing, de coût et de deadline
du worker lorsqu'ils seront exécutés. Les problèmes publics ne contiennent ni
valeur de cellule, ni record brut, ni secret.

## Data, operations and rollback

PostgreSQL conserve la recette, le graphe d'application, les plans, inputs,
runs et liaisons. L'API ne garde aucun progrès en mémoire après la réponse et ne
transforme pas Hatchet en source de vérité métier.

Une transaction globale n'est pas utilisée. La reprise est monotone par
cellule, mais la création initiale de la recette et de l'application peut rester
visible même si aucune cellule n'a encore été dispatchée. Cet état est sûr et
reprenable avec la même intention.

Tant que la surface reste locale et expérimentale, un rollback peut retirer les
adapters entrants. Il doit préserver les données déjà persistées et les runs
créés ; supprimer une application ou réécrire une recette immuable n'est pas une
compensation autorisée.

## Alternatives

- **Exposer register, plan et create au client** : rejeté, car cela duplique la
  logique d'application dans chaque opérateur.
- **Une transaction pour tout le dataset** : rejeté, car sa durée croît avec le
  fan-out et rend la reprise coûteuse.
- **Un job agrégé durable dès maintenant** : différé jusqu'au besoin réel de
  progression autonome ; les `Run` restent le lifecycle canonique.
- **Un budget agrégé implicite** : rejeté ; le contrat nomme explicitement le
  budget par cellule au lieu de promettre un ledger inexistant.
- **Retourner seulement l'identifiant** : rejeté, car un agent a besoin de savoir
  si une nouvelle passe est requise pour les cellules actives.

## Risks

- une requête portant plusieurs milliers de cellules peut durer longtemps ; sa
  reprise reste sûre, mais un futur job/cursor durable pourra devenir nécessaire
  pour une progression autonome ;
- plusieurs runs possèdent chacun leur budget ; cette tranche ne remplace pas le
  futur contrôle de budget agrégé entre applications concurrentes ;
- une cellule `active` demande une nouvelle passe après terminaison tant que
  watch n'est pas livré ;
- SDK et CLI restent privés et non distribués.

## Verification plan

1. compiler et rejouer sans drift les schémas, OpenAPI, types et métadonnées
   CLI, tout en gardant MCP différé ;
2. tester validation, permissions, workspace, limite, deadline, budget et
   conflits d'intention dans l'application ;
3. injecter une faute entre deux cellules puis prouver qu'un replay ne crée pas
   un second run pour la première ;
4. prouver sur PostgreSQL l'atomicité plan/input/run/outbox/CellResult et le
   rollback complet d'une cellule rejetée ;
5. appeler la même intention par HTTP brut, SDK et CLI contre l'API loopback et
   relire les compteurs durables ;
6. tester deux applications concurrentes sur la même identité de cache ;
7. exécuter check, tests, typecheck, build et `git diff --check` sous les
   versions Node/npm qualifiées.

## Open questions

- le seuil de volume ou de latence qui justifiera un cursor/job d'application
  durable ;
- la forme du budget agrégé multi-run et sa réservation concurrente ;
- la politique de relance automatique des cellules `active` après watch.

## Decision

**Accepted le 2026-07-19.** Le decision owner retient une commande agrégée
locale identifiée par `application_id`, un budget explicitement par cellule et
une transaction indépendante par cellule couvrant quote, input et création de
run. La reprise est pilotée par replay de la même intention ; aucun job agrégé,
watch, export, MCP, provider, cloud ou publication n'entre dans cette décision.
