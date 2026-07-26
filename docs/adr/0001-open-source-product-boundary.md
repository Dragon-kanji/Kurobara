# ADR-0001 — Frontière entre le produit OSS et le service managé

- Statut : **Accepté**
- Date : **2026-07-17**
- Décideur : projet Kurobara

## Contexte

Kurobara doit fournir un produit self-host utilisable sans compte, jeton ou infrastructure opérée par le projet. Un service managé peut simplifier l'exploitation et porter des offres commerciales, mais il ne doit pas devenir le lieu où réside une capacité nécessaire au produit documenté.

La frontière doit donc être visible dans les dépôts, les dépendances et les tests. Une simple distinction marketing entre éditions ne suffit pas.

## Décision

Le produit OSS vit dans un monorepo public distribué sous [Apache-2.0](../../LICENSE). Ce monorepo contient tout ce qui est nécessaire au parcours self-host de référence décrit par [l'architecture V1](../architecture/v1-oss-agentic.md), notamment :

- le kernel, les contrats et les moteurs de workflow et de policy ;
- les ports publics et les adapters nécessaires au déploiement de référence ;
- l'API, le worker, la console self-host minimale, le SDK, la CLI et le serveur MCP ;
- la persistence, l'orchestration, l'observabilité et les outils de migration requis ;
- la documentation, les tests et la composition de déploiement permettant de reproduire le parcours complet.

Le service managé vit dans un dépôt privé physiquement séparé. Il peut contenir l'exploitation multi-tenant, la facturation, les moyens de paiement, les crédits fournisseurs financés par l'opérateur, la prévention globale des abus, le SSO commercial, le provisioning d'organisations et les intégrations propres au service.

Le monorepo public définit des ports stables pour les préoccupations extensibles telles que les entitlements, le metering, la résolution de secrets et le provisioning. Il fournit les implémentations locales nécessaires au self-host. Le service managé peut brancher ses propres adapters sur ces ports ; le cœur public n'importe aucun package, schéma privé, secret ou endpoint du service managé.

La direction de dépendance est unique : le service managé dépend du produit OSS, jamais l'inverse. Un build, un test ou un déploiement public ne doit pas nécessiter l'accès au dépôt privé.

## Règle anti-open-core

Une fonction appartient au monorepo public si son absence empêche d'installer, configurer, exécuter, observer, administrer ou étendre le parcours self-host annoncé. Elle ne peut pas être réservée au dépôt privé sous prétexte qu'une implémentation managée existe.

Le dépôt privé peut apporter une commodité d'exploitation, une intégration commerciale ou une garantie de service. Il ne peut pas compléter après coup un kernel, un contrôle d'accès, une isolation de données, un moteur d'exécution ou une interface publique volontairement incomplets.

Toute exception exige un nouvel ADR qui décrit la capacité concernée, la raison de la séparation et l'alternative self-host disponible.

## Vérification

Cette frontière est vérifiée par :

- un démarrage du déploiement de référence depuis un clone public vierge ;
- un parcours self-host complet sans identité ni service managé ;
- des tests interdisant les imports et appels requis du public vers le privé ;
- une revue des contrats et dépendances à chaque release ;
- une documentation qui distingue explicitement capacité OSS et commodité managée.

Ces contrôles rendent la décision observable ; ils ne constituent pas une conclusion juridique.

## Conséquences

- Le produit public reste opérable et extensible de manière autonome.
- Le service managé réutilise les mêmes contrats et points d'extension que les autres opérateurs.
- Les fonctionnalités indispensables au self-host supportent le coût d'une maintenance publique.
- Les offres commerciales se différencient par l'exploitation, les intégrations et le service plutôt que par la rétention du moteur.
- La séparation physique impose de versionner les ports et de tester la compatibilité entre dépôts.

## Options rejetées

### Clients publics autour d'un runtime privé

Cette option ne fournit pas un produit self-host complet.

### Modules commerciaux dans le monorepo public

Cette option rend la frontière de distribution et de dépendance plus difficile à contrôler. Les extensions propres au service managé restent dans son dépôt séparé.

### Fonctionnalités essentielles réservées au service managé

Cette option crée une ambiguïté open-core contraire à la règle d'inclusion retenue.

## Critères de révision

Un nouvel ADR est requis avant :

- de rendre un service privé obligatoire au parcours self-host ;
- de déplacer une capacité essentielle du public vers le privé ;
- d'introduire une dépendance du monorepo public vers un package ou contrat privé ;
- de changer la licence du monorepo public ;
- de réunir les deux périmètres dans un même dépôt ou une même distribution.
