# RFC-0001 — Baseline V1 des modules, contrats et cycles de vie

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: unassigned
- Created: 2026-07-17
- Supersedes: none
- Related ADRs: ADR-0001, ADR-0002, ADR-0003, ADR-0004

## Summary

Ce RFC enregistre une baseline cohérente pour les trois fondations qui précèdent
l'implémentation V1 : frontières du monolithe modulaire, système de contrats
canoniques et domaine des workflows/runs. Les spécifications détaillées sont :

- [frontières des modules](../architecture/module-boundaries.md) ;
- [système de contrats](../architecture/contract-system.md) ;
- [domaine et cycles de vie](../architecture/domain-lifecycle.md).

Le RFC ne livre aucun package, schéma, générateur, runtime, migration ou test.
Son état `Accepted` fixe les choix de conception détaillés sans présenter leurs
packages, schémas, générateurs, contrôles ou runtimes comme déjà livrés.

## Problem

L'architecture V1 et les ADR fixent déjà les principes : kernel pur, PostgreSQL
comme vérité métier, orchestration derrière un port, JSON Schema canonique,
parité REST/SDK/CLI/MCP et autorité agentique bornée. Ils ne suffisent toutefois
pas à empêcher plusieurs implémentations incompatibles sur des points concrets :

- quels packages peuvent s'importer et qui possède les transactions ;
- ce que produit exactement le compilateur de workflow ;
- où se terminent le domaine interne et le contrat public ;
- comment versions, fingerprints et projections restent cohérents ;
- si une quote crée déjà un run ou précède sa création ;
- quelles transitions sont admises et comment retry, signal, annulation ou
  ambiguïté affectent l'état ;
- comment une opération publique atteint le même use case sur chaque surface.

Sans baseline commune, le prototype pourrait être découpé en packages tout en
conservant les mêmes dépendances implicites, ou les clients pourraient générer
des modèles identiques en forme mais divergents en comportement.

## Goals and non-goals

### Goals

- définir un graphe de dépendances testable et des composition roots minces ;
- définir une source contractuelle unique et un pipeline reproductible ;
- définir un vocabulaire de domaine et des machines d'état fermées ;
- rendre le parcours `WorkflowSpec → CompiledWorkflow → RunPlan → Run`
  univoque ;
- préserver budget, idempotence, autorité, provenance et résultat ambigu ;
- donner à chaque future preuve d'implémentation un scénario d'acceptation.

### Non-goals

- implémenter l'outil de contrôle des imports ou ses tests négatifs ;
- implémenter les générateurs et leurs adapters de runtime ;
- définir migrations SQL, tables physiques ou API Hatchet ;
- publier une route, un package ou une version supportée ;
- publier les contrats avant preuve du contrôle de leur namespace.

## Proposal

### 1. Frontières de modules

La V1 reste un monolithe modulaire distribué en trois processus serveur :
`web`, `api` et `worker`. CLI et MCP sont des composition roots clientes qui
passent par le SDK HTTP ; elles n'importent pas l'application.

Le graphe retenu suit ces règles :

- `kernel` ne dépend d'aucun workspace Kurobara et ne réalise aucune I/O ;
- `workflow-engine` et `policy-engine` dépendent seulement du kernel ;
- `ports` dépend du kernel, jamais de ses implémentations ;
- `application` orchestre use cases, policies et transactions à travers les
  ports ;
- `contracts` reste indépendant du modèle objet interne ;
- les adapters entrants mappent contrat public et commande applicative ;
- les adapters sortants implémentent des ports sans importer l'application ;
- seuls les composition roots choisissent les adapters concrets ;
- le service managé peut consommer le cœur public, jamais l'inverse.

#### Enforcement automatisé des frontières

`ARCH-001` retient `dependency-cruiser` 18.x comme contrôle canonique initial du
graphe d'imports. Sa configuration encode la matrice par défaut interdit,
analyse les chemins résolus avec les dépendances TypeScript pré-compilation et
applique les mêmes règles aux imports de valeur, de type, aux réexports et aux
imports dynamiques à spécificateur littéral.

Les packages sont résolus par les liens npm workspaces et leurs `exports`. Un
tsconfig dédié fournit les alias internes à l'analyse sans rendre public un
subpath absent des `exports`. Tout code généré consommé par le build est contrôlé
après génération ; seuls dépendances tierces, outputs de build et caches sont
exclus. Les imports dynamiques ou `require` à spécificateur calculé sont
interdits par un contrôle AST complémentaire fondé sur TypeScript.

