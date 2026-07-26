# Recherche d'entreprises et de contacts par API et CLI

- Statut : **surface locale expérimentale pré-release**
- Opération principale : `organizations.discover@1.0.0`
- Shortlist contacts : `contacts.discover@1.0.0`
- Identité sélectionnée : `contacts.identity.reveal@1.0.0`
- Email professionnel : `contacts.work-email.resolve@1.0.0` puis
  `contacts.work-email.verify@1.0.0`
- Suivi : `dataset-generations.get@1.0.0`
- Résultats entreprises : `organizations.candidates.list@1.0.0`
- Résultats contacts : `contacts.candidates.list@1.0.0`
- Export générique : `datasets.export@1.0.0`
- Lifecycle d'une livraison Contact : `export-deliveries.get@1.0.0` et
  `export-deliveries.revoke@1.0.0`, qualifiés localement
- Restriction Contact : `contact-privacy.restrict@1.0.0`, qualifiée localement
- Annulation : `dataset-generations.cancel@1.0.0`
- Publication : **aucun package, endpoint hébergé ou support public**

La révision de travail actuelle permet de rechercher des entreprises sans
dataset d'entrée et sans CSV : la CLI `company search` construit une query
structurée, appelle le SDK HTTP, puis l'API planifie ou démarre une génération
durable dans PostgreSQL. En mode `start`, le worker exécute les pages via
Hatchet et l'adapter Hunter configuré dans les deux processus. L'adapter est
qualifié hors ligne et sa première page a aussi passé un probe BYOK live
expurgé le 22 juillet 2026.

À partir d'une génération Entreprises `ready`, la même verticale sait aussi
créer une shortlist Contact par REST, SDK et CLI avec Prospeo Search Person en
BYOK. L'adapter ne projette ni email ni téléphone : son identité publique est
explicitement `obfuscated` et le `person_id` Prospeo reste dans la lineage
restreinte. Search Person demande uniquement des profils dont un email vérifié
est disponible et demande au provider de masquer les coordonnées déjà révélées.
Comme Prospeo peut néanmoins retourner une coordonnée en clair, l'adapter
quarantaine et ignore chaque ligne concernée avant normalisation ou persistance.

La verticale locale sait maintenant dériver, pour une sélection explicite de
un à trois records Contact, un dataset d'identité complète puis un dataset
d'email professionnel vérifié avec Prospeo Enrich Person et, si le client le
demande, une vérification Hunter distincte. Hunter Finder reste aussi une route
alternative choisie comme route initiale par l'ordre provider explicite ; les
générations Contact actuelles n'effectuent aucun failover automatique et une
absence de résultat Prospeo ne le déclenche pas. Chaque étape
crée une `DatasetGeneration` durable, préserve les IDs de record sélectionnés et expose
la même intention par REST, SDK TypeScript et CLI. Le dataset final peut être
exporté exactement en CSV ou JSONL. Cette tranche suit
[RFC-0011](../rfcs/0011-selected-contact-derived-datasets.md).

L'implémentation locale prolonge l'export d'un dataset Contact généré avec un
registre de livraison `2.0.0`, un TTL dérivé côté serveur et des surfaces
owner-only. Une restriction exacte lie atomiquement son tombstone aux
livraisons correspondantes. Cette tranche suit
[RFC-0012](../rfcs/0012-contact-export-delivery-lifecycle.md). Elle est
qualifiée par les suites application/HTTP/SDK/CLI, une intégration PostgreSQL
réelle et un dump/restore ; le harness provider live du 22 juillet lui est
antérieur et ne prouve donc pas ce lifecycle.

Le 22 juillet 2026, le harness borné a traversé la verticale réelle
CLI → API → PostgreSQL → Hatchet → providers → CSV privé. Il a matérialisé
trois entreprises, deux contacts masqués, puis une identité et un email
professionnel `found-and-valid`, avec quatre requêtes provider au maximum. Le
fichier exporté, les données personnelles temporaires et l'infrastructure
jetable ont été supprimés à la fin du run. Cette preuve locale ne constitue ni
une release publique ni un droit de redistribution des données provider.

Cette surface ne retourne pas les entreprises dans la réponse de recherche.
Elle retourne les identités du plan et, en mode `start`, de la génération.
`company watch` expose ensuite l'état, les compteurs et le coût. Une fois la
matérialisation `ready`, `company results` lit ses `CompanyCandidate` par pages
bornées et provider-neutral. Aucun export durable ou droit de redistribution
des données provider n'est créé par cette lecture.

## Vérité des surfaces courantes

| Besoin | REST | SDK TypeScript | CLI | Composition réelle |
| --- | --- | --- | --- | --- |
| Rechercher des entreprises | `POST /v1/organization-discoveries` | `organizations.discover()` | `company search` | Oui, avec la route Hunter si `HUNTER_API_KEY` est présente dans l'API |
| Lire une génération | `GET /v1/dataset-generations/{generation_id}` | `datasetGenerations.get()` | `company watch` | Oui, lecture PostgreSQL avec `datasets:read` |
| Lire les entreprises prêtes | `GET /v1/dataset-generations/{generation_id}/company-candidates` | `organizations.listCandidates()` | `company results` | Oui, pages keyset de 1 à 100 records avec `datasets:read` ; génération `ready` uniquement |
| Lire les contacts prêts | `GET /v1/dataset-generations/{generation_id}/contact-candidates` | `contacts.listCandidates()` | `contact results` | Oui, pages keyset de 1 à 100 records sans email ni téléphone, avec `datasets:read` ; génération `ready` uniquement |
| Demander l'arrêt | `POST /v1/dataset-generations/{generation_id}/cancel` | `datasetGenerations.cancel()` | `company cancel` | Oui, demande durable et idempotente avec `datasets:generate` |
| Rechercher des contacts | `POST /v1/contact-discoveries` | `contacts.discover()` | `contact search` | Oui, route Prospeo traversée par le harness durable live ; shortlist sans coordonnée publique et secret privacy partagé requis |
| Révéler l'identité complète d'une sélection | `POST /v1/contact-identity-reveals` | `contacts.revealIdentities()` | `contact reveal-identity` | Oui, sélection exacte de 1 à 3 records traversée par le harness durable live avec Prospeo |
| Résoudre un email professionnel | `POST /v1/contact-work-email-resolutions` | `contacts.resolveWorkEmails()` | `contact enrich-email` | Oui, email Prospeo `found-and-valid` traversé par le harness durable live ; Hunter Finder est une route initiale alternative sur ordre explicite, pas un failover automatique après erreur ou `not_found` |
| Vérifier un email professionnel | `POST /v1/contact-work-email-verifications` | `contacts.verifyWorkEmails()` | `contact verify-email` | Oui localement avec Hunter Verifier et secret privacy partagé ; l'appel reste une décision explicite du client |
| Exporter un dataset | `POST /v1/dataset-exports` | `datasets.export()` | `dataset export` | Oui localement en CSV ou JSONL déterministe ; Contact ajoute un reçu de livraison, un TTL et un manifest dérivés côté serveur |
| Lire l'état d'une livraison Contact | `GET /v1/export-deliveries/{delivery_id}` | `exportDeliveries.get()` | `dataset export-status` | Oui localement ; owner-only avec `contacts:export`, état borné sans manifest ni PII |
| Révoquer une livraison Contact | `POST /v1/export-deliveries/{delivery_id}/revoke` | `exportDeliveries.revoke()` | `dataset export-revoke` | Oui localement ; owner-only, idempotent et succès limité à l'état `revoked`, sans promesse de rappeler un fichier déjà reçu |
| Restreindre un sujet Contact | `POST /v1/contact-privacy-restrictions` | `contactPrivacy.restrict()` | `contact restrict` | Oui localement ; `contacts:privacy`, tombstone-first et propagation transactionnelle vers les livraisons liées |

