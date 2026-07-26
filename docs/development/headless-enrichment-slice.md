# Premier vertical headless d'enrichissement

- Statut : **candidat V1 headless local**
- Vertical de référence : **domaine d'organisation vers site officiel**
- Publication : **contrat local-development-only ; aucun package ou endpoint publié**

## Outcome produit

Kurobara vise un parcours dataset-first pilotable sans interface graphique :

```text
dataset JSONL ou CSV
→ recette versionnée par champ
→ run durable et borné
→ résultat de cellule traçable
→ export JSONL ou CSV
```

Un coding agent doit pouvoir préparer et suivre ce parcours par CLI ou API sans
parser une interface, imposer un LLM ou connaître le provider concret. La
révision actuelle expose l'import initial, une passe agrégée d'application de
recette, son snapshot durable et son export direct par API, SDK TypeScript et
CLI. Elle fournit aussi les primitives, les codecs, les use cases
d'import/export, l'exécution de recettes par cellule sur le DAG durable existant
et leur stockage PostgreSQL local. Le worker compose Tavily et Exa en BYOK sur
la même capability, avec fallback uniquement après un échec certain et
retryable. L'export direct ne constitue pas encore un artifact durable.

## Primitives V1 locales

Les schémas canoniques sous `packages/contracts/catalog/schemas/product`
utilisent encore le namespace `local-development-only`. Ils ne créent ni route,
ni garantie de compatibilité publique.

| Primitive | Sens | Limite volontaire de la première tranche |
| --- | --- | --- |
| `Dataset` | Conteneur nommé, isolé par workspace | Les records forment une collection durable séparée de son payload |
| `Field` | Colonne identifiée, typée et ordonnée du dataset | `string`, `number` ou `boolean`, au plus 256 champs par dataset |
| `Record` | Ligne à identité stable avec valeurs indexées par `field_id` | Valeurs scalaires ou `null`, jamais de JSON imbriqué |
| `EnrichmentRecipe` | Transformation versionnée d'un ou plusieurs champs vers un champ cible | Révision immuable persistée localement ; aucun catalogue ou contrat public |
| `CellResult` | Disponibilité et métadonnées d'une cellule produite par un run existant | Lifecycle et projection exacts persistés ; aucune route publique ni sélection implicite du résultat le plus récent |
| `Run` | Exécution durable, budgetée et idempotente | Réutilise le modèle déjà présent dans le kernel |

Une valeur absente et `null` n'ont pas le même sens. L'absence signifie que le
record ne porte pas ce champ ; `null` est une valeur explicite à préserver lors
des conversions.

`CellResult.status` est borné à `pending`, `running`, `succeeded`, `failed` ou
`skipped`. Une réussite expose une valeur explicite, y compris `null`, et peut
ajouter provenance, fraîcheur, confiance et coût. Un échec ou un skip expose une raison stable et expurgée, jamais le
payload brut d'un provider.

## Vertical de référence

Le premier parcours prend un domaine d'organisation et enrichit une colonne
`official_website_url`. La capability reste provider-independent. Les adapters
locaux Tavily et Exa maintenus par Kurobara implémentent le même contrat one-shot
et sont composables dans l'ordre `KUROBARA_PROVIDER_ORDER`. Exa exige en plus
l'attestation opérateur fail-closed documentée par la
[policy BYOK](../policies/byok-provider-terms.md). Ils normalisent
uniquement une URL sur le domaine demandé, règlent une requête exacte par effet
commencé et classent une réponse vide ou hors domaine comme échec certain et
retryable. Une issue transport dont le résultat reste inconnu devient ambiguë
et interdit le fallback.

Cette admission est technique et locale. Elle ne vaut pas approbation des
conditions provider pour une distribution OSS, ni validation juridique ou
production.

Dataset :

```json
{
  "dataset_id": "dataset_demo_orgs",
  "workspace_id": "workspace_demo",
  "name": "Organization website lookup"
}
```

Champs :

