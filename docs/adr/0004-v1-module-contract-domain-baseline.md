# ADR-0004 — Baseline exécutable des modules, contrats et cycles de vie

- Statut : **Accepté**
- Date : **2026-07-17**
- Décideur : Leandre Desmaretz
- RFC lié : [RFC-0001](../rfcs/0001-v1-module-contract-domain-baseline.md)

## Contexte

Les trois premières fondations d'implémentation de la V1 doivent être décidées
ensemble : frontières du monolithe modulaire, catalogue contractuel et domaine
des workflows/runs. Les laisser évoluer séparément créerait des dépendances
inversées, des contrats divergents et des machines d'état incompatibles.

Le [RFC-0001](../rfcs/0001-v1-module-contract-domain-baseline.md) conserve
l'analyse, les alternatives et la résolution détaillée des questions de revue.
Le présent ADR enregistre la décision durable. Il ne prouve pas que les packages,
générateurs, schémas, contrôles, migrations ou runtimes existent.

## Décision

### Frontières et planification

La V1 suit la matrice définie par les
[frontières du monolithe](../architecture/module-boundaries.md). Le kernel ne
réalise aucune I/O ; les moteurs purs dépendent seulement du kernel ;
l'application orchestre à travers des ports ; seuls les composition roots
choisissent les adapters concrets.

Le workflow engine produit un `CompiledWorkflow` pur. L'application compose le
`RunPlan` avec contrats, policy, routing, quote, budget, deadline et autorité.
Une instance de `RunPlan` est une autorisation d'exécution single-use : elle
crée au plus un `Run` logique. `WorkflowSpec` et `CompiledWorkflow` restent
réutilisables ; une nouvelle exécution repasse par `plans.quote`.

### Contrats publics

JSON Schema Draft 2020-12 reste la source canonique. Les `$id` publics suivent :

```text
https://schemas.kurobara.dev/schemas/<family>/<name>/<semver>
```

Ils sont immuables, sans fragment, query, extension ou alias flottant, et sont
résolus localement depuis le manifest. La première publication de ces identités
est bloquée tant que le contrôle durable de `kurobara.dev` n'est pas prouvé. Si
ce contrôle ne peut pas être établi, un domaine effectivement contrôlé doit être
choisi avant le premier `$id` publié ; aucun `urn:kurobara` non enregistré ne
doit le remplacer.

Un compilateur TypeScript interne projette le même manifest vers OpenAPI 3.1.1,
types et validateurs TypeScript, SDK HTTP, métadonnées CLI et descripteurs MCP.
La chaîne initiale qualifie et épingle :

- Momoa pour le parsing JSON strict et le refus des clés dupliquées ;
- `@hyperjump/json-schema` pour Draft 2020-12, références et vocabulaire ;
- AJV 2020 avec standalone code pour les validateurs de runtime ;
- `json-schema-to-typescript` pour un profil de projection explicitement borné ;
- `canonicalize` pour JCS puis SHA-256 ;
- Redocly CLI pour la qualification de la projection OpenAPI 3.1.1.

Ces moteurs sont remplaçables si les mêmes sources, annotations, outputs,
empreintes et gates restent prouvés. Une projection ne devient jamais la source
d'une autre projection de données.

### Contrôle d'architecture

`dependency-cruiser` 18.x est le mécanisme de preuve initial de la matrice
d'imports. Sa politique est `default deny`, analyse les chemins résolus, les
imports de types, les réexports, les alias et les imports dynamiques littéraux,
et inclut tout code généré consommé par le build. Un contrôle AST complémentaire
refuse les imports et `require` à spécificateur calculé.

Les workspaces et leurs `exports` définissent les subpaths publics. Le même
crawl produit le diagnostic CI et un graphe Mermaid collapsé et reviewable.
L'outil peut être remplacé sans nouveau RFC seulement si le remplacement
préserve toute la matrice, les tests négatifs et le graphe vérifié.

### Événements publics

Les événements internes restent privés par défaut. La V1 projette uniquement
l'allowlist enregistrée dans le
[système de contrats](../architecture/contract-system.md). Un type public suit
`dev.kurobara.<family>.<fact>.v<major>` et reste compatible pendant toute la vie
du major de surface `/v1`. Une rupture reçoit un nouveau type et un nouveau
schéma majeurs.

SSE conserve une enveloppe compacte et une séquence par run ; CloudEvents n'y
est pas imposé. Une future frontière webhook ou broker pourra projeter la même
taxonomie sous CloudEvents 1.0 avec une paire `source`/`id` stable.

## Conditions d'implémentation

- épingler Node 24 LTS et utiliser le `npm@10.9.4` déclaré avant de qualifier les
  outils retenus ;
- verrouiller les versions exactes et les inscrire dans le manifest de
  génération ;
- interdire la publication des `$id` avant preuve du contrôle du domaine ;
- exécuter deux générations propres byte-identiques, les tests de fixtures,
  compatibilité, annotations, parité et packages ;
- fermer `ARCH-001`, `CONTRACT-001` et `DOMAIN-001` uniquement sur les preuves
  d'implémentation prévues par leur backlog.

## Conséquences

- la direction des dépendances et le lifecycle deviennent univoques avant le
  premier package V1 ;
- les clients peuvent évoluer depuis un même catalogue sans importer le modèle
  interne ;
- une nouvelle exécution ne réutilise pas silencieusement prix, autorité ou
  budget périmés ;
- les générateurs et analyseurs sont des mécanismes qualifiés, pas de nouvelles
  frontières de domaine ;
- l'immutabilité des identités publiques augmente le coût d'une mauvaise
  première publication, d'où la gate de contrôle du domaine.

## Révision

Un nouveau RFC et un nouvel ADR sont requis pour changer une frontière
normative, la source canonique, la méthode d'empreinte, la sémantique single-use
du `RunPlan`, l'identité publique déjà publiée ou la garantie de compatibilité
d'un type d'événement. Un moteur d'outillage peut être remplacé sans nouvelle
décision si toutes les garanties et preuves ci-dessus restent identiques.