Les projections MCP de ces opérations sont différées. La présence d'un
contrat, d'une route HTTP, d'une méthode SDK ou d'une commande ne constitue pas
à elle seule une preuve de composition. En particulier, Hunter `Domain Search`
révèle des emails avant sélection ; il est donc explicitement inadmissible pour
la shortlist `contacts.discover` actuelle. Voir
[la politique de données de contact](../policies/contact-data-handling.md).
L'admission technique locale ne vaut pas approbation des conditions provider
pour une distribution OSS.

## Prérequis locaux

Installez le graphe verrouillé avec Node 24.14.0 et npm 10.9.4 :

```sh
npm ci
```

L'API et le worker doivent partager la même instance PostgreSQL et les mêmes
snapshots de planning. Pour l'authentification HTTP, provisionnez une clé locale
liée au sujet et au workspace de l'enveloppe d'autorité, comme décrit dans
[la fondation V1](./v1-foundation.md). Le parcours complet utilise les
permissions suivantes :

- `datasets:generate` et `plans:quote` pour `company search` ;
- `datasets:generate`, `plans:quote` et `contacts:discover` pour
  `contact search` ;
- `contacts:enrich` et `plans:quote` pour `contact reveal-identity`,
  `contact enrich-email` et `contact verify-email` ;
- `steps:execute` pour autoriser les Runs de page en mode `start` ;
- `datasets:read` pour `company watch`, `company results` et `contact results` ;
- `datasets:export` pour `dataset export`, plus `contacts:export` lorsque le
  schéma exporté est un dataset Contact dérivé ;
- `contacts:export` pour `dataset export-status` et
  `dataset export-revoke`, avec le même owner authentifié que la livraison ;
- `contacts:privacy` pour `contact restrict` ;
- `datasets:generate` pour `company cancel` ;
- `capabilities:list` uniquement pour le readback optionnel de capability.

La CLI accepte le credential Kurobara soit dans `KUROBARA_API_KEY`, soit via
`--api-key-file`, jamais les deux. Le fichier est lu comme un fichier régulier
non symlink de 4 Kio maximum et peut contenir un unique saut de ligne final.

### Secret privacy stable pour les contacts sélectionnés

Les routes d'identité, d'email et leurs effets worker ne sont composés qu'avec
une configuration HMAC stable, identique dans l'API et le worker. La révision de
travail accepte de préférence
`KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON` : un tableau de une à seize entrées
fermées `{current, secret, version}`, avec versions uniques, secrets d'au moins
32 octets et exactement une clé courante.

L'exemple suivant n'utilise que des secrets factices :

```sh
export KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON='[
  {
    "current": false,
    "secret": "synthetic-do-not-use-contact-hmac-key-v1-000000",
    "version": "v1"
  },
  {
    "current": true,
    "secret": "synthetic-do-not-use-contact-hmac-key-v2-000000",
    "version": "v2"
  }
]'
```

Pour une nouvelle rotation, ajoutez d'abord la nouvelle version, gardez les
anciennes et marquez exactement une entrée `current=true`. Ne retirez une
ancienne version qu'après migration et readback prouvant qu'aucun tombstone ou
lien actif n'en dépend.

Les variables legacy `KUROBARA_CONTACT_PRIVACY_HMAC_SECRET` et
`KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION` restent acceptées ; la version
vaut `v1` par défaut. Ne les définissez jamais en même temps que le keyring.
Ne placez jamais une valeur réelle dans ce guide, un fichier suivi, la ligne de
commande ou un log.

Si aucune configuration n'est présente, la recherche d'entreprises et la
shortlist peuvent rester disponibles, mais les routes provider de contact
sélectionné sont intentionnellement absentes et répondent comme un service non
composé. Un secret éphémère par process est invalide pour ce parcours durable.

L'API consulte permissions et tombstones avant de créer une génération
sélectionnée. Le worker relit les tombstones après validation de la quote, au
dernier point certain avant l'appel provider. Une restriction tardive ferme
donc l'effet sans exposer le sujet concerné.

### Policy locale des exports Contact

Un dataset Contact généré n'est exportable que si le process API possède une
policy locale explicite dans `KUROBARA_CONTACT_EXPORT_POLICY_JSON`. Elle ne doit
pas venir des arguments de la CLI ou du payload REST. Son absence laisse les
exports non-Contact disponibles, mais fait échouer l'export Contact fermé.

Le document JSON accepte exactement :

- `policy_version`, `purpose_ref`, `territory` et `policy_ttl_ms` ;
- `max_retention_ms`, avec une durée positive pour chaque classe exportable ;
- `provider_rights`, indexé par le namespace provider exact de la lineage, avec
  `mode`, `ttl_ms` et `version`.

Exemple local synthétique pour la route Prospeo principale :

```sh
KUROBARA_CONTACT_EXPORT_POLICY_JSON="$(
  node -e '
    process.stdout.write(JSON.stringify({
      policy_version: "local-contact-export-v1",
      purpose_ref: "b2b-contact-export",
      territory: "ES",
      policy_ttl_ms: 3600000,
      max_retention_ms: {
        "contact-identity": 86400000,
        employment: 86400000,
        "professional-social-profile": 86400000,
        "professional-email": 86400000
      },
      provider_rights: {
        "prospeo-person-search": {
          mode: "operator-authorized-byok",
          ttl_ms: 3600000,
          version: "operator-policy-v1"
        }
      }
    }));
  '
)"
export KUROBARA_CONTACT_EXPORT_POLICY_JSON
```

Ces valeurs démontrent le format, pas une recommandation juridique ou un droit
de redistribution. Un dataset dont la lineage nomme un autre provider exige une
entrée correspondante. La durée effective de livraison est le minimum entre la
policy, les droits provider et chaque observation plus sa rétention.

Le keyring est exercé avec une clé courante et une clé historique, puis un
dump/restore PostgreSQL relit tombstone, livraison révoquée, aliases et preuve
sans PII. Le drill exige des binaires `pg_dump` et `pg_restore` du même major que
le serveur. Le retrait d'une ancienne version et la répétition sur le candidat
clean-room exact restent des gates de publication.

### Planning requis

Le bundle suivi
[`examples/planning-bundle.company-contact.v1.json`](../../examples/planning-bundle.company-contact.v1.json)
admet les cinq capabilities de la verticale métier et sert au harness local. Il
utilise volontairement `workspace-b2b-dogfood` et `actor-b2b-dogfood` : ce n'est
pas une configuration générique à appliquer telle quelle dans un workspace
opérateur. Validez sa structure sans base avec :