```json
[
  {
    "field_id": "field_domain",
    "dataset_id": "dataset_demo_orgs",
    "workspace_id": "workspace_demo",
    "key": "domain",
    "label": "Domain",
    "value_type": "string"
  },
  {
    "field_id": "field_official_website_url",
    "dataset_id": "dataset_demo_orgs",
    "workspace_id": "workspace_demo",
    "key": "official_website_url",
    "label": "Official website URL",
    "value_type": "string"
  }
]
```

Record d'entrée :

```json
{
  "record_id": "record_example",
  "dataset_id": "dataset_demo_orgs",
  "workspace_id": "workspace_demo",
  "values": [{ "field_id": "field_domain", "value": "example.invalid" }]
}
```

Recette :

```json
{
  "recipe_id": "recipe_official_website_v1",
  "dataset_id": "dataset_demo_orgs",
  "workspace_id": "workspace_demo",
  "name": "Resolve official website",
  "recipe_revision": "1.0.0",
  "input_field_ids": ["field_domain"],
  "target_field_id": "field_official_website_url",
  "workflow_spec_id": "workflow_organization_website_lookup",
  "workflow_revision": "1.0.0",
  "workflow_content_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Forme du résultat normalisé produit par le vertical local :

```json
{
  "cell_result_id": "cell_result_example_website",
  "dataset_id": "dataset_demo_orgs",
  "workspace_id": "workspace_demo",
  "record_id": "record_example",
  "field_id": "field_official_website_url",
  "recipe_id": "recipe_official_website_v1",
  "recipe_revision": "1.0.0",
  "run_id": "run_demo_lookup",
  "status": "succeeded",
  "value": "https://example.invalid/",
  "provenance": {
    "references": ["https://example.invalid/about"]
  },
  "freshness": { "observed_at_ms": 1784451600000 },
  "confidence": 1,
  "cost": { "unit": "credits", "amount": 1, "basis": "exact" }
}
```

Cet exemple utilise uniquement des identités et URL synthétiques réservées. Le
worker compose bien les providers réels en BYOK, mais ce payload reste un
exemple de contrat et non la copie d'une réponse provider.

## Codec dataset

Le codec local traite des flux `AsyncIterable<Uint8Array>` et ne charge pas le
dataset complet en mémoire. Il conserve l'ordre reçu et ne génère jamais de
`record_id`.

- JSONL : un `Record` canonique par ligne, UTF-8, LF et sortie déterministe ;
- JSONL : la syntaxe et l'unicité des clés objet sont contrôlées avant parsing,
  y compris dans les objets imbriqués et pour des clés équivalentes après
  décodage des échappements Unicode ; la profondeur est bornée à 64 et chaque
  objet à 512 clés ;
- CSV : en-tête `record_id` puis clés de champs, profil RFC 4180 et CRLF ;
- CSV vide non quoté : `null` ; CSV `""` : chaîne vide ;
- JSONL préserve les champs omis ; un export CSV refuse un record incomplet au
  lieu de transformer silencieusement une omission en `null` ;
- aucune inférence ou normalisation silencieuse de type ;
- une erreur n'inclut jamais le contenu brut de la ligne ;
- la limite de taille porte sur un record et la backpressure est conservée.

Le codec reste sans état durable. Les use cases et l'adapter PostgreSQL portent
les garanties suivantes :

- l'import écrit des lots bornés à la fois en nombre d'items et en octets de
  contenu canonique, sans garder une transaction ouverte pendant la lecture du
  flux source ;
- la requête déclare le SHA-256 exact du flux brut. Le use case le recalcule au
  fil de la lecture et ne termine pas l'import si la fin de flux observée ne
  correspond pas, notamment après une troncature propre ; les lots provisoires
  sont alors supprimés transactionnellement avant une reprise depuis le début ;
- chaque lot possède une séquence et un digest. Rejouer exactement le même
  `import_id`, le même hash source, la même définition et les mêmes lots ne
  réécrit rien ; toute divergence d'identité, de séquence ou de digest est un
  conflit ;
- un dataset possède un seul import initial, immuable. Cette tranche ne permet
  ni second import incrémental, ni mutation des records déjà acceptés ;
- `record_id` est obligatoire, conservé tel quel et jamais généré. L'ordre
  d'import est persisté par un ordinal monotone ; un doublon d'identité devient
  une erreur durable plutôt qu'un remplacement silencieux ;
- les erreurs importées restent ordonnées et expurgées : code, position et
  identité bornée peuvent être conservés, jamais la ligne brute ;
- import et export exigent une clé API déjà vérifiée et la permission dédiée.
  Le workspace est dérivé de cette identité, jamais choisi séparément par la
  requête ; datasets, champs, imports, records, erreurs et lectures restent
  qualifiés par ce `workspace_id` ;
- l'export refuse un import incomplet, lit les records par curseur PostgreSQL
  dans leur ordre d'import et transmet le flux au codec sans charger le dataset
  complet ;
- avant d'émettre un CSV, le use case vérifie en base que chaque champ demandé
  existe et est présent sur chaque record. JSONL continue de préserver la
  différence entre omission et `null`.

La reprise actuelle relit le flux depuis le début avec la même définition
d'import et le même SHA-256 source ; le ledger des lots rend les préfixes déjà
validés sans effet. Le [transport local d'import](./dataset-import-api-cli.md)
préserve maintenant ce flux via API, SDK et CLI. Il ne fournit ni upload
persistant séparé, ni import incrémental, ni reprise à partir d'un offset
arbitraire.

## Exécution locale des recettes

La tranche recette réutilise le lifecycle de `Run` et le scheduler DAG déjà
présents. Une application de recette est un groupement immuable et borné de
records ; elle n'introduit ni second orchestrateur, ni état d'exécution
concurrent au `Run` canonique.

- l'enregistrement vérifie le dataset, les champs source et cible ainsi que la
  révision exacte du workflow avant de persister une recette immuable ;
- l'application borne son nombre de cellules ; un compilateur pur de graphe de
  champs, encore séparé du parcours mono-recette actuel, refuse cycle,
  profondeur, nombre de nœuds et fan-out excessifs, y compris le fan-out depuis
  un champ source ;
- chaque cellule résout un input normalisé exact lié au hash du record, à la
  recette, au champ cible et au snapshot de workflow. Un plan portant un autre
  input ou une autre révision de workflow est refusé avant toute création ;
- une cellule à calculer crée atomiquement le `Run`, son événement et son
  outbox, un `CellResult.pending`, la liaison d'application et le slot de cache
  actif. Deux applications concurrentes sur une identité de cache absente sont
  sérialisées : une seule crée le `Run`, l'autre lie durablement le même
  `CellResult` et observe le calcul actif ;
- le claim du `Run` fait passer le `CellResult` à `running` dans la même
  transaction. La convergence réussie ou échouée persiste manifest, état
  terminal du `Run`, preuve et `CellResult` ensemble ;
- PostgreSQL vérifie de manière différée l'alignement
  `queued/pending`, `running/running`, `completed/succeeded`, `failed/failed`
  et `cancelled/skipped`. Une terminaison discordante ne peut pas committer ;
- un échec ou un skip libère le slot actif. Une réussite ne devient réutilisable
  que si elle porte une expiration de fraîcheur explicite encore valide selon
  l'horloge PostgreSQL ; sinon une nouvelle exécution reste nécessaire ;
- l'export enrichi parcourt les liaisons exactes de l'application dans l'ordre
  du dataset. Il n'invente pas une jointure avec le dernier résultat connu.

La [surface locale `recipe apply`](./recipe-apply-api-cli.md) compose désormais
ces primitives sans les recopier dans les clients. L'identité d'application est
stable et chaque cellule persiste atomiquement plan, input validé, run,
événement, outbox, résultat pending et liaison. La passe reste séquentielle et
rejouable ; elle ne crée ni transaction globale sur le dataset, ni lifecycle
d'application concurrent aux runs.

La [surface locale `recipe watch`](./recipe-watch-api-cli.md) agrège directement
les liaisons et statuts persistés. Son polling est borné côté client et reprend
avec le même identifiant après interruption ; il ne transforme ni la connexion
HTTP ni Hatchet en source de vérité.

La [surface locale `recipe export`](./recipe-application-export.md) prévalide
ensuite la projection exacte avant de la streamer en CSV ou JSONL. SDK et CLI
restent des clients HTTP ; le téléchargement ne crée ni artifact, ni identité
d'export durable.

Le chemin de succès PostgreSQL est qualifié avec un output synthétique validé et
par le gate provider live : valeur, provenance, fraîcheur, confiance, coût,
manifest et artifact sont relus depuis leur stockage durable. Le readback live
exige exactement une tentative Tavily échouée retryable puis une tentative Exa
réussie, la même `operation_key`, deux règlements exacts et une provenance de
routage complète avant d'accepter l'export. La commande `runs.cancel` annule
atomiquement un run encore en file et son replay exact ; un run actif passe à
`cancelling`, puis `SettleCancellation` le ferme uniquement lorsque chaque
effet et réservation possède une preuve durable terminale. La cellule liée
converge alors atomiquement vers `skipped`.

La planification publique consulte désormais un catalogue de routes admises
fourni par la composition root. Elle fige dans chaque plan l'ordre des routes,
l'adapter, la capability exacte, la borne réservable, l'unité, la version de
pricing et les faits de policy. Les capabilities annoncées sont dérivées de ce
même catalogue. Les composition roots API et worker dérivent leurs routes des
credentials présents, sans conserver leurs valeurs dans les descriptors : sans
route exacte, une quote ou une application de recette retourne
`service-unavailable` avant de persister un plan ou un run inexécutable. Le mode
`deterministic-local` reste une fixture explicite ; le mode
`configured-providers` compose Tavily et/ou Exa.

Le [RFC-0002](../rfcs/0002-plugin-sidecar-and-run-input.md), accepté le
2026-07-20 et résumé par
[ADR-0006](../adr/0006-plugin-provider-boundary.md), fixe désormais la frontière
provider-neutral staged. Une tranche locale livre les seize messages
fonctionnels de `PluginProtocolMessage`, la frame fermée
`PluginSidecarJsonRpcFrame`, le SDK privé qui les valide et un adapter
déterministe qui importe uniquement ce SDK. Le host local
`@kurobara/plugin-host` exécute un processus distinct par appel, avec manifest
attendu admis avant spawn, `describe` distant comparé, parseur JSON strict,
deadline et quote revérifiées avant envoi, framing et délais bornés. Une fixture
extérieure au workspace compile contre les tarballs, s'installe offline puis
traverse les huit méthodes. Cette preuve reste réservée au harness et au mode
développeur non fiable : elle n'ajoute ni ingress public, permission réseau ou
sandbox. Les adapters Tavily/Exa maintenus par Kurobara empruntent désormais le
bridge de confiance dans le worker ; cela ne transforme pas le host de plugins tiers en
sandbox.

## Ce qui reste à livrer

Le candidat local ferme le vertical technique, pas la release publique. Restent
notamment :

1. obtenir la preuve de provenance, de licence et de compatibilité des
   conditions Tavily/Exa avec la distribution visée ;
2. construire le lifecycle d'artifact/export durable suivi par `API-002` et
   `ARTIFACT-001`, puis SSE si retenu ;
3. fournir un stockage de secrets et une vraie sandbox avec contrôle d'egress
   avant de considérer des plugins tiers non fiables ;
4. publier et qualifier packages, images, documentation opérateur et topologie
   de production dans des gates distincts.

Ni UI, ni compte Kurobara Cloud, ni LLM ne sont requis par ce chemin critique.
Claude Code y reste une cible optionnelle explicitement non qualifiée ; son
statut pourra évoluer après une exécution réelle sans rouvrir le candidat local
déjà prouvé par Codex.
