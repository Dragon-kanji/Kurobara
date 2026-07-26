# Suivre une application de recette par API, SDK et CLI

- Statut : **surface du candidat V1 headless local**
- Opération canonique : `recipe-applications.get@1.0.0`
- Publication : **aucun package, endpoint hébergé ou support public**

La révision courante expose une photographie durable d'une application de
recette par `GET /v1/recipe-applications/:application_id`,
`client.recipeApplications.get()` et `recipe watch`. PostgreSQL reste la source
de vérité : la CLI peut être interrompue puis relancée avec le même identifiant
sans perdre l'état observé et sans connaître Hatchet.

Cette tranche utilise un polling client borné. Elle ne livre ni SSE, ni cursor
d'événements, ni lifecycle supplémentaire pour l'application.

## Prérequis locaux

L'API locale et PostgreSQL doivent être configurés comme dans la
[fondation V1](./v1-foundation.md). La clé API doit appartenir au workspace de
l'application et porter `recipes:read`. Une application absente et une
application appartenant à un autre workspace retournent toutes deux
`recipe-application-not-found`.

`recipe apply` doit avoir enregistré l'application avant sa lecture. Une passe
interrompue peut laisser des cellules non liées ; le snapshot les expose sans
inventer un résultat.

## Lire une photographie

L'appel HTTP est une lecture JSON sans corps :

```sh
curl --fail-with-body \
  --header "Authorization: Bearer ${KUROBARA_API_KEY}" \
  "http://127.0.0.1:3000/v1/recipe-applications/application_demo_org_website_v1"
```

Le SDK TypeScript projette la même opération :

```ts
const snapshot = await client.recipeApplications.get({
  application_id: "application_demo_org_website_v1",
});
```

Une photographie en cours ressemble à :

```json
{
  "application_id": "application_demo_org_website_v1",
  "bound_cell_count": 1,
  "dataset_id": "dataset_demo_orgs",
  "failed_cell_count": 0,
  "pending_cell_count": 1,
  "recipe_id": "recipe_org_website",
  "recipe_revision": "1.0.0",
  "running_cell_count": 0,
  "skipped_cell_count": 0,
  "state": "running",
  "succeeded_cell_count": 0,
  "terminal": false,
  "total_cell_count": 1,
  "unbound_cell_count": 0,
  "workspace_id": "workspace_demo"
}
```

Les invariants sont vérifiés avant la réponse :

- `bound_cell_count + unbound_cell_count = total_cell_count` ;
- les cinq compteurs de statut totalisent `bound_cell_count` ;
- `terminal` vaut `true` uniquement pour `succeeded` ou
  `completed_with_errors`.

Les états dérivés ne constituent pas un second lifecycle métier :

| État | Sens opérateur |
| --- | --- |
| `needs_replay` | au moins une cellule n'est pas liée, généralement après une passe interrompue ; rejouer exactement `recipe apply` est sûr |
| `running` | toutes les cellules sont liées et au moins un résultat est `pending` ou `running` |
| `succeeded` | toutes les cellules ont réussi |
| `completed_with_errors` | toutes les cellules sont terminales et au moins une a échoué ou été ignorée |

## Attendre depuis la CLI

La commande exige une condition d'arrêt explicite :

```sh
KUROBARA_API_URL='http://127.0.0.1:3000' \
KUROBARA_API_KEY='replace-with-local-bootstrap-key' \
npm run kurobara -- recipe watch \
  --application-id application_demo_org_website_v1 \
  --timeout-ms 300000 \
  --poll-interval-ms 1000
```

La CLI poll uniquement le SDK HTTP. Elle n'accède pas à PostgreSQL, ne rejoue
pas `recipe apply` et n'exécute aucun provider. Elle écrit un unique objet JSON
sur stdout lorsqu'elle observe un état terminal ou `needs_replay`.

`--timeout-ms 0` effectue une lecture ponctuelle et retourne immédiatement le
snapshot. Pour une attente, le timeout est borné à 24 heures et l'intervalle à
100–60 000 ms. Une expiration écrit `cli-watch-timeout` sur stderr et retourne
`75` ; une interruption retourne `130`. Relancer la commande avec le même
`application_id` reprend depuis l'état PostgreSQL courant.

## Calcul partagé et limites

Lorsqu'une seconde application rencontre un calcul exact déjà actif, la liaison
vers le même `CellResult` et le même `Run` est maintenant persistée avant le
retour de `recipe apply`. Le calcul et son coût ne sont pas dupliqués ; sa
convergence devient visible par les deux applications.

Cette photographie expose uniquement des identités et compteurs agrégés. Elle
n'expose ni record brut, ni valeur enrichie, ni raison provider, ni artifact.
L'export direct détaillé est une opération séparée. L'annulation est disponible
par `runs.cancel`, et les providers Tavily/Exa s'exécutent dans le worker, pas
dans cette lecture. Le lifecycle d'export durable, SSE, MCP et la convergence
automatique d'une annulation active restent hors de cette opération de lecture ;
le scheduler durable porte cette convergence après fermeture prouvée des effets
et réservations.