```sh
npm run --silent bootstrap:planning -w @kurobara/api -- \
  --check --file examples/planning-bundle.company-contact.v1.json
```

Un manifest opérateur dérivé doit au minimum relier exactement :

- le même `workspaceId` et le même `subjectActorId` que la clé API ;
- `organizations.discover@1.0.0` dans `capabilities` ;
- `datasets:generate`, `plans:quote` et `steps:execute` dans l'autorité ;
- une policy active dont `requiredPermission` vaut `datasets:generate` ;
- une pricing active en unité `requests`, cohérente avec le budget ;
- une deadline d'autorité future et une quote TTL assez longue pour le
  `dry-run`, le `start` et les pages autorisées.

Le bootstrap accepte `workflows: []` pour ces capabilities de génération. Le
manifest reste un fichier JSON UTF-8 strict, non symlink, non inscriptible par
le groupe ou le monde et limité à 1 Mio. Validez-le sans base, puis appliquez-le
à PostgreSQL :

```sh
npm run --silent bootstrap:planning -w @kurobara/api -- \
  --check --file "${KUROBARA_COMPANY_PLANNING_FILE:?}"

KUROBARA_DATABASE_URL="${KUROBARA_DATABASE_URL:?}" \
  npm run --silent bootstrap:planning -w @kurobara/api -- \
    --apply --file "${KUROBARA_COMPANY_PLANNING_FILE:?}"
```

Pour un workspace déjà configuré, `expectedDefaultsRevision` doit reprendre la
révision courante lue par `bootstrap:planning --read`; `null` est réservé à la
première activation.

Pour la shortlist, le même manifest doit fournir une entrée séparée pour
`contacts.discover@1.0.0`, autoriser `datasets:generate`, `plans:quote`,
`contacts:discover` et `steps:execute`, puis déclarer une pricing en unité
`requests`. La génération Entreprises référencée par
`--organization-generation-id` doit déjà être `ready` dans le même workspace.

Pour la chaîne sélectionnée, le planning doit aussi admettre séparément
`contacts.identity.reveal@1.0.0`, `contacts.work-email.resolve@1.0.0` et
`contacts.work-email.verify@1.0.0`, avec `contacts:enrich`, `plans:quote` et une
pricing cohérente avec l'unité passée par la CLI. Les Runs de page exigent
`steps:execute` selon le snapshot de planning. Une seule
`DatasetGeneration` porte le budget agrégé de chaque sélection ; il n'existe pas
de ledger Contact parallèle.

Dans le bundle de dogfood, chaque pricing porte une borne dure de une requête et
la policy limite chaque étape à une tentative. Le `budgetLimit.limit=4` de
l'enveloppe d'autorité ne forme pas à lui seul un ledger global partagé entre
les quatre générations : la borne totale du run est obtenue par la topologie
fixe du harness, une génération par effet et une tentative au plus par étape.
Le harness refuse de démarrer sans confirmation explicite des appels provider :

```sh
npm run b2b:dogfood:preflight
npm run b2b:dogfood -- run --confirm-provider-calls
```

Le preflight vérifie configuration et présence des credentials sans appeler de
provider. Le run réel est borné à trois entreprises, trois contacts shortlistés
et quatre requêtes provider au total ; il enrichit un seul contact sélectionné.

### Credential Hunter, sans readback du secret

`HUNTER_API_KEY` est un credential owner-only fourni par l'opérateur. Kurobara
n'en assure ni stockage durable, ni rotation, ni révocation. Le registre API
vérifie seulement sa présence stricte pour construire un descriptor non secret ;
le worker l'utilise ensuite pour construire l'adapter. La valeur n'est pas
conservée dans les routes, sorties ou diagnostics testés.

Configurez la même variable dans l'API et le worker. Une vérification
metadata-only ne doit tester que la présence et ne doit jamais imprimer la
valeur :

```sh
test -n "${HUNTER_API_KEY:-}" || {
  printf '%s\n' 'HUNTER_API_KEY is required' >&2
  exit 1
}
```

N'activez pas `set -x`, ne passez pas la valeur sur la ligne de commande et ne
la placez pas dans un fichier suivi. `KUROBARA_PROVIDER_ORDER='hunter'` borne ce
démarrage Entreprises à la seule route configurée ici. La chaîne Contact
utilise plus bas l'ordre explicite `prospeo,hunter`. Les droits contractuels,
territoriaux et de redistribution restent à la charge de l'opérateur.

### Qualification live bornée du 22 juillet 2026

Un appel Hunter Discover réel a été exécuté avec la clé BYOK de l'opérateur,
sans imprimer ni journaliser le secret. L'adapter a demandé la taille de page
provider par défaut de 100 puis Kurobara a appliqué localement un cap
`max_companies` de 1. Le résultat normalisé contient exactement un candidat et
un usage d'une requête ; aucun payload brut provider n'a été conservé.

Cette preuve qualifie uniquement la première page et le petit cap local. Elle ne
prouve ni les offsets ou tailles de page réservés aux plans Hunter Premium, ni
les droits de stockage, d'export ou de redistribution du plan de l'opérateur.
Le modèle reste BYOK owner-only : chaque utilisateur apporte son propre compte,
sa clé, ses quotas et ses droits.

### Credential Prospeo et état de qualification

`PROSPEO_API_KEY` active Search Person pour `contacts.discover@1.0.0`, puis
Enrich Person pour `contacts.identity.reveal@1.0.0` et
`contacts.work-email.resolve@1.0.0`. Comme pour Hunter, la valeur est fournie à
l'API et au worker, reste en mémoire des processus et ne doit jamais apparaître
dans un plan, un log ou un fichier suivi. Une vérification locale porte
uniquement sur sa présence :

```sh
test -n "${PROSPEO_API_KEY:-}" || {
  printf '%s\n' 'PROSPEO_API_KEY is required' >&2
  exit 1
}
```

Chaque page durable groupe au plus dix entreprises du snapshot et provoque au
plus une requête Prospeo. La route applique les caps `max_companies`,
`max_contacts_per_company`, `max_contacts_total`, `max_pages`, `max_calls`, le
budget `requests` et la deadline. Search Person lie chaque résultat au domaine
exact de l'entreprise du snapshot, mappe les filtres de département et de
séniorité supportés, demande la disponibilité d'un email vérifié et demande de
masquer les profils déjà révélés. Toute ligne qui contient malgré cela un email
ou un mobile en clair est abandonnée avant normalisation et persistance.

L'identité sélectionnée reste liée au `person_id` exact relu dans la lineage.
Un changement d'employeur courant renvoyé au moment de l'enrichissement ne mute
pas l'emploi de la shortlist source. La résolution email échoue en revanche
fermée si le domaine ne correspond ni au domaine attendu ni à un domaine que
Prospeo confirme comme appartenant à la même entreprise au nom comparable.

