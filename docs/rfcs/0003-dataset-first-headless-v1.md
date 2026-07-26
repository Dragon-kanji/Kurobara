# RFC-0003 — V1 dataset-first headless

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: unassigned
- Created: 2026-07-19
- Clarified: 2026-07-20
- Supersedes: none
- Related ADRs: ADR-0005

## Summary

La V1 OSS de Kurobara est un moteur headless d'enrichissement de datasets,
pilotable par API et CLI. Un opérateur ou un coding agent importe des records,
applique des recettes versionnées par champ, suit des runs durables et exporte
des résultats avec statut, provenance, fraîcheur, confiance et coût.

Le SDK TypeScript reste le client partagé. MCP devient une projection P1 après
preuve API/CLI ; la console devient P2. Planner LLM, human-in-the-loop et
délégation multi-agent restent compatibles avec l'architecture, mais ne bloquent
plus la première release utile.

## Problem

La gate précédente additionnait runtime durable, console, quatre surfaces
clientes, signaux humains et délégation avant de prouver le premier usage
produit. Elle décrivait bien une plateforme générique, mais pas le parcours
prioritaire : un équivalent headless d'une table d'enrichissement qu'un agent de
code peut piloter sans interface graphique.

Cette largeur retardait la validation du besoin, mélangeait fondation et produit
et rendait possible une V1 techniquement riche sans import, recette ou export de
dataset réellement utilisable.

## Goals and non-goals

### Goals

- fixer `Dataset`, `Field`, `Record`, `EnrichmentRecipe` et `CellResult` ;
- réutiliser le `Run`, les budgets, l'idempotence et la reprise existants ;
- fournir import/export JSONL et CSV bornés ;
- prouver un vertical par champ avec deux providers BYOK comparables ;
- obtenir la même logique métier via API et CLI non interactives ;
- permettre à des coding agents, notamment Codex ou Claude Code, d'opérer le
  parcours sans parsing d'UI.

### Non-goals

- rendre une UI obligatoire ;
- imposer un modèle ou un planner LLM ;
- exiger MCP, un signal humain ou une délégation pour passer la gate ;
- exécuter du code communautaire arbitraire ;
- ajouter une abstraction de table distribuée ou un moteur de recherche interne.

## Proposal

Le chemin critique devient :

```text
Dataset + Fields + Records
→ EnrichmentRecipe vers un Field cible
→ WorkflowSpec / RunPlan / Run existants
→ CellResult par record et champ
→ export JSONL ou CSV
```

La première capability résout le site officiel d'une organisation depuis son
domaine. Elle ne nomme aucun provider dans son contrat. Exa et Tavily sont
qualifiés séparément derrière la même capability, puis un fallback réel prouve
que la forme du résultat ne dépend pas du fournisseur.

Une recette possède sa propre révision et référence l'identité exacte du
workflow : identifiant, révision et hash de contenu. Elle cible un seul champ et
déclare au moins un champ d'entrée. Une autre cible utilise une autre recette ;
le DAG existant porte leurs dépendances.

## Public contracts and compatibility

Les cinq primitives partent de JSON Schema Draft 2020-12 et restent
`local-development-only` tant que le gate de publication du namespace n'est pas
franchi. Leur présence ne crée aucune route.

- les valeurs V1 sont `string`, `number`, `boolean` ou `null` explicite ;
- l'absence d'un champ reste distincte de `null` ;
- les objets et tableaux imbriqués sont différés ;
- `CellResult` référence le `run_id` canonique et le couple exact
  `recipe_id` + `recipe_revision`, sans dupliquer `Run` ;
- son statut est `pending`, `running`, `succeeded`, `failed` ou `skipped` ;
- les états terminaux portent valeur ou raison selon leur issue ;
- l'unicité des `field_id` et la cohérence cross-object sont des invariants du
  kernel et des use cases, car JSON Schema ne les exprime pas seuls proprement.

Une incompatibilité avant publication peut réviser ces schémas locaux avec les
fixtures et outputs générés. Après publication, elle exige une nouvelle version
majeure conformément à ADR-0004.

## Security, privacy and agent authority

Le pivot ne réduit pas l'autorité bornée. Un run conserve workspace, permissions,
budget, deadline, routes autorisées et conditions d'arrêt. Les credentials BYOK
restent des références de secrets et les erreurs de cellule sont expurgées.

Un agent consomme l'API ou la CLI comme n'importe quel client. Il n'accède ni à
PostgreSQL, ni à Hatchet, ni aux secrets, ni à un provider hors des ports et
policies existants. Aucun LLM n'est requis pour exécuter une recette déterministe.

La gate vérifie donc des surfaces agent-neutral et au moins un parcours réel
non interactif. Elle n'impose pas la qualification simultanée de chaque outil de
coding agent cité en exemple ; leurs résultats restent consignés séparément
dans la matrice de compatibilité.

## Data, operations and rollback

Le codec traite un record borné à la fois et ne génère pas son identité. La
persistance future impose l'unicité `(workspace, dataset, record)` et committe
les imports par lots bornés. Les exports conservent l'ordre fourni par la lecture
durable ; ils ne trient pas tout le dataset en mémoire.

Tant qu'aucune route ou migration publique ne consomme les nouveaux schémas, un
rollback retire la fondation produit et régénère le catalogue. Après persistance,
le rollback doit préserver la lecture des datasets existants et suit un RFC de
migration dédié.

## Alternatives

- **Finir d'abord la plateforme générique** : rejeté, car elle ne valide pas le
  parcours dataset prioritaire.
- **Faire de MCP la surface principale** : différé ; CLI/API sont plus simples à
  tester, automatiser et consommer depuis plusieurs agents.
- **Commencer par une console** : rejeté pour la gate ; elle peut consommer les
  mêmes use cases après preuve headless.
- **Accepter du JSON imbriqué dès V1** : différé pour garder CSV, validation et
  mapping par champ explicites.

## Risks

- la limite scalaire devra évoluer si le vertical requiert des listes ou objets ;
- le mapping d'une recette vers le workflow durable n'est pas encore livré ;
- une API/CLI minimale peut rester peu ergonomique sans exemples agent réels ;
- reporter HITL et délégation ne doit pas affaiblir deadline, budget ou arrêt sûr.

## Verification plan

1. contrats et types générés sans drift ;
2. invariants kernel testés sans I/O ;
3. roundtrip JSONL/CSV streaming, `null` et backpressure prouvés ;
4. import persistant et reprise sans double calcul ;
5. provider primaire puis fallback sur la même capability ;
6. parité API/CLI, exemples Codex/Claude Code et au moins une exécution réelle
   par un coding agent ;
7. clone vierge vers export final sans UI, cloud ou LLM.

## Open questions

- format et borne des valeurs structurées post-V1 ;
- stratégie d'import atomique et de reprise pour les gros fichiers ;
- moment où MCP apporte plus de valeur qu'un appel CLI/API structuré.

## Decision

**Accepted — 2026-07-19.** La gate V1 devient dataset-first et headless. API et
CLI sont bloquantes ; SDK est partagé ; MCP, console, planner LLM, HITL et
délégation restent hors gate. Les garanties de kernel pur, Run durable, budget,
idempotence, provenance, fallback, annulation, isolation workspace et absence de
dépendance au service managé restent applicables.

**Clarification — 2026-07-20.** La mention de Codex et Claude Code exprime une
cible d'interopérabilité, pas une double dépendance de release. Le candidat doit
prouver ses surfaces agent-neutral avec au moins un coding agent réel ; la
qualification d'autres outils complète la matrice sans bloquer la V1.