Le même crawl produit le diagnostic CI et un graphe Mermaid collapsé au niveau
workspace. Tout assouplissement normatif de la matrice suit le processus RFC.
Une exception de migration reste explicite, datée, reliée à un ticket et doit
avoir disparu pour clore `ARCH-001`.

### 2. Compilation et planification

Le workflow engine produit un `CompiledWorkflow` déterministe à partir d'une
spécification interne validée et d'une allowlist préautorisée. Il ne connaît ni
provider, ni quote, ni budget, ni credential, ni autorité active.

La couche application compose ensuite un `RunPlan` immuable avec :

- le DAG compilé ;
- les références exactes de contrats ;
- policy, faits et décisions de routage ;
- quote et version de prix ;
- budget, deadline, retries et timeouts ;
- enveloppe d'autorité et limites de délégation.

Cette séparation empêche le compilateur pur de devenir un use case qui lit
registries, santé, prix ou permissions.

### 3. Ownership de la quote et du run

La décision retient la sémantique suivante :

1. `plans.quote` prépare un `RunPlan` et une `CostQuote` sans créer de `Run` ni
   de `run_id` ;
2. `runs.create` accepte une référence de plan, vérifie quote, budget, deadline,
   autorité et idempotence, puis crée directement le run en `queued` ;
3. run, `RunQueued` et première outbox deviennent visibles atomiquement ;
4. une quote expirée empêche la création et reste un fait de planification ;
5. la V1 autorise un seul run logique par plan : une redelivery retourne ce run,
   une nouvelle création avec une autre clé produit un conflit.

Il n'existe donc aucun run `quoted` ou `expired`. Ces notions appartiennent au
plan et à la quote, pas à la machine d'états du run.

Une instance de `RunPlan` est single-use. L'unicité métier porte sur
`run_plan_id`; l'idempotence sur `(workspace_id, operation_id, idempotency_key)`
et sur un hash de l'intention normalisée. Même clé et même intention retournent
la réponse initiale ; même clé et autre intention produisent
`idempotency-key-reused` ; une autre clé visant un plan consommé produit
`run-plan-already-consumed`. Le plan, la clé, le run, `RunQueued` et l'outbox ne
sont consommés que par le même commit atomique. Un rollback n'en consomme aucun.

### 4. Domaine du run

La machine retenue comprend `queued`, `running`, `waiting`, `cancelling`,
`ambiguous`, `completed`, `failed` et `cancelled`. Les états de contrôle sont
fermés et une nouvelle valeur est incompatible par défaut.

`StepRun` conserve toutes ses tentatives. Un vrai retry garde
l'`operation_key` mais crée un nouvel `attempt_id`; une redelivery conserve les
deux. Une tentative ambiguë interdit un retry payant jusqu'à réconciliation.

La réception d'un signal et sa consommation sont deux actions distinctes :
`SubmitHumanSignal` persiste une décision autorisée ou refusée ;
`ConsumeSignal` peut ensuite produire `RunResumed`. Une attente de step ne place
le run global en `waiting` que si aucune branche indépendante ne progresse.

### 5. Contrats et références opaques

JSON Schema Draft 2020-12 reste la source canonique. OpenAPI 3.1.1, types et
validateurs TypeScript, SDK core, métadonnées CLI et schémas MCP sont générés
depuis le même catalogue, jamais les uns depuis les autres lorsque le sens
risquerait d'être perdu.

Le domaine conserve uniquement une `ContractRef` opaque : version et
fingerprint du catalogue, `$id`, version et fingerprint du schéma. Résolution,
validation et sérialisation restent aux frontières ; aucun validateur généré
n'entre dans le kernel ou les moteurs purs.

Les versions produit, catalogue, schéma, capability, opération, workflow, API
plugin et package évoluent séparément. Les outputs et manifests sont
canonicalisés et empreintés de façon reproductible.

#### Chaîne de génération retenue

Un compilateur TypeScript interne et sans réseau consomme exclusivement le
manifest canonique. Sa qualification initiale épingle
`@humanwhocodes/momoa@3.3.10` pour le parsing JSON strict et le refus des clés
dupliquées,
`@hyperjump/json-schema@1.17.7` pour Draft 2020-12, les références et le
vocabulaire, `ajv@8.20.0` avec `ajv-formats@3.0.1` pour les validateurs standalone,
`json-schema-to-typescript@15.0.4` pour un profil structurel borné,
`canonicalize@3.0.0` pour JCS et `@redocly/cli@2.39.0` pour OpenAPI 3.1.1.

