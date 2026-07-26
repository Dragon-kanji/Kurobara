# Planification durable d'une génération de dataset

Ce guide décrit la tranche interne `KRB-DATASET-GEN-001A`. Elle transforme une
intention de sourcing bornée en un plan immuable et rejouable, sans appeler un
provider et sans créer de dataset, de Run, de page ou de record.

Cette tranche est une fondation applicative. Elle n'ajoute encore aucune route
REST, méthode SDK, commande CLI ou opération MCP publique.

## Comportement vérifié

Le use case de création reçoit une query brute, une cible de dataset, un schéma,
une enveloppe d'autorité et les faits nécessaires au preflight de sourcing. Il :

1. valide et normalise la query côté serveur par un port local et
   capability-aware ;
2. calcule les identités canoniques de la query, du schéma et de l'intention,
   sans accepter de hash affirmé par le client ;
3. résout les snapshots de routes et de coûts sans exécuter la capability ;
4. applique le preflight pur de budget, cardinalité et deadline ;
5. construit un plan complet puis calcule son identité canonique ;
6. persiste ce plan dans PostgreSQL sous un verrou d'idempotence scoped au
   workspace.

La même clé d'idempotence et la même intention relisent exactement le plan déjà
stocké. Ce replay ne dépend donc pas des routes ou des tarifs qui auraient
changé depuis sa création. La même clé avec une intention différente échoue
avant toute écriture supplémentaire. Les identifiants ne sont générés qu'après
le verrou et le second readback, ce qui évite qu'une course crée deux plans.

Le plan détache les valeurs normalisées et les snapshots qui ont servi à la
décision. L'appelant ne peut pas élargir une autorité, inventer un défaut
« tous les résultats » ou transformer une quote inconnue en dépense autorisée.

## Persistance

La migration `0020_dataset_generation_plans.sql` ajoute une table dédiée et
workspace-scoped. Les contraintes garantissent notamment :

- une seule création par clé d'idempotence dans un workspace ;
- une seule planification par cible de dataset dans ce workspace ;
- la cohérence entre les colonnes d'identité et le payload JSON borné ;
- le refus des `UPDATE` et `DELETE` afin de conserver le snapshot initial.

L'adapter relit et valide le payload comme une donnée non fiable. La migration
ne réutilise pas `dataset_imports` et ne fabrique donc aucun faux import.

## Frontières de cette tranche

`KRB-DATASET-GEN-001A` ne fournit pas à elle seule :

- de capability publique de découverte d'entreprises ou de contacts ;
- de normalizer, route ou quote issu d'un provider réel ;
- de création ou de readiness de `Dataset` ; ces fondations sont livrées
  séparément par `KRB-DATASET-GEN-001B` ;
- de Run de page, curseur, receipt, record généré ou déduplication ;
- de réservation ou règlement dans le ledger ;
- de revalidation entre les pages, d'arrêt sur résultat ambigu ou de reprise ;
- de parité REST, SDK TypeScript, CLI ou MCP.

Le [guide de matérialisation](./dataset-generation-materialization.md) décrit la
composition interne suivante : création d'une génération `planned`,
matérialisation `building`, readiness origin-neutral et replay PostgreSQL,
toujours sans effet. Le [guide de première page](./dataset-generation-first-page.md)
décrit ensuite le Run déterministe, la revalidation atomique des bornes et le
checkpoint de provenance livré par `KRB-DATASET-GEN-001C`. Pagination suivante,
ledger multi-pages, réconciliation positive et surfaces publiques restent dans
`KRB-DATASET-GEN-001`, `KRB-BUDGET-002` et les tickets Company/Contact. Une
surface publique ne doit être ajoutée qu'avec un contrat canonique et la même
logique applicative sur tous les clients.

## Vérification locale

Avec le runtime Node épinglé par le dépôt :

```sh
npm run check
npm run typecheck
npm test
npm run build
```

Le test d'intégration PostgreSQL exige en plus
`KUROBARA_TEST_POSTGRES_URL` vers une instance locale autorisée à créer une base
jetable. Il vérifie la migration depuis `0019`, l'isolation par workspace et
l'immutabilité physique de la table. Les tests applicatifs couvrent séparément
le replay, la collision d'intention, les refus du preflight et la concurrence.
