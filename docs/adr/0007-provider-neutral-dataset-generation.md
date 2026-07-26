# ADR-0007 — Génération provider-neutral de datasets

- Statut : **Accepté**
- Date : **2026-07-21**
- Décideur : Leandre Desmaretz
- RFC lié : [RFC-0008](../rfcs/0008-provider-neutral-dataset-generation.md)

## Contexte

Le candidat V1 matérialise un `Dataset` uniquement depuis un import CSV ou
JSONL. Le port de lecture, les foreign keys des records et les use cases de
recette et d'export déduisent donc la disponibilité du dataset depuis
`DatasetImport.state`.

Le prochain milestone doit pouvoir créer un dataset d'entreprises depuis une
query structurée, puis un dataset de contacts dérivé. Une recherche provider
est paginée, facturable et potentiellement ambiguë ; la représenter comme un
import artificiel nierait son effet externe. Créer une seconde famille de
datasets dupliquerait à l'inverse recettes, exports et règles de sécurité.

## Décision

Kurobara introduit une `DatasetMaterialization` origin-neutral, unique par
dataset. Son origine est `import` ou `generation` et sa readiness commune est
`building`, `ready`, `failed`, `cancelled` ou `ambiguous`. Seul `ready` rend le
dataset consommable par une recette, une génération dérivée ou un export.
Import et génération conservent leurs aggregates, ports et journaux propres ;
aucun faux `DatasetImport` n'est créé.

`DatasetGeneration` fige query provider-neutral, capability, schéma de sortie,
route ordonnée, autorité, budget, deadline et limites avant le premier effet.
Une query publique ne contient ni provider, endpoint ou DSL arbitraire.

Chaque page logique s'exécute dans un Run canonique mono-step. Elle réutilise
les tentatives, `operation_key`, outbox, réservation, règlement, artifact et
ambiguïté du runtime existant. Après un succès durable du Run, un checkpoint
atomique projette artifact, records, cursor, lineage, compteurs et références
de coût dans la génération. Une panne entre Run et checkpoint relit l'artifact
et ne rappelle pas le provider.

La route candidate reste immuable et le runtime Run est l'unique autorité qui
sélectionne puis persiste le provider. Un fallback compatible n'est possible
avant la première page qu'après un rejet certain avant effet, une erreur
certaine sans résultat ou une absence d'effet prouvée. Un résultat vide certain
est au contraire une page réussie : il est checkpointé et verrouille le
provider. Une issue ambiguë interdit fallback et nouvelle dépense.

Une génération dérivée référence un dataset source `ready` du même workspace
et fige sa sélection ordonnée. Chaque contact conserve la relation Kurobara
exacte vers `company_dataset_id` et `company_record_id`. Curseurs, identifiants,
références de règlement, éventuels receipts et opérations externes restent dans
une lineage interne restreinte, jamais dans les records publics, exports ou
logs. Chaque page dérivée checkpoint aussi sa partition source, y compris
lorsqu'elle est vide. Les payloads provider bruts ne sont pas conservés par
défaut.

## Conséquences

- le port de lecture et les consommateurs devront vérifier une readiness
  origin-neutral au lieu de `stored.import.state` ;
- la persistance devra backfiller les imports existants et découpler les records
  de leurs foreign keys import-only sans réencoder leur contenu ;
- chaque page ajoute un Run, mais aucun second moteur d'effets ;
- après le seuil durable d'effet, une annulation ferme les pages suivantes sans
  propager `runs.cancel` au Run engagé, afin qu'il puisse régler et produire son
  résultat certain ;
- le budget global de génération doit borner les allocations des Runs de page
  dans une seule unité provider-native ;
- les candidats de fallback doivent partager unité, échelle et sémantique de
  règlement, faute de quoi le plan reste mono-provider ;
- une génération `ambiguous` bloque page suivante et terminaison jusqu'à
  réconciliation ;
- une génération vide peut terminer `ready`, tandis que la gate sourcing exige
  séparément un résultat non vide ;
- un dataset borné reste utilisable, mais sa coverage et sa raison d'arrêt ne
  peuvent pas être présentées comme une couverture exhaustive ;
- `ResultManifest` et `UsageEntry` restent les preuves obligatoires ; une
  référence provider optionnelle exige une extension interne du bridge courant
  et ne peut pas être inventée ;
- aucun provider ni contrat public concret n'est disponible tant que les
  tickets d'admission, budget, runtime et capability ne sont pas livrés.

## Alternatives rejetées

- faux import par page ou réponse provider ;
- tables et exports séparés pour les datasets générés ;
- génération synchrone dans l'API ;
- un Run statique pour toute la pagination ;
- changement de provider après une page committée ;
- stockage par défaut des payloads provider bruts.

## Révision

Un nouveau RFC est requis pour rendre une matérialisation partielle
publiquement consommable, autoriser une génération union multi-provider,
changer la frontière de provider lock ou introduire une compatibilité qui
réécrit records, pages, coûts ou lineage déjà persistés.