La qualification réseau bornée du 22 juillet 2026 a chargé la clé depuis
`.env.local` sans l'afficher. Search Person a répondu HTTP 200 avec un résultat
utilisable sans email/mobile public et un `person_id` stable. Enrich Person sur
ce seul sujet, avec
`only_verified_email=true` et `enrich_mobile=false`, a répondu HTTP 200 avec
une identité complète, un email professionnel vérifié du domaine attendu et
aucun mobile. Aucun secret, identifiant ou contact n'a été conservé. La
[référence Search Person](https://prospeo.io/api-docs/search-person) documente
25 résultats par page et un crédit pour une page non vide ; la
[référence des filtres](https://prospeo.io/api-docs/filters-documentation)
documente le filtre de disponibilité des coordonnées ; la
[référence Enrich Person](https://prospeo.io/api-docs/enrich-person) documente
l'enrichissement par `person_id`. Kurobara force toujours
`enrich_mobile=false`.

Enrich Person peut renvoyer l'email en même temps que l'identité. L'étape
`contact reveal-identity` supprime cet email incident de sa projection, mais
l'appel peut tout de même consommer le crédit provider associé. Prospeo annonce
qu'un ré-enrichissement de la même personne est gratuit pendant 90 jours ; ce
comportement n'est pas une garantie Kurobara. Le budget durable réserve des
unités `requests` et ne constitue pas un devis exact de crédits Prospeo.

Apollo reste activable en opt-in avec `APOLLO_API_KEY` et un
`KUROBARA_PROVIDER_ORDER` qui contient explicitement `apollo`. Il n'appartient
plus à l'ordre par défaut après le `403` observé sur People Search. PDL demeure
un candidat offline secondaire et n'est pas une route active.

`HUNTER_API_KEY`, déjà utilisée pour la recherche d'entreprises, compose aussi
la route alternative `hunter-email-finder-prospeo` et la vérification
`hunter-email-verifier-prospeo` lorsque le secret privacy est présent. La
résolution Prospeo, Finder Hunter et Verifier restent des routes, quotes et
dépenses distinctes. L'ordre provider peut sélectionner Finder comme route
initiale. Le plan Contact actuel borne `maxAttemptsPerStep` à `1` : il ne
bascule donc pas automatiquement après une indisponibilité, et un
`NO_MATCH`/`not_found` Prospeo ne le déclenche pas. Les adapters
et la gate synthétique sont qualifiés hors ligne ; les endpoints email Hunter
n'ont pas encore de preuve live sur cette révision.

## Démarrer l'API

Le `dry-run` exige PostgreSQL, l'API, la clé Kurobara, le planning et la
présence de `HUNTER_API_KEY`. Il n'exige ni worker ni Hatchet et n'appelle pas
Hunter. Il persiste toutefois un plan immuable : il est sans effet provider,
pas sans écriture en base.

Dans un premier terminal :

```sh
NODE_ENV='development' \
KUROBARA_DATABASE_URL="${KUROBARA_DATABASE_URL:?}" \
KUROBARA_PROVIDER_ORDER='hunter' \
HUNTER_API_KEY="${HUNTER_API_KEY:?}" \
  npm run start:api
```

Par défaut, l'API écoute `127.0.0.1:3000`. Un host non loopback exige
explicitement `KUROBARA_ALLOW_NON_LOOPBACK=true` et n'est pas qualifié par ce
guide. Le readback de readiness ne révèle aucun credential :

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/readyz
```

Avec une clé possédant `capabilities:list`, le readback suivant doit inclure
`organizations.discover@1.0.0`. Il prouve l'intersection entre route composée et
autorité, pas la validité live du credential Hunter :

```sh
curl --fail-with-body --get \
  --header "Authorization: Bearer ${KUROBARA_API_KEY:?}" \
  --data-urlencode 'authority_envelope_id=authority-company-local' \
  http://127.0.0.1:3000/v1/capabilities
```

Remplacez `authority-company-local` par l'identité réellement appliquée ; ce
nom n'est pas créé automatiquement par Kurobara.

## Faire un dry-run, puis démarrer

Le bloc suivant utilise uniquement des identités synthétiques, ne lit aucun CSV
et ne demande aucun prompt. Il produit une nouvelle clé d'idempotence à chaque
exécution. Le pays doit être un code ISO alpha-2 majuscule. L'adapter Hunter
actuel accepte un seul pays et les secteurs provider-neutral `gaming` ou
`software` ; d'autres codes passent le contrat générique mais seront refusés par
l'adapter au seuil d'effet.

```sh
company_run_suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
company_deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
company_dataset_id="dataset-company-synthetic-${company_run_suffix}"
company_discovery_id="discovery-company-synthetic-${company_run_suffix}"

npm run kurobara -- company search \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --authority-envelope-id authority-company-local \
  --budget-limit 1 \
  --budget-unit requests \
  --country ES \
  --dataset-id "${company_dataset_id}" \
  --dataset-name 'Synthetic companies' \
  --deadline-ms "${company_deadline_ms}" \
  --discovery-id "${company_discovery_id}" \
  --industry gaming \
  --max-calls 1 \
  --max-companies 20 \
  --max-pages 1 \
  --mode dry-run
```

Une sortie valide a `mode: "dry-run"`, `state: "planned"`, aucun
`generation_id`, les hashes immuables et une quote en `requests`. Le replay
exact avec le même `discovery_id` renvoie le même plan avec `replayed: true`.
Réutiliser cette clé avec un pays, budget, cap, deadline ou dataset différent
retourne `idempotency-key-reused`.

Pour promouvoir exactement le même plan avant expiration de sa quote, relancez
les mêmes arguments avec `--mode start`. La valeur de `mode` n'élargit pas
l'intention persistée ; le serveur crée alors la génération et autorise au plus
la première page :

```sh
company_start_json="$(
  npm run --silent kurobara -- company search \
    --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
    --endpoint http://127.0.0.1:3000 \
    --authority-envelope-id authority-company-local \
    --budget-limit 1 \
    --budget-unit requests \
    --country ES \
    --dataset-id "${company_dataset_id}" \
    --dataset-name 'Synthetic companies' \
    --deadline-ms "${company_deadline_ms}" \
    --discovery-id "${company_discovery_id}" \
    --industry gaming \
    --max-calls 1 \
    --max-companies 20 \
    --max-pages 1 \
    --mode start
)"
printf '%s\n' "${company_start_json}"

company_generation_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.generation_id !== "string") process.exit(1);
    process.stdout.write(value.generation_id);
  ' "${company_start_json}"
)"
```

Le succès initial retourne normalement `state: "building"`. Il ne prouve ni un
appel Hunter ni un dataset prêt ; seule la convergence observée par `watch`
porte cette preuve.

Les bornes d'effectif sont optionnelles mais doivent être fournies ensemble.
Hunter n'accepte actuellement que des unions exactes de ses buckets : `1-10`,
`11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000` et
`10001+`. Par exemple, `--employee-minimum 11 --employee-maximum 200` est
admis ; `--employee-minimum 12` ne l'est pas. `--keyword` est répétable et
Hunter applique un match de tous les keywords.

## Démarrer le worker et Hatchet pour `start`

Le worker est requis pour transformer `building` en un état terminal. Il exige
PostgreSQL, une instance Hatchet explicite et son token, les identités de ses
services, `KUROBARA_LEAF_EFFECT_ADAPTER='configured-providers'`, l'ordre
`hunter` et le même `HUNTER_API_KEY` que l'API. Le
[harness Hatchet local](../../infra/hatchet/README.md) documente la topologie
loopback de qualification ; il ne fournit pas un service hébergé.

Dans un second terminal dont les variables `HATCHET_CLIENT_*` pointent vers
votre instance locale :

```sh
NODE_ENV='development' \
KUROBARA_DATABASE_URL="${KUROBARA_DATABASE_URL:?}" \
KUROBARA_DISPATCHER_ID='company-dispatcher-local-1' \
KUROBARA_LEAF_DISPATCHER_ID='company-leaf-dispatcher-local-1' \
KUROBARA_LEAF_EFFECT_ADAPTER='configured-providers' \
KUROBARA_LEAF_EFFECT_RECONCILER_ID='company-effect-reconciler-local-1' \
KUROBARA_RECONCILER_ID='company-reconciler-local-1' \
KUROBARA_ROUTE_SCHEDULER_ID='company-route-scheduler-local-1' \
KUROBARA_WORKER_ID='company-worker-local-1' \
KUROBARA_PROVIDER_ORDER='hunter' \
HUNTER_API_KEY="${HUNTER_API_KEY:?}" \
HATCHET_CLIENT_API_URL="${HATCHET_CLIENT_API_URL:?}" \
HATCHET_CLIENT_HOST_PORT="${HATCHET_CLIENT_HOST_PORT:?}" \
HATCHET_CLIENT_TLS_STRATEGY="${HATCHET_CLIENT_TLS_STRATEGY:?}" \
HATCHET_CLIENT_NAMESPACE="${HATCHET_CLIENT_NAMESPACE:?}" \
HATCHET_CLIENT_TOKEN="${HATCHET_CLIENT_TOKEN:?}" \
  npm run start:worker