Un mot-clé non prouvé par la projection TypeScript bloque la génération au lieu
d'être ignoré. Les annotations Kurobara sont validées par vocabulaire, indexées
par `$id` et JSON Pointer, puis vérifiées surface par surface. Les enums de
données reçues explicitement extensibles conservent leur valeur brute inconnue ;
les producteurs et enums de contrôle restent fermés.

Ces moteurs restent remplaçables si leurs remplaçants produisent les mêmes
sources, annotations, outputs, fingerprints et preuves. Aucune projection ne
devient la source d'une autre projection de données.

### 6. Opérations et parité

Le registre d'opérations référence une action ou query applicative stable sans
créer de dépendance de build vers le domaine. La conformité vérifie notamment :

- `plans.quote → QuoteRunPlan` ;
- `runs.create → CreateRunFromPlan → RunQueued` ;
- `run-signals.submit → SubmitHumanSignal` ;
- `runs.cancel → RequestStop`.

REST, SDK, CLI et MCP projettent les mêmes schémas, problèmes, permissions,
idempotence et résultats. Une différence ergonomique explicite, comme l'absence
de streaming MCP V1, ne crée pas une seconde sémantique métier.

### 7. Transactions et effets

L'application possède l'unité de travail ; PostgreSQL l'implémente. Les unités
atomiques incluent au minimum :

- création du run + événement initial + outbox ;
- tentative + claim d'opération + réservation ;
- signal accepté + inbox + outbox de réveil ;
- délégation + sous-budget + relation parent/enfant + outbox ;
- règlement d'usage + issue de tentative ;
- terminaison + manifest de résultat + événement final.

Un appel réseau ou objet intervient après commit. Le règlement, la libération ou
l'ambiguïté sont persistés dans une transaction suivante. L'orchestrateur ne
crée jamais une nouvelle autorisation métier.

## Public contracts and compatibility

Les identifiants, règles de naming, URI de schémas, profils d'objets ouverts ou
fermés, métadonnées d'opération, registre RFC 9457 et matrice de compatibilité
sont détaillés dans la spécification contractuelle.

Les `$id` publics utilisent exclusivement la forme
`https://schemas.kurobara.dev/schemas/<family>/<name>/<semver>`. `family` et
`name` sont en `kebab-case` ASCII et la version SemVer n'a pas de préfixe `v`.
L'identifiant ne contient ni fragment, query, extension, version produit,
version de catalogue ou alias flottant. Toute modification reçoit une nouvelle
version, un nouveau `$id` et une nouvelle empreinte. Le catalogue résout ces URI
localement. La première publication est bloquée jusqu'à preuve du contrôle
durable de `kurobara.dev`; à défaut, un autre domaine contrôlé est choisi avant
tout `$id` public.

Les enums de données explicitement extensibles peuvent prévoir `unknown`. Les
états de run/step/tentative et les enums d'autorité, de terminalité ou d'action
permise ne bénéficient pas de cette tolérance : une nouvelle valeur exige une
version majeure ou une preuve spécifique de compatibilité comportementale.

La V1 expose seulement l'allowlist d'événements de la spécification
contractuelle. Un type public suit
`dev.kurobara.<family>.<fact>.v<major>`. Une évolution compatible conserve le
type et change son `dataschema` exact ; une rupture reçoit un nouveau type et un
nouveau schéma majeurs. Un type V1 n'est ni retiré, ni réaffecté, ni remplacé
silencieusement par un type V2 sur `/v1`.

La projection possède une identité et une séquence par run et reste conservée
pendant la rétention du run. SSE garde son enveloppe compacte. Une future
frontière webhook ou broker peut projeter la même taxonomie sous CloudEvents
1.0 avec une paire `source`/`id` stable et unique.

## Security, privacy and agent authority

- workspace, acteur et enveloppe d'autorité sont explicites sur toute commande
  mutable ;
- une délégation réduit permissions, scopes, budget, deadline et fan-out ;
- aucune annotation de contrat ou de tool n'autorise un client ;
- secrets et données sensibles ne figurent pas dans les problèmes ou événements
  publics par défaut ;
- les classifications et règles d'expurgation sont conservées par les
  projections, puis recalculées côté serveur ;
- un effet ambigu ferme les nouvelles dépenses concernées ;
- arrêt parent, deadline ou révocation se propagent aux descendants.

Le modèle de menace final reste séparé et dépend de la validation du déploiement
réel, comme l'indique le
[registre de sécurité](../architecture/security-boundaries.md).

## Data, operations and rollback

Ce RFC ne choisit aucun schéma SQL. PostgreSQL conserve agrégats, versions,
ledger, événements et outbox ; les read models restent reconstruisibles.

