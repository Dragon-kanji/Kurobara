# Exporter directement une application de recette

- Statut : **surface locale expérimentale pré-release**
- Opération canonique : `recipe-applications.export@1.0.0`
- Publication : **aucun package, endpoint hébergé ou support public**

La révision courante expose la projection exacte d'une application de recette
par `POST /v1/recipe-application-exports`,
`client.recipeApplications.export()` et `recipe export`. Le fichier est encodé
en CSV ou JSONL depuis les liaisons durables de cette application, pas depuis le
dernier résultat connu pour chaque record.

Cette surface est un téléchargement direct recalculé. Elle ne crée ni
`export_id`, ni artifact stocké, ni URL signée, ni rétention, ni reprise par
offset. Ce futur lifecycle reste suivi par `API-002` et `ARTIFACT-001`.

## Prérequis locaux

L'API locale et PostgreSQL doivent être configurés comme dans la
[fondation V1](./v1-foundation.md). La clé API doit appartenir au workspace de
l'application et porter `recipes:export`. Cette permission donne accès aux
valeurs exportées ; `recipes:read`, utilisé par le snapshot agrégé, ne suffit
pas.

L'import du dataset doit être terminé et chaque cellule de l'application doit
être liée à un `CellResult` réussi avec une valeur explicite. Une application
incomplète, un résultat en échec ou une projection CSV sparse retourne
`recipe-application-export-unavailable` avant le succès HTTP.

## Appeler l'API

Le body JSON est fermé : il contient `application_id`, `format` et,
facultativement, `field_ids`. La sélection contient de un à 256 identifiants
uniques et son ordre devient celui des colonnes ou propriétés exportées.

```sh
curl --fail-with-body \
  --header "Authorization: Bearer ${KUROBARA_API_KEY}" \
  --header 'Content-Type: application/json' \
  --data '{
    "application_id": "application_demo_org_website_v1",
    "format": "jsonl",
    "field_ids": ["field_name", "field_website"]
  }' \
  --output ./application-demo.jsonl \
  'http://127.0.0.1:3000/v1/recipe-application-exports'
```

Avant d'envoyer `200`, l'application parcourt et encode toute la projection
sans retenir le fichier. Cette prévalidation fixe `Content-Length` et
`X-Kurobara-Content-SHA256`. Une deuxième passe streame ensuite les octets avec
backpressure et revérifie la même taille et le même hash. Le dernier chunk non
vide reste en attente jusqu'à la validation finale : un drift inattendu
interrompt le flux avant que le nombre d'octets annoncé puisse être publié.
Aucun Problem Details n'est injecté dans un fichier déjà commencé.

Un succès expose aussi les headers suivants :

- `Content-Type: text/csv; charset=utf-8` ou
  `application/x-ndjson` ;
- `Content-Disposition: attachment; filename="kurobara-recipe-application.csv"`
  ou le même nom en `.jsonl` ;
- `Cache-Control: private, no-store` ;
- `X-Content-Type-Options: nosniff`.

L'absence d'application et l'identifiant d'un autre workspace produisent le
même `recipe-application-not-found`. Un dépassement borné produit
`export-too-large`. Les détails de record, cellule, codec et PostgreSQL restent
expurgés.

## Consommer le SDK

Le SDK valide la requête, le media type, la longueur, le hash déclaré et les
headers de sécurité avant de retourner le stream :

```ts
const exported = await client.recipeApplications.export(
  {
    application_id: "application_demo_org_website_v1",
    field_ids: ["field_name", "field_website"],
    format: "jsonl",
  },
  { maxBytes: 16 * 1024 * 1024, signal },
);

for await (const chunk of exported.bytes) {
  // Transmettre chaque chunk vers une destination bornée.
}
```

`exported.bytes` est lazy et consommable une seule fois. Le SDK compte les
octets et recalcule le SHA-256 pendant la lecture, refuse une fin différente de
`contentLength` ou `contentSha256`, puis propage l'`AbortSignal`.

## Publier un fichier avec la CLI

La commande n'écrit jamais le fichier sur stdout et refuse `--output -` :

```sh
KUROBARA_API_URL='http://127.0.0.1:3000' \
KUROBARA_API_KEY='replace-with-local-bootstrap-key' \
npm run kurobara -- recipe export \
  --application-id application_demo_org_website_v1 \
  --format jsonl \
  --field-id field_name \
  --field-id field_website \
  --output ./application-demo.jsonl \
  --max-bytes 16777216 \
  --timeout-ms 300000
```

La clé peut aussi provenir de `--api-key-file` ; elle n'est jamais acceptée en
argument brut. La CLI crée dans le répertoire cible un temporaire non suivi de
symlink en mode `0600`, streame les octets, recalcule longueur et SHA-256 puis
synchronise et publie le fichier sans écraser une destination existante. Un
échec avant publication, un timeout, `SIGINT` ou `SIGTERM` retire le temporaire.
Une destination préexistante reste intacte. Le répertoire de destination doit
rester sous le contrôle du processus appelant : cette tranche ne prétend pas
résister à un processus hostile capable d'en remplacer les entrées pendant la
publication.

Un succès écrit un seul reçu JSON sur stdout :

```json
{
  "application_id": "application_demo_org_website_v1",
  "byte_count": 238,
  "format": "jsonl",
  "sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

La valeur ci-dessus est synthétique ; le reçu réel doit correspondre aux octets
du fichier. Un timeout retourne `75`, une interruption `130` et un échec de
publication locale `74`.

## Limites configurées

Les limites serveur ne viennent jamais de la requête :

| Variable API | Défaut | Maximum | Effet |
| --- | ---: | ---: | --- |
| `KUROBARA_MAX_EXPORT_BYTES` | 1 Gio | 1 Tio | borne le fichier prévalidé complet |
| `KUROBARA_MAX_EXPORT_RECORD_BYTES` | 16 Mio | 16 Mio | borne chaque record encodé |

Une valeur absente utilise le défaut ; une valeur invalide empêche le démarrage
de l'API. Le SDK utilise aussi un maximum client de 1 Gio par défaut. La CLI
borne `--max-bytes` entre 1 octet et 1 Tio et exige `--timeout-ms` entre 1 ms et
24 heures. Ces limites clientes peuvent être plus strictes, jamais élargir la
politique serveur.

## Limites de cette tranche

La prévalidation ajoute volontairement une lecture et un encodage complets
avant la passe streamée. Elle évite les erreurs prévisibles après les headers,
mais n'offre ni reprise, ni range, ni pagination. L'export ne déclenche aucun
provider, run, dépense ou mutation métier. Il n'inclut pas encore provenance,
fraîcheur, confiance ou coût dans le fichier.

MCP reste différé : transporter le fichier en JSON ou base64 créerait une fausse
parité et supprimerait les bornes du stream. La décision complète est enregistrée
dans [RFC-0007](../rfcs/0007-recipe-application-export.md).