```

Le worker applique les migrations en développement et les vérifie par défaut
en production. Il démarre l'executor Hatchet, les dispatchers et reconcilers,
le scheduler de routage/DAG et le scheduler paginé des générations. Une API
seule peut accepter `start`, mais la génération restera sans exécuteur tant que
ce worker et Hatchet ne sont pas disponibles.

## Suivre la génération

Une lecture ponctuelle utilise `--timeout-ms 0` :

```sh
npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${company_generation_id:?}" \
  --timeout-ms 0
```

Pour attendre un état terminal avec un polling borné :

```sh
npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${company_generation_id:?}" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000
```

Le timeout accepte `0` à 86 400 000 ms ; l'intervalle accepte 100 à
60 000 ms et vaut 1 000 ms par défaut. La CLI retourne un unique objet JSON à
la première lecture ponctuelle ou lorsqu'elle observe `terminal: true`. Les
états terminaux sont `completed`, `failed`, `cancelled` et `ambiguous`.
`completed` avec `materialization_state: "ready"` et les compteurs attendus est
la preuve de convergence durable. `ambiguous` est un arrêt fail-closed, pas un
succès partiel implicite. Interrompre le processus de watch ne demande pas
l'arrêt de la génération ; seule la commande `company cancel` le fait.

## Lire les entreprises matérialisées

`company results` exige une génération `completed` dont la matérialisation est
`ready`. La commande utilise uniquement le SDK HTTP et la permission
`datasets:read` : elle ne relance aucun provider et ne lit pas PostgreSQL
directement.

```sh
npm run kurobara -- company results \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${company_generation_id:?}" \
  --limit 100 \
  --after-ordinal 0
```

`--limit` accepte 1 à 100 et vaut 100 par défaut. `--after-ordinal` vaut 0 par
défaut. La réponse JSON expose `items`, `page.has_more` et
`page.next_after_ordinal`, ainsi que la provenance immuable de la génération et
de la matérialisation. Pour la page suivante, réutilisez exactement
`next_after_ordinal` ; un curseur ordinal évite qu'une page déjà lue soit
rejouée dans la suivante.

Les candidats restent provider-neutral : nom, domaine, pays, secteur, effectif
quand connu et identifiant Kurobara. Le provider, son identifiant interne et son
payload brut ne sont pas exposés. Une génération non prête, absente ou étrangère
au workspace reste uniformément masquée par `dataset-generation-not-found`.

## Créer une shortlist Contact avec Prospeo

Ce parcours part de `${company_generation_id}` après observation de
`completed` et `materialization_state: "ready"`. Démarrez une API dédiée à la
route Prospeo :

```sh
NODE_ENV='development' \
KUROBARA_DATABASE_URL="${KUROBARA_DATABASE_URL:?}" \
KUROBARA_PROVIDER_ORDER='prospeo,hunter' \
PROSPEO_API_KEY="${PROSPEO_API_KEY:?}" \
HUNTER_API_KEY="${HUNTER_API_KEY:?}" \
  npm run start:api
```

Pour le mode `start`, lancez un worker avec la même base et la même instance
Hatchet :

```sh
NODE_ENV='development' \
KUROBARA_DATABASE_URL="${KUROBARA_DATABASE_URL:?}" \
KUROBARA_DISPATCHER_ID='contact-dispatcher-local-1' \
KUROBARA_LEAF_DISPATCHER_ID='contact-leaf-dispatcher-local-1' \
KUROBARA_LEAF_EFFECT_ADAPTER='configured-providers' \
KUROBARA_LEAF_EFFECT_RECONCILER_ID='contact-effect-reconciler-local-1' \
KUROBARA_RECONCILER_ID='contact-reconciler-local-1' \
KUROBARA_ROUTE_SCHEDULER_ID='contact-route-scheduler-local-1' \
KUROBARA_WORKER_ID='contact-worker-local-1' \
KUROBARA_PROVIDER_ORDER='prospeo,hunter' \
PROSPEO_API_KEY="${PROSPEO_API_KEY:?}" \
HUNTER_API_KEY="${HUNTER_API_KEY:?}" \
HATCHET_CLIENT_API_URL="${HATCHET_CLIENT_API_URL:?}" \
HATCHET_CLIENT_HOST_PORT="${HATCHET_CLIENT_HOST_PORT:?}" \
HATCHET_CLIENT_TLS_STRATEGY="${HATCHET_CLIENT_TLS_STRATEGY:?}" \
HATCHET_CLIENT_NAMESPACE="${HATCHET_CLIENT_NAMESPACE:?}" \
HATCHET_CLIENT_TOKEN="${HATCHET_CLIENT_TOKEN:?}" \
  npm run start:worker
```

API et worker doivent voir les mêmes clés BYOK, le même keyring privacy, le
même ordre provider et les mêmes snapshots PostgreSQL. `prospeo,hunter`
compose la shortlist et l'identité Prospeo, la résolution email Prospeo, la
vérification Hunter explicitement demandée et la route Finder disponible comme
alternative. Pour la préférer à Prospeo, utilisez un ordre explicite qui place
`hunter` avant `prospeo`. Aucun échec ni `NO_MATCH`/`not_found` Prospeo ne lance
Finder automatiquement : la génération Contact actuelle n'autorise qu'une
tentative provider.

Construisez ensuite une intention bornée. Kurobara traduit la séniorité
provider-neutral `individual_contributor` vers l'enum Prospeo `Entry`.
L'exemple reste réduit à un titre et une séniorité pour garder le probe peu
coûteux :

```sh
contact_run_suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
contact_deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
contact_dataset_id="dataset-contact-synthetic-${contact_run_suffix}"
contact_discovery_id="discovery-contact-synthetic-${contact_run_suffix}"