Avant implémentation, rejeter ou réviser cette baseline acceptée exige un nouveau
RFC et un ADR qui l'amende ou la remplace ; aucun format public ni migration n'a
encore été livré. Après implémentation, toute évolution incompatible des contrats,
frontières ou garanties exige en plus une stratégie de version ou migration
explicite.

## Alternatives

### OpenAPI comme source canonique

Rejeté par ADR-0003 : cela ferait du transport HTTP la source du SDK, de la CLI,
de MCP et des événements.

### `RunPlan` directement produit par le workflow engine

Rejeté dans la proposition : quote, routing, budget et autorité nécessitent des
faits et ports applicatifs incompatibles avec un compilateur pur.

### Run créé dès la quote

Non retenu : cela crée un agrégat et un identifiant avant l'intention
d'exécuter, mélange expiration de quote et terminalité du run, et rend
`runs.create` ambigu.

### Schémas publics importés par le kernel

Rejeté : sérialisation et compatibilité contamineraient le modèle interne et
créeraient une dépendance du domaine vers un package de frontière.

### MCP in-process vers l'application

Rejeté pour la V1 : MCP local reste `stdio → SDK HTTP → API`, afin de conserver
le même use case et la même autorisation que les autres clients.

## Risks

- la baseline documentaire peut donner une impression de livraison sans les
  packages, tests et artifacts correspondants ;
- la règle un plan/un run impose une nouvelle quote à chaque réexécution ;
- les moteurs de génération retenus ont des couvertures différentes et exigent
  un profil qualifié plutôt qu'une approximation silencieuse ;
- un analyseur statique ne résout pas un import calculé, qui doit donc être
  interdit par un contrôle AST complémentaire ;
- la séparation modèle interne/projection ajoute des mappings à tester ;
- une machine d'états fermée rend chaque évolution plus coûteuse, mais évite les
  comportements clients indéterminés.

## Verification plan

La proposition est considérée implémentée seulement après :

1. contrôle automatisé et tests négatifs de la matrice d'imports ;
2. kernel, compilateur et policy engine testés sans I/O ;
3. catalogue et projections générés deux fois avec les mêmes octets ;
4. tests de compatibilité producteur/consommateur ;
5. table complète `state × command`, tests par propriétés et replay ;
6. tests concurrents budget, version d'agrégat et consommation de signaux ;
7. fault injection avant/après appel externe et réconciliation ;
8. parité REST/SDK/CLI/MCP contre les mêmes use cases ;
9. build self-host sans accès au service managé ;
10. vérification des artifacts packagés, fingerprints et scans expurgés.

## Review notes

La revue croisée multi-agent a relevé puis fait corriger les ambiguïtés
suivantes : ownership quote/run, sortie du compilateur, réception/consommation
des signaux, identité retry/redelivery, `ContractRef` opaque, enums de contrôle,
mapping opération/action, propriété applicative des transactions et composition
MCP via SDK HTTP.

Les cinq questions relevées par la revue sont résolues ci-dessous. La preuve de
contrôle du domaine reste une condition de publication, pas une question de
conception ouverte.

## Open questions

Aucune question bloquante ne reste ouverte pour la décision de conception. La
preuve de contrôle de `kurobara.dev` reste une condition de première publication,
pas une permission implicite de publier sous un namespace différent.

## Resolved questions

1. Une instance de `RunPlan` est single-use et crée au plus un run logique.
2. Les `$id` utilisent le namespace HTTPS exact défini ci-dessus, sous gate de
   contrôle durable du domaine.
3. Le compilateur interne orchestre Momoa, Hyperjump, AJV standalone,
   json-schema-to-typescript, canonicalize et Redocly avec versions épinglées.
4. `dependency-cruiser` 18.x est le gate initial, complété par un contrôle AST
   des imports calculés ; generated sources et alias ne reçoivent aucun bypass.
5. La spécification contractuelle porte une allowlist publique fermée et une
   compatibilité valable pendant toute la vie de `/v1`.

## Decision

**Accepted le 2026-07-17 par Leandre Desmaretz.** Les cinq questions de revue
sont résolues ci-dessus et la décision durable est résumée par
[ADR-0004](../adr/0004-v1-module-contract-domain-baseline.md).

Conditions assumées : aucun `$id` public avant preuve du contrôle du domaine ;
Node 24 LTS et `npm@10.9.4` épinglés avant qualification des outils ; versions
de générateurs verrouillées dans le manifest ; aucune clôture de ticket sans les
preuves du plan de vérification. Aucune objection bloquante ne reste ouverte.
L'acceptation n'annonce aucune implémentation ni publication.
