# Appliquer une recette par API, SDK et CLI

- Statut : **surface locale expérimentale pré-release**
- Opération canonique : `recipes.apply@1.0.0`
- Publication : **aucun package, endpoint hébergé ou support public**

La révision courante expose une passe d'application de recette par une seule
logique métier : `POST /v1/recipe-applications`,
`client.recipes.apply()` et `recipe apply`. La CLI utilise uniquement le SDK
HTTP. Elle n'importe ni l'application, ni PostgreSQL, ni un provider.

Cette commande enregistre ou rejoue la recette exacte, fige un graphe borné de
records et crée un `Run` durable pour chaque cellule à calculer. Elle n'attend
pas l'exécution des runs : son succès signifie que la passe de dispatch a été
persistée. La lecture et le polling durables sont documentés séparément dans
[le guide `recipe watch`](./recipe-watch-api-cli.md). Export durable, provider
et MCP restent hors de cette commande. Le worker peut ensuite exécuter les runs
avec les adapters BYOK Tavily/Exa composés explicitement ; `recipe apply` ne
contacte lui-même aucun provider.

## Prérequis locaux

Le dataset doit avoir terminé son import et contenir les champs source et cible
de la recette. La clé API vérifiée doit appartenir au même workspace et porter
simultanément :

- `recipes:register` ;
- `recipes:apply` ;
- `plans:quote`.

Le snapshot d'autorité autorise `plans:quote` et `recipes:apply`, le budget
demandé, la deadline et toutes les capabilities du workflow. Le snapshot de
workflow référencé par la recette doit déclarer `RecipeCellInput@1.0.0` comme
contrat d'entrée exact.
Sur cette révision du catalogue `0.12.0`, sa référence est :

```json
{
  "catalogFingerprint": "sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd",
  "catalogVersion": "0.12.0",
  "schemaFingerprint": "sha256:c40a6d60340e2fcc29415f4594b5b3f951da7a798d41a245bb63cecd1600eccd",
  "schemaId": "https://schemas.kurobara.invalid/schemas/recipes/cell-input/1.0.0",
  "schemaVersion": "1.0.0"
}
```

Ces valeurs proviennent du manifest généré suivi ; elles ne sont ni un endpoint
public, ni un registre distant. Après un changement de catalogue, utilisez la
référence de la révision exécutée.

Le [bundle opérateur suivi](../../examples/planning-bundle.v1.json) fournit
`authority_demo` et le workflow synthétique correspondant. Validez-le puis
appliquez-le avec le [bootstrap de planning local](./v1-foundation.md). Sa
validation ne contacte aucun provider ; la composition API ne rend exécutables
que les routes dont les credentials BYOK sont effectivement présents.

## Lancer une passe

Le fichier d'exemple suppose que le dataset de
[l'import local](./dataset-import-api-cli.md) est présent et que le bundle de
planning ci-dessus a été appliqué :

```sh
KUROBARA_API_URL='http://127.0.0.1:3000' \
KUROBARA_API_KEY='replace-with-local-bootstrap-key' \
npm run kurobara -- recipe apply \
  --request examples/recipe-apply/request.example.json
```

La clé peut aussi provenir de `--api-key-file`. Elle n'est jamais acceptée en
argument brut. `--request` doit désigner un fichier JSON UTF-8 régulier, non
symlink, d'au plus 64 Kio.

Un premier succès sur le dataset d'exemple retourne une passe semblable à :

```json
{
  "active_cell_count": 0,
  "application_id": "application_demo_org_website_v1",
  "application_replayed": false,
  "bound_cell_count": 0,
  "cached_cell_count": 0,
  "created_run_count": 1,
  "dataset_id": "dataset_demo_orgs",
  "recipe_id": "recipe_org_website",
  "recipe_replayed": false,
  "recipe_revision": "1.0.0",
  "total_cell_count": 1,
  "workspace_id": "workspace_demo"
}
```

Un replay immédiat de la même intention ne crée pas un second run :
`created_run_count` devient `0`, `bound_cell_count` devient `1` et les deux
indicateurs de replay deviennent `true`. La somme des compteurs de cellules est
toujours égale à `total_cell_count`.

## Identité, transaction et reprise

`application_id` est l'identité durable choisie par l'appelant. La réutiliser
avec le même dataset, la même recette, la même révision, la même limite et le
même graphe reprend la passe. La réutiliser pour une autre intention retourne
`idempotency-key-reused` sans écraser l'application existante.

Il n'existe pas de transaction globale sur tout le dataset. Chaque cellule
committe ensemble son plan, son input validé, son run, son événement, son
outbox, son `CellResult.pending` et sa liaison. Une erreur après plusieurs
cellules laisse ces cellules valides et rejouables ; relancer la même commande
ne traite que ce qui reste.

Les compteurs ont la signification suivante :

- `created_run_count` : nouveau run atomiquement créé pendant cette passe ;
- `bound_cell_count` : liaison exacte déjà présente ;
- `cached_cell_count` : résultat frais épinglé sans nouveau run ;
- `active_cell_count` : calcul exact déjà actif, souvent pour une autre
  application concurrente.

Une cellule `active` est liée durablement à cette application avant le retour de
la commande. Le même `CellResult` et le même `Run` convergent donc pour toutes
les applications observatrices sans nouveau calcul. Une application créée par
une passe interrompue peut encore exposer une cellule non liée ; `recipe watch`
retourne alors `needs_replay` et le replay exact reprend la passe sans changer
le lifecycle canonique du `Run`.

## Autorité, budget et erreurs

`cell_budget` est un budget **par cellule**, pas un plafond agrégé caché. Chaque
plan conserve cette limite et la deadline absolue, bornée par l'autorité. La
commande ne contacte aucun provider ; les runs restent `queued` jusqu'à leur
prise en charge par le worker configuré.

REST retourne des Problem Details RFC 9457. SDK et CLI conservent le même code
métier ; la CLI écrit le problème JSON sur stderr et utilise les mêmes codes de
sortie que `dataset import`. Ni input de cellule, ni record brut, ni credential,
ni diagnostic PostgreSQL n'est exposé.

Le SDK et la CLI ne retryent pas automatiquement une mutation. Un opérateur ou
un agent peut rejouer explicitement la même intention, avec la même autorité,
le même budget et la même deadline tant qu'ils restent valides.