npm run kurobara -- contact search \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --authority-envelope-id authority-contact-local \
  --budget-limit 2 \
  --budget-unit requests \
  --company-country ES \
  --dataset-id "${contact_dataset_id}" \
  --dataset-name 'Synthetic contact shortlist' \
  --deadline-ms "${contact_deadline_ms}" \
  --discovery-id "${contact_discovery_id}" \
  --max-calls 2 \
  --max-companies 2 \
  --max-contacts-per-company 1 \
  --max-contacts-total 2 \
  --max-pages 2 \
  --mode dry-run \
  --organization-generation-id "${company_generation_id:?}" \
  --person-country ES \
  --seniority director \
  --title 'Sales Director'
```

Un `dry-run` valide persiste le plan mais ne contacte pas Prospeo. Pour lancer
exactement cette intention avant expiration, relancez les mêmes arguments avec
`--mode start`, puis récupérez `generation_id` dans la réponse. La commande
générique `company watch` suit aussi cette génération Contact :

```sh
contact_generation_id='<generation_id retourné par contact search --mode start>'

npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${contact_generation_id:?}" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000

npm run kurobara -- contact results \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${contact_generation_id:?}" \
  --limit 100 \
  --after-ordinal 0
```

La sortie publique contient notamment `display_name`,
`identity_completeness: "obfuscated"`, l'emploi courant et l'entreprise. Elle
ne contient ni email, ni téléphone, ni `person_id` Prospeo. Le probe provider
live est vert, mais il ne traverse pas ce `start`, PostgreSQL, Hatchet et les
surfaces publiques comme un E2E unique. La shortlist source
reste obfusquée et immuable. La révélation crée un dataset dérivé distinct au
lieu de modifier cette sortie en place.

## Dériver l'identité et l'email d'une sélection

Le parcours suivant utilise un seul record synthétique choisi dans
`contact results`. Répétez `--record-id` jusqu'à trois fois pour traiter une
sélection plus large ; les valeurs doivent être uniques et appartenir au même
dataset source. Chaque commande exige `--contact-dataset-id`, un
`--operation-id` idempotent, `--authority-envelope-id`, `--deadline-ms`,
`--budget-limit`, `--budget-unit`, l'endpoint et le credential Kurobara.

```sh
selected_contact_record_id='<record_id Kurobara lu dans contact results>'
selected_contact_dataset_id="${contact_dataset_id:?}"
contact_enrichment_deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
contact_enrichment_suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"

identity_json="$(
  npm run --silent kurobara -- contact reveal-identity \
    --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
    --endpoint http://127.0.0.1:3000 \
    --contact-dataset-id "${selected_contact_dataset_id}" \
    --record-id "${selected_contact_record_id}" \
    --operation-id "identity-${contact_enrichment_suffix}" \
    --authority-envelope-id authority-contact-local \
    --deadline-ms "${contact_enrichment_deadline_ms}" \
    --budget-limit 1 \
    --budget-unit requests
)"

identity_generation_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.generation_id !== "string") process.exit(1);
    process.stdout.write(value.generation_id);
  ' "${identity_json}"
)"
identity_dataset_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.result_dataset_id !== "string") process.exit(1);
    process.stdout.write(value.result_dataset_id);
  ' "${identity_json}"
)"

npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${identity_generation_id}" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000
```

Le watch doit converger vers `completed` et
`materialization_state: "ready"` avant l'étape suivante. Prospeo Enrich Person
reçoit uniquement le `person_id` relu dans la lineage restreinte ; la commande
n'accepte aucun identifiant provider libre. `enrich_mobile` reste toujours
`false`. Si la réponse contient déjà un email, l'adapter le retire du dataset
d'identité ; le provider peut néanmoins facturer ce succès.

Résolvez ensuite l'email professionnel depuis le dataset d'identité prêt. Le
même `record_id` Kurobara reste valide dans chaque dataset dérivé, ce qui
permet de garder la sélection exacte sans join implicite :

```sh
contact_enrichment_deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
resolve_json="$(
  npm run --silent kurobara -- contact enrich-email \
    --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
    --endpoint http://127.0.0.1:3000 \
    --contact-dataset-id "${identity_dataset_id}" \
    --record-id "${selected_contact_record_id}" \
    --operation-id "resolve-email-${contact_enrichment_suffix}" \
    --authority-envelope-id authority-contact-local \
    --deadline-ms "${contact_enrichment_deadline_ms}" \
    --budget-limit 1 \
    --budget-unit requests
)"

resolve_generation_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.generation_id !== "string") process.exit(1);
    process.stdout.write(value.generation_id);
  ' "${resolve_json}"
)"
resolve_dataset_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.result_dataset_id !== "string") process.exit(1);
    process.stdout.write(value.result_dataset_id);
  ' "${resolve_json}"
)"

npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${resolve_generation_id}" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000

npm run kurobara -- dataset export \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --dataset-id "${resolve_dataset_id}" \
  --format csv \
  --output ./contact-resolution.csv \
  --max-bytes 1048576 \
  --timeout-ms 300000
```

Inspectez `work_email_verification` et la fraîcheur associée dans cet export.
N'appelez `contact verify-email` que si la preuve Prospeo n'est pas suffisante
et encore fraîche selon votre policy. Cette condition est une décision
explicite du client ou de l'agent : ni l'API, ni le worker, ni la CLI ne créent,
ne sautent ou ne remplacent automatiquement une génération de vérification par
une copie du statut Prospeo. Si une vérification est nécessaire :

```sh
contact_enrichment_deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
verify_json="$(
  npm run --silent kurobara -- contact verify-email \
    --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
    --endpoint http://127.0.0.1:3000 \
    --contact-dataset-id "${resolve_dataset_id}" \
    --record-id "${selected_contact_record_id}" \
    --operation-id "verify-email-${contact_enrichment_suffix}" \
    --authority-envelope-id authority-contact-local \
    --deadline-ms "${contact_enrichment_deadline_ms}" \
    --budget-limit 1 \
    --budget-unit requests
)"

verify_generation_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.generation_id !== "string") process.exit(1);
    process.stdout.write(value.generation_id);
  ' "${verify_json}"
)"
final_dataset_id="$(
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.result_dataset_id !== "string") process.exit(1);
    process.stdout.write(value.result_dataset_id);
  ' "${verify_json}"
)"

npm run kurobara -- company watch \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${verify_generation_id}" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000
```

Sans vérification, utilisez `final_dataset_id="${resolve_dataset_id}"`. Le
dataset final `ready` s'exporte sur stdout par défaut ou atomiquement vers un
fichier owner-only avec `--output` :

```sh
npm run kurobara -- dataset export \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --dataset-id "${final_dataset_id:?}" \
  --format jsonl \
  --receipt ./contacts-final.receipt.json \
  --max-bytes 1048576 \
  --timeout-ms 300000

npm run kurobara -- dataset export \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --dataset-id "${final_dataset_id:?}" \
  --format csv \
  --output ./contacts-final.csv \
  --receipt ./contacts-final.receipt.json \
  --max-bytes 1048576 \
  --timeout-ms 300000
