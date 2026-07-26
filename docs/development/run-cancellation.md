# Annulation headless d'un run

La révision courante expose une commande d'arrêt tenant-scoped sur les surfaces
REST, SDK TypeScript et CLI. Elle implémente `runs.cancel@1.0.0` et applique la
transition de domaine `RequestStop` dans la même transaction PostgreSQL que le
journal d'idempotence et les événements de lifecycle.

## Contrat et autorité

La route publique est :

```text
POST /v1/runs/{run_id}/cancel
```

Elle exige une API key vérifiée possédant `runs:cancel`. Le workspace vient
exclusivement de cette identité vérifiée : ni le chemin ni le body ne peuvent le
choisir. Un run absent et un run appartenant à un autre workspace produisent le
même problème `run-not-found`.

Le body JSON fermé contient seulement la clé d'idempotence :

```json
{
  "idempotency_key": "cancel-example-001"
}
```

`run_id`, une identité d'acteur, un workspace ou une raison envoyés dans le body
sont rejetés. La raison durable est fixée par le serveur à `requested`.

## Transitions réellement disponibles

| État au moment de la commande | État retourné | Garantie de cette tranche |
| --- | --- | --- |
| `queued` | `cancelled` | Aucun claim d'orchestration ne peut ensuite démarrer ce run. |
| `running` ou `waiting` | `cancelling` | La demande d'arrêt est durable ; aucun état terminal n'est inventé. |
| `ambiguous` | `ambiguous` | La demande est durable en attente d'une résolution prouvée. |

Un run actif ne converge donc pas encore automatiquement de `cancelling` vers
`cancelled` dans cette tranche. Cette convergence requiert le règlement des
travaux en vol par le worker ; la réponse de l'API ne la prétend pas.

La première commande acceptée écrit le snapshot, les événements et sa preuve de
commande atomiquement. La même combinaison run/clé/intention retourne ensuite le
snapshot durable avec `replayed: true`, sans nouvel événement. Une clé déjà liée
à un autre type de commande retourne `idempotency-key-reused` (`409`). Le SDK et
la CLI n'effectuent aucun retry automatique d'une mutation dont l'issue réseau
est inconnue ; l'opérateur peut rejouer explicitement la même clé.

Après une demande enregistrée sur un run `ambiguous`, la réconciliation peut
faire converger le run vers `completed`, `failed` ou `cancelled`. Une redelivery
exacte retourne alors ce snapshot terminal courant avec `replayed: true` ; elle
ne reconstruit pas artificiellement l'ancien état `ambiguous`.

## REST

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${KUROBARA_API_KEY}" \
  --header "Content-Type: application/json" \
  --data '{"idempotency_key":"cancel-example-001"}' \
  http://127.0.0.1:3000/v1/runs/run-example/cancel
```

Une réponse réussie est un snapshot canonique du run après la commande :

```json
{
  "aggregate_version": 2,
  "created_at_ms": 1752700000000,
  "event_sequence": 3,
  "replayed": false,
  "result_completeness": "none",
  "run_id": "run-example",
  "run_plan_id": "plan-example",
  "state": "cancelled",
  "workspace_id": "workspace-example"
}
```

## SDK TypeScript

```ts
const cancelled = await client.runs.cancel({
  idempotency_key: "cancel-example-001",
  run_id: "run-example",
});
```

Le SDK valide la requête et la réponse contre les schémas générés, projette
`run_id` dans le chemin, envoie uniquement `idempotency_key` dans le body et
rejette une réponse portant un autre run.

## CLI non interactive

```bash
npm run kurobara -- run cancel \
  --run-id run-example \
  --idempotency-key cancel-example-001
```

`KUROBARA_API_KEY` ou `--api-key-file` fournit le credential, et
`KUROBARA_API_URL` ou `--endpoint` sélectionne l'API. Le succès écrit exactement
un objet JSON sur stdout. Les erreurs de contrat ou d'API écrivent un Problem
Details JSON sur stderr et utilisent l'exit code généré par le catalogue.
