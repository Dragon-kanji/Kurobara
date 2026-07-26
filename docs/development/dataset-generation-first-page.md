# Première page durable d'une génération de dataset

## Statut et périmètre

`KRB-DATASET-GEN-001C` livre la première exécution réelle du runtime de
génération, uniquement comme fondation interne. Une génération `planned` peut
désormais créer une page `run_created`, la faire exécuter par le runtime `Run`
canonique, puis checkpoint les records et leur provenance dans PostgreSQL.

La preuve utilise l'adapter local
`deterministic-dataset-generation-page`. Elle n'appelle aucun réseau et
n'admet aucun provider company ou contact live. Aucune route REST, méthode SDK
TypeScript, commande CLI ou tool MCP de génération n'est ajoutée par cette
tranche.

## Une seule autorité d'effet

La génération ne possède pas de moteur d'effets parallèle. Son contrôleur :

1. verrouille la génération et retrouve la page existante en redelivery ;
2. dérive un input interne et un `RunPlan` mono-step stables ;
3. copie les routes admises dans leur ordre, sans choisir de provider ;
4. crée le `Run`, son event, son outbox et la liaison de page dans une seule
   transaction ;
5. laisse le routeur du runtime produire la `RoutingDecision`, la réservation,
   l'Attempt et l'`operation_key` ;
6. relit caps, budget, deadline et preuves de route dans la transaction
   `StartAttemptEffect`, juste avant le seuil d'effet.

Le dernier point est volontaire : une autorisation faite seulement à la
création du Run pourrait devenir périmée pendant l'attente de l'outbox. Le hook
de parent met atomiquement la génération `planned -> running`, la page
`run_created -> executing`, consomme une page et un appel, et réserve le coût.
Si cette projection est refusée, le Step ne franchit pas son seuil d'effet.

## Contrat interne de page

L'input normalisé lie notamment workspace, génération, plan, dataset, schéma,
query normalisée, fields et les huit caps. Il ne contient ni provider choisi,
ni endpoint, ni credential. Le résultat borné à 65 536 octets porte :

- `version: "1.0.0"` ;
- des items ordonnés avec `Record` Kurobara et hash canonique ;
- un cursor suivant interne ou `null` ;
- `hasMore` et `sourcePartitionCompleted` cohérents.

Une page vide n'est certaine que si elle est sans cursor, sans page suivante et
marquée comme partition terminée. Le parser échoue fermé sur clés inconnues,
scope ou schéma divergent, record invalide, hash incorrect, cursor incohérent,
doublon d'identité ou payload trop grand.

## Ordre durable et reprise

Le succès provider n'est pas le checkpoint métier. Le runtime persiste d'abord
l'Attempt réussi, son artifact normalisé, le règlement `UsageEntry`, la
réservation settled, puis le `ResultManifest` et le Run terminal. Le checkpoint
relit ensuite ce bundle depuis PostgreSQL ; son caller ne fournit aucun payload
provider ni coût à croire.

Dans une transaction unique, le checkpoint :

- valide toutes les identités Run, Step, Attempt, route, artifact, usage et
  manifest ;
- insère les records générés dans l'ordre de la page ;
- écrit leur lineage vers page, Run, route, coût et preuves de résultat ;
- déplace le coût génération de `reserved` vers `spent` ;
- avance les compteurs et la matérialisation ;
- verrouille le provider depuis la `RoutingDecision` ;
- marque la page `committed` avec un hash de checkpoint.

Une panne après le succès du Run mais avant ce checkpoint ne réexécute donc pas
l'adapter : la reprise relit l'artifact durable. Une redelivery dont toutes les
preuves sont identiques retourne `unchanged`. Une preuve divergente retourne un
conflit et ne réécrit aucun record.

Une issue inconnue conserve la réservation et projette page, génération et
matérialisation en `ambiguous`. Aucun retry facturable, fallback ou page
suivante ne doit être autorisé avant une réconciliation explicite.

## Persistance

La migration `0022_dataset_generation_first_page.sql` ajoute :

- le provider lock et la dernière page committée à `dataset_generations` ;
- `dataset_generation_pages`, liée aux inputs et preuves du Run ;
- une origine génération explicite dans `dataset_records`, sans faux import ;
- `dataset_generation_record_lineage`, append-only ;
- des guards de transitions monotones pour génération, page, records et
  lineage, en conservant celui de matérialisation introduit par la migration
  précédente.

Les imports existants conservent leur origine et leurs contraintes. Un record a
exactement une origine : import ou page de génération.

## Vérification locale

Les checks ciblés sont :

```sh
npm test -w @kurobara/kernel
npm test -w @kurobara/application
npm test -w @kurobara/adapter-effect-deterministic
npm test -w @kurobara/adapter-postgres
KUROBARA_TEST_POSTGRES_URL=postgresql://user@localhost/postgres \
  npm run integration:test:postgres
```

Les tests PostgreSQL utilisent des bases jetables. Ils vérifient notamment le
replay du même Run, le seuil caps/budget/deadline, l'ordre artifact-usage-manifest
avant checkpoint, la reprise sans second `execute`, la page vide certaine,
l'immutabilité du checkpoint et l'arrêt sur ambiguïté.

## Limites restantes

La matérialisation reste `building` après cette première page et le dataset
reste non consommable. Pagination page 2+, déduplication inter-pages,
terminaison `ready`, annulation, réconciliation positive, génération dérivée,
projection des issues certaines `failed`/`cancelled_before_effect`, providers
live et parité REST/SDK/CLI/MCP restent dans le parent `KRB-DATASET-GEN-001`.