```

Omettez `--field-id` pour tous les champs. La sélection de champs utilise des
IDs du schéma, pas leurs labels ; ajoutez un ou plusieurs
`--field-id <identifiant>` lorsque cette sélection est nécessaire. `--output -`
est refusé : pour stdout, omettez simplement `--output`. Un export suivi
Contact vers stdout exige `--receipt <fichier>` afin de conserver la preuve de
livraison sans la mêler aux octets CSV ou JSONL. L'export exige un dataset
`ready`, conserve l'ordre déterministe et produit un reçu avec taille et
SHA-256.

### Suivre ou révoquer une livraison Contact

Pour un dataset Contact enregistré, la réponse HTTP d'export ajoute
`X-Kurobara-Delivery-ID`, `X-Kurobara-Delivery-Expires-At-Ms` et
`X-Kurobara-Delivery-State`, avec `prepared` ou `delivered` lors du replay exact
d'une livraison déjà terminée. Le triplet est entièrement présent ou entièrement
absent. Le SDK expose conditionnellement
`delivery` avec `deliveryId`, `expiresAtMs` et
`stateAtResponse: "prepared" | "delivered"`. Ces métadonnées sont absentes d'un
export non-Contact ; une livraison déjà `revoked` ne streame jamais.

La CLI conserve les flags de `dataset export` et accepte
`--receipt <fichier-distinct>`. Le reçu owner-only ajoute conditionnellement
`delivery_id`, `delivery_state` et `expires_at_ms`. En mode fichier, ni les
données ni le reçu ne sont publiés avant la relecture de l'état `delivered` à la
fin du flux ; un échec ne laisse aucun fichier final. En mode stdout,
`--receipt` est obligatoire dès que l'API annonce une livraison suivie. Avant
le premier octet, la CLI persiste sans écrasement un reçu de récupération
`0600` avec l'identité opaque, l'intégrité annoncée, l'expiration et l'état
`prepared`. Après EOF et readback `delivered`, elle le remplace atomiquement par
le reçu final. Une panne de flux ou de readback laisse le reçu `prepared`
récupérable ; elle ne transforme pas les octets déjà sortis en livraison
complète. La sortie standard reste exclusivement composée des octets CSV ou
JSONL. Les chemins `--output` et `--receipt` doivent être distincts ; aucun
fichier préexistant n'est écrasé.

Avec l'identité synthétique d'une livraison, les commandes de lifecycle sont :

```sh
npm run kurobara -- dataset export-status \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --delivery-id "export-delivery-synthetic-001"

npm run kurobara -- dataset export-revoke \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --delivery-id "export-delivery-synthetic-001"
```

Les deux commandes exigent le même workspace et le même owner authentifié que
la livraison, avec `contacts:export`. Un ID appartenant à un autre owner reste
indistinguable d'un ID absent. L'état public applique
`revoked > expired > delivered > prepared`. Révoquer empêche toute nouvelle
livraison par Kurobara ; cela ne rappelle pas le fichier déjà reçu.

### Enregistrer une restriction Contact

`contact restrict` exige `contacts:privacy`, une raison fermée, une clé
idempotente et `--value-file <chemin|->`. La valeur UTF-8 est bornée à
4 096 octets ; un chemin doit désigner un fichier régulier, sans symlink.
`--value-file -` lit stdin. Les deux formes ci-dessous supposent des fichiers
owner-only préparés par un canal protégé et contenant des identités
manifestement synthétiques :

```sh
npm run kurobara -- contact restrict \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --kind email \
  --value-file ./private/privacy-email.txt \
  --reason operator-subject-request \
  --idempotency-key "privacy-restrict-synthetic-email-001"

npm run kurobara -- contact restrict \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --kind provider-subject \
  --provider-key synthetic-provider \
  --value-file ./private/privacy-provider-subject.txt \
  --reason provider-opt-out \
  --idempotency-key "privacy-restrict-synthetic-provider-001"
```

La valeur ne passe pas dans `argv`, les erreurs, stdout ou stderr. Supprimez le
fichier d'entrée protégé selon votre propre politique après le readback, ou
utilisez stdin pour ne pas le persister localement. La réponse ne restitue
jamais la valeur ; elle contient le tombstone opaque et les compteurs de
livraisons affectées et nouvellement révoquées.

Ces contrats et exemples décrivent la révision locale qualifiée. La génération
des clients, les tests PostgreSQL/HTTP/SDK/CLI et le restore drill passent sur
cette révision ; ils ne remplacent pas les gates clean-room, provider et
publication.

## Demander l'annulation

`company cancel` enregistre une demande d'arrêt idempotente. Seul le sujet de
l'autorité d'origine peut l'effectuer, avec une clé API portant
`datasets:generate` :

```sh
npm run kurobara -- company cancel \
  --api-key-file "${KUROBARA_API_KEY_FILE:?}" \
  --endpoint http://127.0.0.1:3000 \
  --generation-id "${company_generation_id:?}" \
  --idempotency-key "cancel-${company_run_suffix:?}"
