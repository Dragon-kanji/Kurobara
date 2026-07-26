# Registre des mainteneurs de Kurobara

- Statut : **registre public de responsabilité**
- Portée : projet open source Kurobara
- Autorité de référence : [GOVERNANCE.md](./GOVERNANCE.md)

Ce document déclare qui porte un périmètre de maintenance. Il ne constitue pas une preuve de permissions techniques, d'appartenance à une équipe hébergée ou d'accès à un canal sensible.

## Mainteneur bootstrap

| Mainteneur | Identité publique | Responsabilité déclarée | Autorité décisionnelle | Accès technique |
| --- | --- | --- | --- | --- |
| Leandre Desmaretz | GitHub [@Dragon-kanji](https://github.com/Dragon-kanji) | projet complet pendant la phase bootstrap | decision owner par défaut, sous réserve de la gouvernance et des récusations | non attesté par ce registre |

Cette identité publique est la seule coordonnée maintenue dans cette page. Le registre ne doit pas être enrichi avec des informations déduites d'une configuration locale, d'un commit ou d'un autre système.

## Trois notions distinctes

### Responsabilité déclarée

Une responsabilité déclarée décrit le travail qu'une personne accepte de porter : organiser une revue, maintenir une politique, vérifier une release ou consigner une décision. Elle rend l'ownership lisible, mais ne prouve pas que le travail a été exécuté.

### Autorité décisionnelle

L'autorité décisionnelle permet de conclure une proposition dans un périmètre donné selon [GOVERNANCE.md](./GOVERNANCE.md). Elle reste limitée par les conflits d'intérêts, les exigences de preuve et les décisions déjà acceptées.

Un mainteneur ne peut pas remplacer un test manquant, une objection non traitée ou une autorisation absente par son seul titre.

### Accès technique

Un accès technique est une permission vérifiée sur un système précis : fusion, administration du dépôt, publication d'un package, signature d'une release ou lecture d'un canal restreint. Il est accordé et révoqué séparément de ce registre.

L'ajout d'un nom dans cette page ne crée aucun accès. À l'inverse, une permission technique ne confère pas automatiquement une autorité de gouvernance.

## Périmètres du mainteneur bootstrap

Pendant la phase bootstrap, le mainteneur déclaré porte les responsabilités suivantes :

- garder les ADR, RFC et contrats publics cohérents ;
- désigner un decision owner lorsqu'une proposition structurante l'exige ;
- vérifier que les objections et risques sont consignés avant une décision ;
- examiner le périmètre, les checks et la provenance des contributions selon [CONTRIBUTING.md](./CONTRIBUTING.md) ;
- maintenir les politiques communautaires alignées avec le [code de conduite](./CODE_OF_CONDUCT.md) ;
- vérifier qu'une release candidate possède une révision, des checks et des limites identifiables ;
- déclarer ses conflits d'intérêts et se récuser lorsque nécessaire ;
- proposer une continuité de responsabilité lorsque le nombre de mainteneurs augmente.

Les sujets de vulnérabilité suivent exclusivement [SECURITY.md](./SECURITY.md). Cette liste ne désigne pas un canal de signalement, ne prouve pas l'accès à un rapport privé et ne promet aucun traitement ou délai.

## Ce que ce registre ne prouve pas

La présence d'un mainteneur dans ce fichier ne démontre pas :

- une permission d'administration ou de fusion ;
- l'existence d'une équipe GitHub ou d'un fichier CODEOWNERS effectif ;
- l'activation d'un ruleset, d'une protection de branche ou d'un bot ;
- un accès à un registre de packages, à une clé de signature ou à un secret ;
- l'existence d'un canal de support, de conduite ou de sécurité ;
- une disponibilité, une permanence ou un niveau de service ;
- l'achèvement d'une revue, d'une release ou d'une action de maintenance.

Ces capacités doivent être décrites uniquement après un readback adapté au système concerné.

## Readback des accès

Avant d'affirmer publiquement qu'un mainteneur contrôle une capacité technique, la preuve doit identifier :

1. le système et le périmètre testés ;
2. l'identité publique utilisée pour le test ;
3. l'action autorisée et une action hors périmètre refusée lorsque cela est sûr ;
4. la date du contrôle et son résultat ;
5. l'emplacement d'une preuve expurgée ;
6. la personne responsable de renouveler le contrôle.

Une capture de paramètres ou une déclaration d'intention ne suffit pas si un test utilisateur non destructif est possible. Les secrets, jetons et données sensibles ne doivent jamais apparaître dans la preuve publique.

Le readback doit être renouvelé après un changement de rôle, de permission, de propriétaire du système ou de mécanisme d'authentification. Une preuve périmée est signalée comme telle au lieu d'être présentée comme actuelle.

## Nomination et changement de périmètre

Une nomination suit les critères de [GOVERNANCE.md](./GOVERNANCE.md) : contributions soutenues, revues fiables, compréhension du périmètre et comportement conforme aux politiques du projet.

La proposition précise :

- le périmètre de responsabilité ;
- l'autorité de décision demandée ;
- les accès techniques éventuellement nécessaires ;
- les conflits d'intérêts connus ;
- les attentes de continuité et de moindre privilège.

Les mainteneurs non récusés rendent la décision. Le registre est mis à jour après cette décision. Les permissions techniques sont ensuite accordées séparément et ne sont déclarées vérifiées qu'après readback.

Un élargissement ou une réduction de périmètre suit la même distinction entre responsabilité, autorité et accès.

## Retrait et statut émérite

Un mainteneur peut quitter son rôle à tout moment. Le registre indique alors la fin de sa responsabilité sans interpréter les raisons de son départ.

Un retrait pour inactivité, risque de sécurité ou manquement grave suit la procédure de gouvernance et exclut la personne concernée de la décision. Lorsque les circonstances le permettent, elle peut répondre avant la conclusion.

Les accès techniques associés sont révoqués et vérifiés séparément. Retirer un nom de ce fichier sans contrôler les systèmes concernés ne prouve pas la révocation effective.

Un statut émérite peut reconnaître une contribution passée. Il n'accorde ni autorité décisionnelle, ni accès technique, ni responsabilité opérationnelle.

## Conflits d'intérêts et récusation

Un mainteneur déclare tout intérêt susceptible d'affecter raisonnablement son jugement. La récusation retire son autorité de décision sur le sujet, mais peut lui permettre de fournir des faits si cela ne compromet pas la procédure.

Si tous les mainteneurs sont concernés, la trace de décision décrit le conflit, les mesures compensatoires et la raison d'attendre ou de poursuivre. Le registre ne transforme pas une décision conflictuelle en décision indépendante.

## Continuité

Le projet ne doit pas inventer un remplaçant ou un accès de secours non vérifié pour masquer un point de dépendance unique.

Lorsqu'un second mainteneur est nommé, les périmètres, sauvegardes et escalades sont documentés explicitement. Les opérations sensibles recherchent une seconde revue lorsqu'un mainteneur éligible et non récusé est disponible.

En cas d'indisponibilité du seul mainteneur déclaré, les actions irréversibles ou sensibles restent suspendues sauf procédure de récupération déjà documentée et vérifiée. Les contributions et informations publiques peuvent continuer à être préparées sans prétendre qu'une décision ou une publication a eu lieu.

## Mise à jour du registre

Toute modification substantielle de ce fichier suit la gouvernance. Le changement doit distinguer ce qui est déclaré, décidé et techniquement vérifié.

Ce registre n'est pas un avis juridique et ne crée aucun droit au-delà des politiques et décisions du projet.
