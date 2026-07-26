# Gouvernance de Kurobara

## Portée

Cette gouvernance organise les décisions du projet open source Kurobara. Elle couvre le code, la documentation, les contrats publics, les releases et les politiques communautaires du dépôt.

Les droits sur le logiciel viennent exclusivement de la [licence Apache 2.0](./LICENSE). Les règles de participation sont complétées par le [guide de contribution](./CONTRIBUTING.md) et le [code de conduite](./CODE_OF_CONDUCT.md).

Un service hébergé peut utiliser Kurobara, mais il ne reçoit aucune autorité particulière sur le projet. Les composants open source doivent rester exploitables et extensibles sans dépendance obligatoire à une offre commerciale. L'[ADR sur la frontière produit](./docs/adr/0001-open-source-product-boundary.md) porte cette contrainte d'architecture.

## Principes de décision

- Les choix importants laissent une trace durable avec leur contexte, leurs alternatives et leurs conséquences.
- L'autorité repose sur une responsabilité explicite et des contributions de qualité, jamais sur l'employeur, le financement ou l'ancienneté seuls.
- Une objection technique ou communautaire est traitée sur ses faits, son risque et ses preuves.
- Les changements difficiles à annuler reçoivent davantage de revue que les changements locaux.
- Une décision acceptée ne constitue pas une preuve d'implémentation ou de disponibilité.
- Les intérêts personnels, professionnels et commerciaux susceptibles d'affecter un jugement sont déclarés.

## Rôles

### Participant

Toute personne qui prend part aux échanges du projet. Les participants respectent le code de conduite, y compris lorsqu'ils ne proposent aucun changement.

### Contributeur

Un contributeur propose du code, de la documentation, une revue, un test, une analyse ou une autre amélioration. Il reste responsable de la provenance de sa contribution et des déclarations demandées par le processus DCO décrit dans le guide de contribution.

### Reviewer

Un reviewer examine une proposition dans un domaine où il peut apporter une expertise utile. Il identifie les régressions, les risques, les hypothèses non prouvées et les effets sur les interfaces publiques. Une revue n'accorde pas, à elle seule, de droit de fusion ou de vote.

### Mainteneur

Un mainteneur porte un périmètre défini du projet. Selon ce périmètre, il peut rendre une décision, intégrer un changement, gérer une release ou administrer un accès sensible. Les mainteneurs et leurs responsabilités sont déclarés dans [MAINTAINERS.md](./MAINTAINERS.md).

### Decision owner

Pour une proposition structurante, un mainteneur agit comme decision owner. Cette personne organise la revue, reformule les points de désaccord et consigne l'issue. Elle ne peut pas ignorer un conflit d'intérêts pertinent ni remplacer les preuves manquantes par son seul avis.

## Comment une décision est prise

Les correctifs limités, réversibles et sans effet sur un contrat public peuvent suivre la revue normale d'une contribution. Un [RFC](./docs/rfcs/README.md) est attendu lorsqu'une proposition modifie plusieurs sous-systèmes, une politique du projet, la sécurité, la compatibilité, la frontière open source/service hébergé ou une décision coûteuse à inverser.

Le projet privilégie un consensus documenté. Le consensus ne demande pas l'unanimité, mais aucune objection bloquante ne doit rester sans réponse explicite. Le decision owner peut conclure que le risque est traité, accepter avec des conditions, demander une révision ou refuser la proposition.

Si les mainteneurs éligibles ne parviennent pas à un consensus :

1. chaque mainteneur non récusé exprime une position et sa justification ;
2. la majorité simple détermine l'issue ;
3. une égalité conserve le comportement ou la politique en vigueur ;
4. s'il n'existe qu'un seul mainteneur éligible, il peut trancher en documentant les objections et les risques acceptés.

Une question de sécurité sous embargo suit [SECURITY.md](./SECURITY.md). Les informations sensibles peuvent rester privées tant que leur publication mettrait des personnes ou des systèmes en danger. La décision technique durable doit ensuite être documentée avec le niveau de détail publiable.

## Conflits d'intérêts et récusation

Toute personne participant à une décision indique les liens financiers, contractuels, professionnels ou personnels qui pourraient raisonnablement influencer son jugement. Un mainteneur se récuse lorsqu'il ne peut pas arbitrer impartialement.

Une récusation retire le pouvoir de décision sur le sujet, pas le droit de fournir des faits. Si tous les mainteneurs sont concernés, la trace de décision explique la situation, les mesures compensatoires et la raison pour laquelle le choix peut ou non attendre.

## Mainteneurs

La nomination d'un mainteneur tient compte de contributions soutenues, de revues fiables, de la compréhension du périmètre et d'un comportement conforme aux politiques communautaires. Elle est proposée comme un changement de gouvernance et approuvée par les mainteneurs non concernés.

Chaque nomination précise le périmètre, les accès nécessaires et les attentes de responsabilité. Les permissions sont limitées au besoin et revues lorsqu'un rôle change.

Un mainteneur peut quitter son rôle à tout moment. Un retrait pour inactivité, risque de sécurité ou manquement grave doit être motivé et décidé sans la participation de la personne concernée. Lorsque les circonstances le permettent, cette personne peut répondre avant la décision finale. Un statut émérite peut reconnaître une contribution passée sans conserver d'accès ni d'autorité.

## Accès sensibles et releases

Les secrets, signatures, publications de packages et changements de protection du dépôt utilisent le moindre privilège. Une personne ne doit pas approuver seule une opération sensible dont elle est l'unique auteur lorsqu'un second mainteneur éligible est disponible.

Une release doit être rattachée à une révision identifiable, à des checks reproductibles et à des notes qui distinguent clairement comportement livré, limites et migrations. Cette gouvernance ne promet aucune cadence de publication, branche supportée ou délai de traitement.

## Modifier cette gouvernance

Un changement éditorial peut suivre une contribution ordinaire s'il ne modifie aucune responsabilité ni aucun droit de décision. Toute évolution substantielle passe par un RFC.

Un changement de licence, de modèle de contribution ou de frontière entre le projet open source et un service hébergé exige en plus une analyse des droits et des obligations applicables. La gouvernance ne permet pas de relicencier automatiquement des contributions tierces.