```

Avant tout effet en vol, l'arrêt peut devenir immédiatement `cancelled`.
Sinon, la réponse reste `stopping` jusqu'à ce que la page active produise une
issue certaine ; le worker empêche ensuite l'autorisation d'une nouvelle page.
Relancez `company watch` jusqu'à `terminal: true`. Une issue externe ambiguë
reste `ambiguous` et n'est jamais transformée en annulation certaine.
Le readback conserve `stop_reason: "requested"` et `stop_requested_at_ms` dans
les snapshots arrêtés.

Le replay exact de la même clé d'annulation est sûr et retourne
`replayed: true`. La même clé pour une autre génération retourne
`idempotency-key-reused`. Une génération déjà `completed`, `failed` ou ambiguë
pour une autre raison refuse l'annulation.

## Budgets, caps et deadline

Les limites sont des plafonds indépendants, immuables et relus avant chaque
page :

- `--max-companies` borne les records acceptés par Kurobara ; l'adapter Hunter
  demande sa page provider de 100 puis tronque localement au cap restant ;
- `--max-pages` borne les pages ;
- `--max-calls` borne les appels et doit être supérieur ou égal à
  `max-pages` ;
- la première page Hunter avec taille provider 100 est qualifiée live ; les
  pages suivantes et options Premium ne le sont pas encore ; des caps plus
  larges ne contournent jamais les bornes du provider ;
- chaque page Hunter réserve puis règle exactement une unité `requests` ;
- `--budget-limit` doit couvrir la quote et le hard execution cap encore
  disponible dans l'enveloppe d'autorité. L'unité interne `requests` ne
  constitue pas un devis de crédits Prospeo exact ;
- `--deadline-ms` est un instant Unix absolu en millisecondes. La deadline
  effective est le minimum entre la demande et l'autorité ; l'expiration de la
  quote active peut arrêter plus tôt.

Pour `contact search`, chaque page durable groupe au plus dix entreprises et
correspond à au plus une requête Prospeo. `--max-companies` est borné à 10,
`--max-contacts-per-company` à 2 et `--max-contacts-total` à 12 ; le total ne
peut pas dépasser le produit des deux premiers caps. `--max-pages` et
`--max-calls` doivent couvrir le nombre maximal d'entreprises effectivement
parcourues. La page reçoit uniquement le reliquat du cap global, donc une fin de
run ne peut pas dépasser `max_contacts_total`.

Le `dry-run` ne réserve et ne dépense rien. `start` réserve atomiquement avant
chaque seuil d'effet. Une deadline ou une quote expirée, un budget épuisé ou un
cap atteint interdit la page suivante. N'augmentez pas un budget ou un cap en
rejouant la même `discovery_id` : créez une nouvelle intention explicite.

## Erreurs et limites opérateur

Les erreurs API validées sont des Problem Details JSON sur stderr. Les erreurs
locales de la CLI sont aussi JSON et expurgées. Les principaux codes de sortie
sont :

| Code | Sens |
| --- | --- |
| `0` | succès de la commande, pas nécessairement génération terminale |
| `2` | arguments, fichier credential, payload ou media type invalide |
| `3` | authentification, workspace, sujet, permission ou capability refusée |
| `4` | génération absente dans ce workspace |
| `5` | deadline expirée ou conflit d'idempotence |
| `6` | budget, query, domaine ou transition métier refusée |
| `70` | réponse hors contrat ou erreur interne |
| `75` | transport, timeout de watch ou service temporairement indisponible |
| `130` | processus interrompu ; la génération durable continue sans `company cancel` |

Diagnostics fréquents :

- `service-unavailable` sur `company search` : route Hunter absente de l'API,
  planning incomplet ou aucun snapshot de route compatible ;
- `dataset-generation-not-found` sur `company results` : identifiant absent,
  étranger au workspace ou génération pas encore `ready` ; relisez d'abord
  `company watch` ;
- `service-unavailable` sur `contact search` : route Prospeo absente de l'API,
  planning incomplet ou aucun snapshot compatible ; vérifiez la présence
  metadata-only de `PROSPEO_API_KEY` et un `KUROBARA_PROVIDER_ORDER` contenant
  `prospeo`, sans afficher la clé ;
- `service-unavailable` sur une dérivation Contact : capability absente du
  planning, credential Prospeo ou Hunter absent, ordre provider incompatible,
  ou aucune configuration HMAC Contact valide ; le keyring JSON et les
  variables legacy ne doivent jamais être combinés ;
- `failed` ou refus provider sur `contact search` : la clé Prospeo est absente,
  le compte ou le quota est épuisé, ou les filtres n'autorisent pas Search
  Person ; le probe positif ne garantit pas les appels futurs ;
- `authority-permission-missing` : permissions de la clé ou de l'enveloppe
  insuffisantes, sujet différent, ou permission `contacts:export` absente pour
  un export Contact ;
- `service-unavailable` pendant un export Contact : la lineage privacy n'a pas
  pu être vérifiée ; un tombstone ou une restriction privacy est masqué par un
  refus non divulguant ;
- `invalid-budget` / `quote-unit-mismatch` : pricing, budget et route ne
  partagent pas l'unité `requests`, ou la quote excède le budget disponible ;
- `failed` avec zéro usage provider : pays multiples, secteur non mappé ou
  bornes d'effectif qui ne correspondent pas aux buckets Hunter peuvent passer
  le contrat provider-neutral puis être refusés par l'adapter avant l'appel ;
- `failed` avec zéro usage Prospeo : un filtre hors mapping exact ou une réponse
  incompatible est refusé avant toute matérialisation ;
- `deadline-elapsed` après un `dry-run` : deadline ou quote expirée avant le
  `start` ; créez une nouvelle intention au lieu de modifier le replay ;
- `ambiguous` : le transport ou la réponse provider ne permet pas de prouver
  l'issue. Hunter et Prospeo n'offrent pas de lookup autoritatif Kurobara pour
  ce replay ;
  aucun fallback ou nouvel appel payant n'est inventé.

Enfin, les champs `employee_count` retournés par l'adapter valent actuellement
`null`, et `industry_code` n'est renseigné que lorsqu'un unique secteur a été
demandé. Le pays de siège et le secteur sont des projections de la query admise,
pas une nouvelle preuve indépendante fournie par Hunter. Les payloads bruts,
identifiants provider et contacts ne sont pas exposés par cette surface.

Pour la shortlist, Kurobara ne considère pas Search Person comme une révélation
de coordonnées. Il conserve une projection `display_name` avec
`identity_completeness=obfuscated` et persiste le `person_id` uniquement dans la
lineage restreinte ; email, téléphone et payload brut restent absents de la
projection publique.

## Preuves et limites de la V1 locale

La gate
[`test/v1-business-gate/v1-business-gate.test.ts`](../../test/v1-business-gate/v1-business-gate.test.ts)
exerce directement, sans réseau et avec des identités synthétiques, les adapters
Hunter/Prospeo et les codecs CSV/JSONL de la chaîne entreprises, shortlist,
sélection, identité, email et vérification explicitement choisie :

```sh
npm run test:v1-business-gate
```

Cette preuve providers + codecs ne traverse pas à elle seule l'application,
PostgreSQL, le worker, HTTP, le SDK ou la CLI. Le test séparé
[`test/integration/http-sdk-dataset-export.test.ts`](../../test/integration/http-sdk-dataset-export.test.ts)
fait consommer le vrai handler HTTP d'export chunké par le SDK. Le test
[`planning-bundle.test.ts`](../../test/v1-business-gate/planning-bundle.test.ts)
valide le bundle suivi et sa borne, tandis que
[`postgres-dataset-generation-first-page.test.ts`](../../test/integration/postgres-dataset-generation-first-page.test.ts)
prouve sur PostgreSQL le plan exact et son hash pour une génération Contact
sélectionnée.

Le harness `b2b:dogfood` complète ces preuves ciblées par un parcours live
unique. Il démarre une infrastructure jetable, pilote la vraie CLI contre
l'API, laisse Hatchet exécuter les pages dans le worker, puis vérifie le CSV
privé final avant nettoyage. Le run positif du 22 juillet 2026 a observé trois
entreprises, deux contacts masqués et un email professionnel
`found-and-valid`, sous une borne de quatre requêtes provider. Il n'a exposé
dans son rapport que des compteurs, états et noms de providers.

Cette preuve ne qualifie pas les endpoints Hunter Finder/Verifier, qui restent
des options explicites et ne bloquent pas la verticale Prospeo de base. Apollo
reste un adapter opt-in hors ordre par défaut. Aucun package, endpoint hébergé,
support public ou release V1 n'est publié par ce guide. Le harness du 22 juillet
n'exerçait pas le registre durable ajouté ensuite ; celui-ci possède ses propres
tests application/PostgreSQL/HTTP/SDK/CLI et son dump/restore. Les droits
provider et gates de distribution restent ouverts.

L'export d'un dataset Contact exige `contacts:export`, applique les tombstones
en preflight puis juste avant la livraison des octets, et échoue fermé si la
lineage privacy n'est pas vérifiable. Le registre v2 est validé localement sur
PostgreSQL, application, HTTP, SDK et CLI, puis par restauration avec le
keyring historique. Cette preuve ne doit pas être présentée comme une conformité
juridique, un droit de redistribution acquis ou une release publique.
