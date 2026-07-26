# Import dataset par API, SDK et CLI

- Statut : **surface locale expérimentale pré-release**
- Opération canonique : `datasets.import@1.0.0`
- Publication : **aucun package, endpoint hébergé ou support public**

La révision courante expose l'import initial d'un dataset par une seule logique
métier : `POST /v1/dataset-imports`, `client.datasets.import()` et
`dataset import`. La CLI utilise le SDK HTTP ; elle ne se connecte jamais à
PostgreSQL et ne duplique pas le use case.

L'application agrégée d'une recette est documentée séparément dans
[la tranche `recipe apply`](./recipe-apply-api-cli.md). Le polling durable et
l'export direct sont désormais documentés dans leurs guides respectifs ; le SSE
par run et le lifecycle d'export durable restent ouverts dans `API-002` et
`ARTIFACT-001`.

## Préparer l'instance locale

Installez le graphe verrouillé avec Node 24.14.0 et npm 10.9.4 :

```sh
npm ci
```

Configurez PostgreSQL, puis créez une clé locale portant la permission
`datasets:import` avec le
[bootstrap hors ligne](./v1-foundation.md). Démarrez
ensuite l'API loopback :

```sh
KUROBARA_DATABASE_URL='postgres://local-user@127.0.0.1:5432/kurobara' \
  npm run start:api
```

La clé n'est acceptée qu'en variable `KUROBARA_API_KEY` ou via
`--api-key-file`. La CLI n'accepte volontairement pas de secret en argument
direct. Deux sources de credential simultanées sont refusées.

## Importer la fixture suivie

La clé doit appartenir à `workspace_demo`, comme la fixture :

```sh
KUROBARA_API_URL='http://127.0.0.1:3000' \
KUROBARA_API_KEY='replace-with-local-bootstrap-key' \
npm run kurobara -- dataset import \
  --metadata examples/dataset-import/metadata.json \
  --source examples/dataset-import/source.jsonl
```

`--source -` lit les octets depuis stdin. Le document metadata contient le
SHA-256 exact du flux brut ; changer un seul octet exige de le recalculer. La
sortie de succès est un objet JSON unique sur stdout :

```json
{
  "batch_count": 1,
  "dataset_id": "dataset_demo_orgs",
  "error_count": 0,
  "import_id": "import_demo_orgs_v1",
  "item_count": 1,
  "record_count": 1,
  "replayed": false,
  "state": "completed",
  "workspace_id": "workspace_demo"
}
```

Un replay exact relit et revalide le flux, ne réécrit pas les records et
retourne `replayed: true`. Réutiliser `import_id` avec une définition, des
limites ou un hash différents retourne `dataset-import-conflict`. Un hash qui
ne correspond pas aux octets reçus retourne `dataset-source-mismatch` après
nettoyage des lots provisoires.

## Contrat de transport

REST exige `multipart/form-data` avec exactement deux parties et dans cet
ordre :

1. `metadata`, en `application/json` ;
2. `source`, en `text/csv` ou `application/x-ndjson` selon `format`.

Le SDK construit ce multipart comme un flux avec backpressure. Ni SDK, ni CLI,
ni adapter HTTP ne transforme le fichier en base64 ou ne le matérialise en
mémoire. Un ordre différent, une partie dupliquée ou un media type discordant
est refusé avant finalisation de l'import.

Les bornes par défaut sont :

- metadata HTTP : 64 Kio via `KUROBARA_MAX_BODY_BYTES` ;
- source HTTP : 1 Gio via `KUROBARA_MAX_IMPORT_BYTES` ;
- record : au plus 16 Mio, borné plus strictement par `max_record_bytes` ;
- lot : 1 à 1 000 items et 1 Kio à 64 Mio selon `batch_limits`.

La limite source est configurable jusqu'à 1 Tio ; l'augmenter ne change ni les
bornes par record/lot, ni le streaming. Cet import local ne contacte aucun
provider, ne dépense aucun budget économique et ne reçoit pas de deadline
métier. Un timeout client reste un timeout de transport, pas une autorité de
run.

## JSON d'erreur et codes de sortie

Une erreur API validée est écrite sans transformation sur stderr comme Problem
Details RFC 9457. Les erreurs locales utilisent aussi un objet JSON stable et
expurgé. Aucun stack trace, credential, chemin source ou payload de record n'est
émis.

| Code | Sens |
| --- | --- |
| `0` | succès |
| `2` | usage, configuration locale, requête, taille ou media type invalide |
| `3` | authentification ou autorisation refusée |
| `4` | ressource absente |
| `5` | conflit d'identité ou d'idempotence |
| `6` | rejet métier ou de données |
| `70` | réponse hors contrat ou erreur interne |
| `75` | réseau ou service temporairement indisponible |

La mutation n'est jamais retryée automatiquement par le SDK. L'appelant peut
rejouer explicitement le même `import_id`, la même définition et le même flux.
