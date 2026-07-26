# Matérialisation durable d'une génération de dataset

- Statut : **fondation interne terminée, sans effet**
- Ticket : `KRB-DATASET-GEN-001B`
- Dépendance directe : `KRB-DATASET-GEN-001A`
- Surfaces publiques ajoutées : aucune

Cette tranche instancie un plan immuable en un `DatasetGeneration` durable et
une `DatasetMaterialization` origin-neutral. Elle s'arrête dans l'état
`planned/building` : aucun Run de page, provider, record généré ou mouvement de
ledger n'est créé.

## Création et replay

Le use case interne reçoit uniquement le workspace et l'identité d'un plan déjà
persisté. Sous une transaction workspace-scoped, il verrouille cette identité,
relit le plan, puis prend le même verrou de dataset cible que `beginImport` avant
de rechercher une génération existante. Ces deux verrous précèdent toute
allocation d'identité ou lecture de l'horloge.

Un premier appel cohérent persiste ensemble :

- le `Dataset` cible et ses `Field` exacts issus du plan ;
- un `DatasetGeneration` à la version `1`, dans l'état `planned` ;
- une matérialisation unique du même dataset, d'origine `generation`, dans
  l'état `building` ;
- les liaisons vers le plan, ses hashes d'intention, query et schéma, sa
  capability et son unité de coût.

Les compteurs de pages, appels, résultats, records acceptés, rejetés ou
duplicates valent zéro. Les coûts `reserved` et `spent` valent également zéro.
Ces valeurs prouvent l'absence de progression ; elles ne constituent ni une
réservation, ni un règlement.

Le même plan relit la création initiale. Le payload stocké est revalidé contre
le plan immuable avant d'être retourné. Un plan absent dans le workspace, une
liaison persistée divergente ou un dataset cible déjà utilisé échoue sans
seconde création. Le verrou du plan sérialise les créations de génération ; le
verrou partagé du dataset tranche aussi la course import-versus-generation avant
toute allocation.

Le use case de lecture est lui aussi workspace-scoped. Il ne déclenche aucune
page, réservation, télémétrie métier ou réconciliation.

## Readiness origin-neutral

Chaque dataset possède exactement une matérialisation dont l'origine est soit
un import, soit une génération. Les imports existants sont backfillés sans faux
aggregate de génération :

| État de l'import | État commun | Consommable |
| --- | --- | --- |
| `running` | `building` | non |
| `completed` | `ready` | oui |
| `failed` | `failed` | non |

Une matérialisation d'import `ready` conserve les compteurs acceptés et rejetés,
une couverture `complete_for_declared_source/imported_source` et un hash de
contenu calculé sur l'ordre durable des records. Les records existants reçoivent
une identité de matérialisation et un ordinal stable sans réencoder leur payload.

La création, la progression, le reset et la terminaison d'un nouvel import
maintiennent désormais la matérialisation dans la même transaction que
l'aggregate d'import. Les consommateurs — application de recette, export et
lecture ordonnée des records — vérifient l'état commun `ready`, pas
`DatasetImport.state`. Un refus utilise la raison origin-neutral
`dataset-not-ready`.

Une génération créée par cette tranche reste toujours `planned/building` et
n'est donc pas consommable par une recette ou un export.

## Persistance et reprise

La migration `0021_dataset_generation_materializations.sql` ajoute les
générations et matérialisations workspace-scoped, backfill les imports et relie
les records à leur matérialisation. Les colonnes relationnelles et le payload
JSON borné doivent décrire les mêmes identités, états, compteurs et coûts.

PostgreSQL reste la vérité métier. Après reconstruction des adapters, une
lecture puis un replay retrouvent la même génération sans dépendre de l'historique
de l'orchestrateur. Une transaction interrompue ne doit laisser ni dataset sans
matérialisation, ni génération partielle.

## Frontières de cette tranche

`KRB-DATASET-GEN-001B` ne fournit pas :

- de contrat public de query d'entreprise ou de contact ;
- de route REST, méthode SDK TypeScript, commande CLI ou tool MCP de génération ;
- de Run de page, tentative, outbox, artifact, cursor ou receipt provider ;
- de record généré, décision de duplicate ou lineage page/Run/provider/coût ;
- de consommation atomique des huit caps, réservation ou règlement ;
- de provider lock, retry, fallback, résultat ambigu ou réconciliation ;
- de génération dérivée depuis une sélection d'entreprises ;
- de readiness ou d'export d'un dataset généré.

La tranche suivante `KRB-DATASET-GEN-001C` produit désormais une
[première page déterministe](./dataset-generation-first-page.md) par un Run
canonique, puis checkpoint son résultat durable sans rappeler l'adapter. Le
runtime paginé complet, l'arrêt, les surfaces publiques et la recherche
Company/Contact restent dans leurs tickets parents.

## Vérification locale

Avec le runtime Node épinglé par le dépôt :

```sh
npm run check
npm run typecheck
npm test
npm run build
```

Les scénarios PostgreSQL exigent `KUROBARA_TEST_POSTGRES_URL` vers une instance
locale autorisée à créer une base jetable. Le bundle ciblé passe `9/9` avec le
runtime épinglé. Il couvre le roll-forward depuis `0020`, le backfill exact des
imports `running`, `completed`, `failed` et vides, la préservation de l'ordre et
du payload des records, la reprise d'un import `running`, le refus fail-closed
d'une migration orpheline, la reconstruction et le replay sans effet. Les tests
applicatifs couvrent séparément les courses génération-versus-génération et
import-versus-génération avant allocation, ainsi que l'isolation workspace et
le replay sans mutation. Les tests de parsing PostgreSQL refusent séparément
les payloads malformés ou divergents.
