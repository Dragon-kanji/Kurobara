# Fondation exécutable V1

- Statut : **source preview V1 OSS headless `v0.1.0-rc.3`**
- Baseline initiale qualifiée localement le **2026-07-17**
- Tranches `plans.quote`, `capabilities.list`, import/apply/watch/export,
  `runs.cancel`, ingress d'orchestration,
  matérialisation DAG, routage/claim automatique, outbox/leaf task, règlement
  déterministe et recovery durable de tentative : présente révision,
  qualifiées par les preuves locales listées ci-dessous
- Environnement vérifié : Node `24.14.0`, npm `10.9.4`, PostgreSQL Kurobara
  `16.13`, Hatchet candidat `v0.95.3` avec deux services PostgreSQL de fixture
  `17.9` isolant l'état Hatchet et les bases Kurobara jetables
- Publication : **source et artifacts GitHub preview ; aucun package npm, image
  OCI ou service managé**

Ce document décrit la source preview et les capacités démontrées par ses gates.
Il ne présente ni serveur distant prêt à exploiter, ni qualification de
production ou de distribution provider.

## Ce qui est démontré

Le socle neuf respecte les frontières du monolithe modulaire :

- `packages/kernel`, `workflow-engine` et `policy-engine` restent purs et sans
  I/O ;
- le lifecycle global d'un `Run` refuse les transitions invalides, contrôle la
  version d'agrégat et accepte une redelivery seulement avec une preuve de
  commande liée au workspace, au run, à la clé et au hash exacts ;
- le lifecycle pur d'un `StepRun` conserve chaque tentative, impose des numéros
  monotones et la même `operation_key` lors d'un retry, interdit le retry d'une
  issue ambiguë et exige une preuve avant réconciliation. Toute commande fraîche
  post-claim porte la tentative et la version d'agrégat exactes ; un seuil
  d'effet frais retourne `granted`, tandis que sa redelivery durable retourne
  uniquement `replay-only` ;
- `packages/contracts/catalog` porte le catalogue `0.12.0` de 119 membres et son
  fingerprint source
  `sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd`,
  dont vingt-deux opérations, soixante et un schémas, trente-deux problèmes,
  `RunQueued` et `ProblemDetails` ;
- une génération locale et sans réseau produit fingerprints, manifeste,
  registre de problèmes, OpenAPI 3.1.1, types TypeScript et descripteurs MCP ;
- les opérations expérimentales `capabilities.list@1.0.0` et
  `plans.quote@1.0.0` restent une baseline
  `local-development-only` sous `.invalid`. Cette tranche l'aligne sur les
  problèmes métier existants sans créer de nouvelle identité publique.
  `capabilities.list` est `inherent`, tandis que `plans.quote` déclare
  honnêtement son idempotence `not-supported` ; aucune version publiée ou
  supportée n'est modifiée ;
- la racine `@kurobara/contracts` et son subpath explicite
  `@kurobara/contracts/v1` exposent uniquement la même projection V1 générée ;
- le catalogue `0.12.0` contient le schéma fermé
  `PluginConformanceReport@1.0.0`. Le package privé
  `@kurobara/plugin-conformance@0.1.0` le valide et le sérialise de façon
  déterministe pour le profil exact
  `dev.kurobara.plugin-conformance/local-v1@1.1.0`. Sa matrice, fingerprint
  `sha256:4f0f6b375201f3b94f1458147b989c1aa9cd5858de63d4ffbd09eeb23e5e2b95`,
  contient seulement Node `24.14.0` sur `darwin/arm64` et `linux/x64` ; une sonde d'effet
  temporaire observe l'`operationKey` hors du résultat de l'adapter ;
- `apps/api` compose un serveur HTTP Hono avec l'application et PostgreSQL ; son
  bind est loopback par défaut et toute écoute non-loopback exige une option
  explicite ;
- les vingt-deux opérations métier servies couvrent capabilities, import dataset,
  quote, apply/watch/export direct d'application, création/lecture de run,
  annulation et la famille sourcing, dont la lecture paginée des entreprises
  d'une génération `ready`, `contact search`, la lecture des contacts prêts,
  l'identité et l'email sélectionnés, l'export générique du dataset, la lecture
  et la révocation d'une livraison Contact ainsi que la restriction d'un sujet ;
  les probes locales `/healthz` et `/readyz` restent hors de ce décompte ;
- les requêtes utilisent un bearer API key persisté en base. La création
  initiale d'une clé passe par la commande hors ligne `bootstrap:api-key`, qui
  applique les migrations et ne retourne le secret qu'une fois ;
- l'adapter HTTP impose les limites de header et de corps, le media type JSON,
  valide les entrées et sorties contre les schémas canoniques avec Ajv Draft
  2020-12 et rend les erreurs depuis le registre RFC 9457 généré ;
- l'authentification lie l'acteur, le workspace et les permissions de la clé à
  l'enveloppe d'autorité du plan ; un autre sujet du même workspace reçoit
  `authority-subject-mismatch`, et une lecture cross-workspace reste masquée par
  `run-not-found` ;
- `GET /v1/capabilities` exige l'identifiant d'une enveloppe d'autorité exacte,
  masque de la même manière une enveloppe absente ou liée à un autre sujet, puis
  intersecte ses références avec le catalogue statique de routes fourni à la
  composition root.
  La composition de processus dérive le catalogue local des credentials BYOK
  effectivement présents et de `KUROBARA_PROVIDER_ORDER`. Sans credential, la
  réponse reste bornée, stable et vide ; avec Tavily, Exa, Hunter, Prospeo ou
  Apollo,
  elle annonce uniquement les capabilities réellement composables, sans
  conserver la valeur des secrets dans les descriptors ;
- `POST /v1/plans` charge dans une transaction les snapshots PostgreSQL exacts
  du workflow et de l'autorité ainsi que les defaults de policy et pricing du
  workspace. Le use case compile le DAG, évalue la policy, borne budget,
  deadline et expiration, calcule le hash canonique côté serveur, puis persiste
  le `RunPlan` et ses références de provenance sans créer de `Run` ;
- un workflow exact absent/invalide reste un `domain-rejected` non révélateur ;
  une autorité absente ou liée à un autre sujet produit le même
  `authority-subject-mismatch`. Defaults, policy ou pricing absents rendent
  `service-unavailable`. Les incohérences de permission, capability,
  deadline, budget, unité et domaine conservent leurs problèmes RFC 9457
  canoniques ;
- `apps/api` et `apps/worker` possèdent un lifecycle start/stop et un arrêt borné
  sur signal. Le worker compose PostgreSQL, les dispatchers run et tentative,
  l'adapter Hatchet, `ClaimRun`, `ExecuteLeafAttempt`, le reconciler de starts
  le reconciler d'effets et le scheduler DAG ; il démarre executor, reconciler
  de starts, reconciler d'effets, dispatcher tentative, scheduler DAG puis
  dispatcher run, rollbacke les ressources acquises sur erreur et les arrête
  dans l'ordre inverse. Une panne tardive de l'un des six services fait
  tomber la readiness, déclenche un cleanup borné par ressource
  qui continue après un timeout et place le processus en échec. Le premier
  cycle de polling ne bloque pas l'installation des signaux du processus ;
- `packages/adapters/postgres` implémente l'unité de travail de création d'un
  run, son journal initial, son outbox et sa lecture par workspace ;
- les migrations `0002_run_cost_snapshot.sql` et
  `0003_api_key_authentication.sql` ajoutent respectivement le snapshot de coût
  durable du run, puis workspaces et clés API persistées ;
- `0004_planning_snapshots.sql` ajoute les snapshots immuables et isolés par
  workspace de workflow, autorité, policy et pricing, les defaults locaux et
  la provenance exacte des plans ;
- `0005_planning_defaults_revision.sql` révisionne les defaults actifs. Leur
  bascule exige la révision précédemment relue et refuse donc un écrasement
  concurrent silencieux ;
- `0006_run_orchestration_bindings.sql` ajoute le binding durable tenant-scoped
  entre run, message outbox, start key, adapter et identifiant d'orchestration,
  ainsi que le journal des commandes de run ;
- `0007_orchestration_reconciliation_leases.sql` ajoute les leases de
  réconciliation fenced, le compteur borné, l'éligibilité temporelle et la
  dernière raison expurgée. Le use case système réclame globalement une ligne à
  la fois pour donner à chaque lookup une lease fraîche, puis règle dans le
  workspace exact du claim. Il applique un délai avant retry et cesse les claims
  automatiques au budget configuré. Une opération système exécutée une fois par
  cycle réalise aussi un reap transactionnel des claims finales expirées : le
  binding `reconciliation_exhausted` et le message outbox `dead_letter` ne
  peuvent pas diverger après le crash de la dernière tentative ;
- `0008_orchestration_system_reconciliation.sql` ajoute l'état terminal,
  remplace l'index tenant-first par l'ordre de claim système `adapter → échéance
  → ancienneté → workspace → run` et ajoute un index séparé pour le reap par
  budget/lease, sans retirer l'identité tenant des règlements ;
- `0009_step_run_attempts.sql` ajoute les steps, tentatives, événements,
  preuves de commandes et réservations de coût tenant-scoped. Le claim charge
  et verrouille le run avec son plan, vérifie le nœud, ses dépendances,
  l'autorité, la deadline et l'unité, puis écrit réservation, step, tentative,
  événements et preuve dans la même transaction ;
- `0010_step_cost_settlement.sql` ajoute le règlement et la libération
  atomiques, un usage ledger immuable, le binding d'une `operation_key` à un
  seul step logique et les liens réciproques tentative/réservation. Les montants
  restent compatibles avec les fractions historiques : PostgreSQL `numeric`
  porte les mouvements exacts et l'application vérifie leur conservation sans
  dépendre d'une addition IEEE-754 exacte. La migration roll-forward complète
  les réservations JSON `0009`, mais ne réécrit ni plan ni snapshot immuable :
  leur parser projette une limite conservative d'une tentative lorsque le champ
  historique manque. À épuisement ou après expiration de la deadline, l'erreur
  devient terminale ; un ancien step `retryable` produit
  `StepRetryExhausted` au lieu de rester bloqué ;
- `0011_leaf_execution_outbox.sql` ajoute l'outbox atomique de tentative, son
  binding tenant-scoped vers run, step, tentative, événement `AttemptClaimed`,
  réservation et opération, les leases/token de dispatch et les états de
  reprise. Le claim global utilise `FOR UPDATE SKIP LOCKED`, l'horloge PostgreSQL
  et une start key stable `effect:<attempt_id>`. Une lease perdue après
  `starting` devient `reconciliation_required`; un règlement tardif reste
  accepté seulement si son token est toujours courant, sinon il devient un
  no-op fenced. Une tentative déjà terminale annule atomiquement binding et
  message tant que le binding est encore `pending`, donc sans appel Hatchet. Un
  binding ayant déjà atteint `starting` reste réclamable en
  `reconciliation_required` même si le callback a terminalisé la tentative :
  le worker peut ainsi retrouver l'exécution externe exacte avant de finaliser
  l'outbox. Le reset vers `pending` verrouille le binding puis la tentative et
  exige que celle-ci soit encore `claimed`; le seuil d'effet prend le même
  verrou. Un callback tardif est donc fenced, tandis qu'un état post-effet déjà
  visible répare fail-safe un binding `pending` en réconciliation ;
- `0012_leaf_effect_recovery.sql` ajoute une queue durable distincte après
  acceptation Hatchet. Le dispatcher fige la provenance de l'adapter d'effet
  dans le binding avant l'appel externe ; le callback la revalide, puis chaque
  job persiste cette même identité avec un délai initial, un budget, une
  échéance, une lease et un token fenced. Le claim système global joint le
  binding `started`, l'outbox `dispatched` et une tentative `claimed`,
  `in_flight` ou `ambiguous`, puis rappelle le même use case depuis son identité
  exacte. Les lignes historiques dont la provenance d'adapter ne peut pas être
  prouvée sont `blocked`, jamais adoptées silencieusement ;
- `0013_dag_scheduling.sql` ajoute une queue durable coalescente par run. Le
  claim d'un run et chaque transition terminale de step la réveillent dans leur
  transaction métier. Le scheduler système verrouille le run, lit son plan
  immuable, verrouille les steps par `node_key`, puis le job ; il matérialise
  atomiquement les steps prêts et leurs événements avant de consommer le job.
  Un rollback conserve la demande ;
  une demande concurrente derrière un cycle actif reste pending. Les human
  gates, runs non `running`, deadlines closes et dépendances non réussies ne
  créent aucun step ;
- `0014_step_routing.sql` ajoute les décisions de routage immuables et une queue
  durable par step prêt. Le claim global verrouille `run → step → job`, choisit
  la première route figée du plan compatible avec les adapters réellement
  composés, puis persiste atomiquement décision, réservation, tentative,
  événements, journal, outbox et binding. Un plan sans route admissible produit
  un rejet explicite sans tentative ni coût ; un adapter prévu mais absent
  conserve le job avec backoff. La migration backfill les steps prêts cohérents
  et réveille les runs actifs, mais exige le drain des workers pré-`0014` ;
- `0015_run_convergence.sql` et `0016_output_artifacts.sql` ajoutent les
  manifests de résultat et les outputs normalisés nécessaires aux convergences
  terminales échouées ou réussies ; `0017_run_plan_inputs.sql` persiste l'input
  normalisé exact du plan ; `0018_dataset_storage.sql` et
  `0019_enrichment_recipe_storage.sql` portent datasets, imports, recettes,
  applications, cellules et leur replay durable sans créer un second lifecycle
  concurrent aux runs ; `0020_dataset_generation_plans.sql` ajoute séparément
  les plans internes de génération, immuables et idempotents, sans créer de
  dataset ni d'effet provider ; `0021_dataset_generation_materializations.sql`
  instancie ces plans en générations `planned` et matérialisations `building`,
  backfill les imports vers une readiness origin-neutral et rattache l'ordre des
  records à leur matérialisation, toujours sans Run, page, outbox ou ledger ;
- le dispatcher outbox utilise l'horloge PostgreSQL, un lease avec token de
  fencing, retry borné et dead-letter. Il persiste `starting` avant l'appel
  Hatchet ; après timeout, exception ou expiration du lease, il effectue
  uniquement un lookup exact. Une issue non prouvée reste en
  `reconciliation_required` et ne déclenche jamais un second start aveugle ;
- l'adapter Hatchet `1.26.0` et le fake déterministe implémentent le même port.
  Les identifiants et états Hatchet ne traversent ni le kernel, ni les contrats
  publics. Une collision n'est acceptée comme replay qu'après lookup et
  validation de l'identité complète. Le payload enveloppé de `runs.list` est
  normalisé à la frontière SDK avant cette validation fail-closed. Le client
  HTTP Hatchet applique un timeout transport effectif inférieur au timeout du
  use case, afin qu'un endpoint qui accepte puis ne répond plus ne laisse pas
  de socket ou de promesse sans borne ;
- la tâche d'ingress appelle `ClaimRun` via le reducer pur. Le verrou de ligne,
  le CAS et le journal PostgreSQL garantissent qu'une même start key rejoue la
  commande sans second événement ;
- `ClaimStepAttempt` dérive route, adapter d'effet et réservation du plan
  immuable avant de persister l'état `claimed`. La même transaction ajoute
  `RoutingDecisionRecorded`, les événements de tentative, l'outbox et son
  binding ; la redelivery exacte ne crée aucun doublon et le worker ne peut pas
  substituer un adapter. Le dispatcher démarre
  la task Hatchet `kurobara-step-attempt-v1`, puis son callback applique le seuil
  d'effet une fois après revalidation de l'identité durable complète, règle
  l'issue fraîche ou effectue un lookup en replay. Un rejet certain avant effet
  libère la réservation via
  `RecordAttemptNotStarted`. L'adapter composé `deterministic-local` retourne un
  succès synthétique à coût nul et ne prouve son exécution que dans le processus
  courant : il qualifie le protocole. Le mode `configured-providers` compose au
  contraire les routes maintenues configurées : Tavily/Exa derrière le bridge
  plugin de confiance, Prospeo pour la shortlist, l'identité et l'email Contact,
  et Hunter pour company et la vérification. Hunter Finder est une route
  initiale alternative choisie par ordre provider explicite. Les générations
  Contact actuelles bornent la tentative à une et ne basculent donc jamais après
  indisponibilité ou `NO_MATCH`/`not_found` Prospeo. Apollo reste opt-in hors de l'ordre par
  défaut. Un échec
  certain et retryable autorise `AuthorizeRetry` puis une nouvelle décision
  avec la même `operation_key`; une issue ambiguë reste bloquée en
  réconciliation. Une tentative qui n'a pas commencé libère sa réservation
  avant d'autoriser le fallback ;
- après le seuil d'effet, un lookup `not-found` est seulement une observation
  instantanée : il conserve la tentative `ambiguous` et la réservation. Seul un
  résultat `found` peut régler ou libérer le coût. Le reconciler applique un
  timeout, un backoff et un budget bornés ; son épuisement ferme uniquement le
  job technique et laisse l'état métier visible pour intervention ;
- les migrations sont ordonnées, vérifiées par checksum et refusent aussi une
  migration appliquée dont la source a disparu du build.

Les tests PostgreSQL créent des bases temporaires puis les suppriment. Les tests
de fondation couvrent notamment les migrations `0001` à `0021`, l'isolation et
l'immutabilité des snapshots, leur identité exacte, la persistance atomique du
plan et de sa provenance, le backfill des imports, la création et le replay
no-effect d'une génération, l'authentification des clés, l'idempotence concurrente
de création de run, le rollback transactionnel, le dispatch, le retry, le
dead-letter, le fencing, le claim de tentative, son replay, son isolation, la
réservation concurrente bornée, le retry avec opération stable, le settlement
concurrent unique, le rollback après mouvement ledger et la migration réelle
d'une réservation `0009` peuplée. La suite d'orchestration couvre en plus le crash
après un start accepté avant son règlement, la reprise sans second workflow, le
résultat ambigu laissé en réconciliation, le replay de `ClaimRun`, le conflit
de binding d'un même run, le backoff du reconciler, l'arrêt au budget et le reap
atomique d'une dernière claim expirée. La suite leaf dédiée couvre append et
rollback atomiques, replay sans doublon, `SKIP LOCKED`, expiration/reclaim,
fencing stale et cross-tenant, backoff, démarrage atomique, rejet, annulation,
épuisement, reprise d'un binding `starting` dont la tentative est déjà terminale,
fencing du seuil après reset et réparation d'une course post-effet devenue
`ambiguous`. Elle couvre aussi le claim de recovery concurrent, la provenance
d'adapter, le fencing cross-tenant et l'épuisement technique sans mouvement de
réservation. La suite DAG dédiée couvre backfill d'un run `running`,
matérialisation atomique de roots, fan-out/fan-in, rollback partiel, concurrence,
wake-up perdu, isolation workspace et prédécesseur terminal non réussi. Les
trois tests de routage PostgreSQL couvrent aussi commit/rollback atomique,
replay immuable, sélection globale filtrée, contention et distinction entre
absence permanente de route et adapter temporairement indisponible. Les tests
application couvrent en plus l'effet frais exécuté une
fois, la reprise post-seuil par lookup seul et le maintien en `ambiguous` après
une absence momentanée. Un serveur HTTP synthétique qui ne répond
jamais vérifie en plus le timeout transport réel de l'adapter Hatchet. Les
tests application et adapter HTTP couvrent la
discovery bornée et la quote locale depuis des snapshots synthétiques, leurs
frontières d'autorité, leur validation entrée/sortie et le mapping RFC 9457. Le
test HTTP/PostgreSQL démarre
le vrai serveur sur un socket loopback et prouve authentification, isolation
workspace/sujet, discovery vide sans écriture métier, refus d'un hash workflow
absent, quote sans `run_id`, plan et sources exacts, puis zéro run, événement ou
outbox avant consommation. Il crée
ensuite le run, rejoue idempotemment la création et relit le snapshot de coût.
Deux workspaces réutilisent les mêmes identifiants de snapshots sans fuite
tenant. Une requête
volontairement incomplète prouve aussi que le délai d'arrêt force la fermeture
de la connexion active, libère PostgreSQL et laisse le lifecycle en échec. Cette
suite E2E sur PostgreSQL jetable et socket réel est verte dans l'environnement
indiqué.

Le gate V1 ajoute deux preuves ciblées. Le profil fixture compose le registre,
les adapters Tavily/Exa et le bridge avec transports simulés, puis force un
`429` Tavily suivi d'un succès Exa sans réseau. Le profil live exige, après le
vertical, un readback PostgreSQL montrant exactement les tentatives 1 et 2,
Tavily puis Exa, les raisons `initial` puis `fallback`, la même clé d'opération,
les seuils d'effet, les règlements exacts d'une requête et les décisions de
routage correspondantes. Il rejoue aussi l'annulation exacte d'un run en file et
compare l'export après redémarrage. La procédure complète est décrite dans le
[gate V1 headless](./v1-gate.md).

Les preuves de crash et de réconciliation fines utilisent le fake pour contrôler
les fenêtres d'échec et une vraie base PostgreSQL 16.13. Un smoke séparé démarre la
fixture Hatchet self-host épinglée, attend sa readiness, exécute une tâche via le
worker SDK V1 et attend son état `COMPLETED`. Il redémarre ensuite proprement le
service Hatchet, relit l'identité exacte et vérifie dans le TTL une collision
idempotente sans seconde exécution. Un second qualifier lance le processus
complet `apps/worker` contre une base Kurobara PostgreSQL 17.9 isolée. Il prouve
le règlement d'une task leaf Hatchet réelle avec effet `deterministic-local`,
puis l'ordre durable d'un DAG `root → left/right → join` sur quatre leaf tasks,
quatre décisions de routage, quatre identifiants Hatchet distincts et quatre
règlements à coût nul. Routage, réservation et claim sont entièrement
automatiques dans ce qualifier. Le finalizer global fail-closed classe ce DAG
`result-proof-missing` et laisse le run `running`, sans `ResultManifest` ni
`RunCompleted`, car aucune sortie normalisée ne prouve encore le contrat. Un
autre cas tue le worker après complétion Hatchet mais
avant `recordStarted`; le worker redémarré adopte le même identifiant externe
sans doubler settlement, événements ou ledger. Cette preuve locale ne qualifie
pas un crash de Hatchet, un redémarrage PostgreSQL, les fenêtres d'un provider
réel, l'expiration du TTL, l'upgrade/rollback ou une production.

## Rejouer les preuves locales

Le manifest racine exige les versions Node et npm indiquées plus haut.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run architecture:check
npm run architecture:test
npm run generate:check -w @kurobara/contracts
npm run test:plugin-packaging
```

La matrice exacte et son niveau de preuve sont consignés dans la
[compatibilité du runtime](./runtime-compatibility.md).

Le test d'intégration exige une URL vers une base PostgreSQL d'administration
sur laquelle l'utilisateur de test peut créer et supprimer une base jetable :

```bash
KUROBARA_TEST_POSTGRES_URL='postgres://local-user@127.0.0.1:5432/postgres' \
  npm run integration:test:postgres
```

Ne pointez pas cette commande vers une instance de production ou un compte qui
ne doit pas créer de base temporaire.

### Qualifier l'adapter contre Hatchet self-host

Le [harness Hatchet local](../../infra/hatchet/README.md) utilise une topologie
loopback et auth-disabled réservée aux tests. Les images Hatchet `v0.95.3` et
PostgreSQL `17.9` sont épinglées par version et digest :

```bash
npm run hatchet:smoke
npm run hatchet:worker
npm run hatchet:down
```

Le smoke conserve le token embarqué uniquement dans une variable de processus,
ne l'imprime pas et ne l'écrit pas dans le dépôt. `v0.95.3` reste un candidat :
le tag et l'image existent, mais aucune GitHub Release correspondante n'est
publiée. Les volumes nommés sont conservés par `hatchet:down` pour permettre des
tests de redémarrage ultérieurs.

### Démarrer le worker contre un environnement Hatchet explicite

Le point d'entrée n'embarque aucun credential. En développement, il applique les
migrations par défaut ; en production il les vérifie sans les appliquer. Les
valeurs ci-dessous sélectionnent volontairement la fixture déterministe et
doivent être remplacées par les endpoints et le token de votre instance locale :

```bash
NODE_ENV='development' \
KUROBARA_DATABASE_URL='postgres://local-user@127.0.0.1:5432/kurobara' \
KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS='250' \
KUROBARA_DISPATCHER_ID='dispatcher-local-1' \
KUROBARA_LEAF_DISPATCHER_ID='leaf-dispatcher-local-1' \
KUROBARA_LEAF_EFFECT_ADAPTER='deterministic-local' \
KUROBARA_LEAF_EFFECT_RECONCILER_ID='effect-reconciler-local-1' \
KUROBARA_RECONCILER_ID='reconciler-local-1' \
KUROBARA_ROUTE_SCHEDULER_ID='route-scheduler-local-1' \
KUROBARA_ROUTE_SCHEDULER_POLL_INTERVAL_MS='250' \
KUROBARA_ROUTE_SCHEDULER_RETRY_DELAY_MS='5000' \
KUROBARA_WORKER_ID='worker-local-1' \
HATCHET_CLIENT_API_URL='http://127.0.0.1:8888' \
HATCHET_CLIENT_HOST_PORT='127.0.0.1:7077' \
HATCHET_CLIENT_TLS_STRATEGY='none' \
HATCHET_CLIENT_NAMESPACE='kurobara-local' \
HATCHET_CLIENT_TOKEN='synthetic-local-token' \
  npm start -w @kurobara/worker
```

Le démarrage vérifie/applique le schéma PostgreSQL, ouvre l'executor Hatchet,
attend sa readiness bornée, puis lance le reconciler de starts, le reconciler
d'effets, le dispatcher de tentative, le scheduler de routage, le scheduler DAG
et enfin le dispatcher de run.
`KUROBARA_LEAF_EFFECT_ADAPTER` est requis et accepte `deterministic-local` ou
`configured-providers`. Le second mode dérive les routes de
`KUROBARA_PROVIDER_ORDER` (par défaut `prospeo,hunter`) et exige le
credential de chaque route retenue dans `PROSPEO_API_KEY`, `HUNTER_API_KEY`,
`TAVILY_API_KEY` ou `EXA_API_KEY`. `APOLLO_API_KEY` n'est lu que lorsque
`apollo` est ajouté explicitement à l'ordre. Tavily et Exa exigent eux aussi un
ordre explicite ; leur présence dans le dépôt ne constitue ni une admission
contractuelle ni une autorisation de conserver ou d'exporter leurs outputs.
Exa reste en outre fermé sans
`KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true`, que l'opérateur ne doit positionner
qu'après avoir obtenu des termes écrits couvrant son usage ; ce booléen ne
constitue pas la preuve de ces termes.
Consultez la [policy BYOK](../policies/byok-provider-terms.md). Ces valeurs
restent dans
l'environnement du processus ; aucun stockage de secrets durable n'est fourni.
Les limites du
dispatcher leaf sont
configurables via `KUROBARA_LEAF_OUTBOX_*`. Le
reconciler utilise par défaut un batch de 10, une lease de 30 secondes, un
timeout applicatif de lookup de 10 secondes, un poll de 5 secondes, un backoff
de 60 secondes et dix tentatives. Le transport HTTP Hatchet est borné à la
moitié de ce timeout applicatif ; chaque valeur publique est configurable par
les variables `KUROBARA_RECONCILER_*` bornées dans `apps/worker/src/config.ts`.
Le reconciler d'effets possède ses limites indépendantes via
`KUROBARA_LEAF_EFFECT_RECONCILER_*` : délai initial de 60 secondes, batch de 10,
lease de 30 secondes, timeout de 10 secondes, poll de 5 secondes, backoff de 60
secondes et dix tentatives par défaut.
Le scheduler DAG ne prend aucun batch métier ni lease externe : chaque cycle
PostgreSQL est une transaction courte et globale qui claim un run via
`SKIP LOCKED`. Son poll vaut 250 ms par défaut et se configure entre 1 ms et
60 secondes avec `KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS`.
Le scheduler de routage claim pareillement un seul job global éligible. Son poll
et son backoff après indisponibilité temporaire sont configurables via
`KUROBARA_ROUTE_SCHEDULER_POLL_INTERVAL_MS` et
`KUROBARA_ROUTE_SCHEDULER_RETRY_DELAY_MS` ; son identité explicite vient de
`KUROBARA_ROUTE_SCHEDULER_ID`.
Tous les replicas d'un même déploiement doivent partager le même budget de
tentatives ; le reap traite au plus cent lignes par cycle pour rester borné. Le
smoke qualifie l'adapter et son worker SDK ; `hatchet:worker` qualifie le
processus complet `apps/worker`, son dispatcher leaf, son callback, sa base
Kurobara, la matérialisation multi-step root/fan-out/fan-in et une fenêtre
`SIGKILL` contrôlée. Le routage/claim automatique est couvert ; la terminaison
globale du run et les autres fenêtres de crash restent hors de cette preuve.

Pour créer une première clé locale, configurez explicitement l'URL PostgreSQL,
le workspace, l'acteur et les permissions, puis utilisez le script du package
API. Sa sortie contient le secret en clair une seule fois et doit être traitée
comme sensible :

```bash
KUROBARA_DATABASE_URL='postgres://local-user@127.0.0.1:5432/kurobara' \
KUROBARA_BOOTSTRAP_WORKSPACE_ID='workspace_demo' \
KUROBARA_BOOTSTRAP_ACTOR_ID='actor_demo' \
KUROBARA_BOOTSTRAP_PERMISSIONS='capabilities:list,datasets:import,plans:quote,recipes:apply,recipes:read,recipes:register,runs:cancel,runs:create,runs:read' \
  npm run bootstrap:api-key -w @kurobara/api
```

Le bundle opérateur local de référence est
[`examples/planning-bundle.v1.json`](../../examples/planning-bundle.v1.json).
La commande `--check` valide le fichier strictement et compile chaque workflow
avec ses limites déclarées, sans ouvrir PostgreSQL :

```bash
npm run --silent bootstrap:planning -w @kurobara/api -- \
  --check --file ../../examples/planning-bundle.v1.json
```

L'application réelle exige l'URL PostgreSQL. Elle applique les migrations, écrit
le lot dans une transaction, relit chaque snapshot demandé dans une transaction
`REPEATABLE READ READ ONLY` après commit puis
retourne une ligne JSON avec `status: applied` ou `status: unchanged` et la
révision courante des defaults :

```bash
KUROBARA_DATABASE_URL='postgres://local-user@127.0.0.1:5432/kurobara' \
  npm run --silent bootstrap:planning -w @kurobara/api -- \
  --apply --file ../../examples/planning-bundle.v1.json
```

Le champ machine `mutation_state` décrit uniquement la transaction du bundle.
Les migrations sont un préalable roll-forward distinct : elles peuvent déjà
avoir été appliquées même si le bundle est ensuite refusé et déclaré
`rolled-back`.

La lecture opérateur récupère l'état actif borné : defaults et révision CAS,
policy/pricing actives et compteurs des historiques de chaque type. Elle ne
charge donc pas tout l'historique immuable en mémoire. Sans appliquer de
migration ni effectuer d'écriture, elle vérifie que le schéma attendu est déjà
appliqué, puis retourne `status: available` ou `status: not-configured` :

```bash
KUROBARA_DATABASE_URL='postgres://local-user@127.0.0.1:5432/kurobara' \
  npm run --silent bootstrap:planning -w @kurobara/api -- \
  --read --workspace workspace_demo
```

Le fichier doit être un JSON UTF-8 strict, régulier, non symlink, non inscriptible
par le groupe ou le monde, et limité à 1 Mio. Les clés inconnues ou dupliquées,
les identités de workspace divergentes et une version d'autorité autre que
`1.0.0`, une version de compilateur autre que celle du runtime ou un workflow
non compilable sont refusés avant l'ouverture de la base.
Pour une première activation,
`expectedDefaultsRevision` vaut `null`. Pour changer les defaults, il reprend la
révision retournée par le dernier apply ou `--read` ; un replay visant déjà les
mêmes defaults reste un no-op, même avec une ancienne révision.

## Limites encore ouvertes

- La génération provider-neutral possède désormais pagination multi-page,
  leases PostgreSQL, reprise, déduplication, compteurs/ledger et terminaison
  origin-neutral. Chaque page passe par le runtime `Run`, revalide caps,
  deadline et budget, puis checkpoint records, provenance et coût depuis les
  preuves durables. Les surfaces company sont disponibles sur REST, SDK et CLI,
  y compris `GET /v1/dataset-generations/{generation_id}/company-candidates`,
  `organizations.listCandidates()` et `company results` pour une matérialisation
  `ready`, par page de 1 à 100 avec `datasets:read`.
  Hunter Discover a passé le 22 juillet 2026 un appel live expurgé sur sa
  première page : taille provider 100, cap Kurobara local à un candidat, clé
  jamais journalisée et aucun payload brut conservé. Les pages suivantes,
  options Premium et droits de redistribution restent non qualifiés. Le runtime
  Contact est désormais composé de la génération Entreprises `ready` jusqu'à
  la lecture de la shortlist, aux datasets dérivés d'identité/email et à leur
  export CSV/JSONL. Prospeo Search Person groupe au plus dix entreprises et une
  requête par page durable ; le `person_id` reste dans la lineage restreinte.
  Enrich Person force `enrich_mobile=false`. L'email éventuellement reçu pendant
  l'identité est supprimé, mais son crédit peut avoir été consommé ; Kurobara ne
  garantit pas le rejeu gratuit pendant 90 jours annoncé par Prospeo. Le ledger
  reste en `requests`, pas en crédits provider exacts. L'adapter et le runtime
  sont qualifiés hors ligne. Un probe live expurgé a aussi validé Search Person
  puis Enrich Person sur un sujet borné, avec email vérifié, répétition de
  search gratuite et aucun mobile ; il ne prouve pas le parcours durable
  complet. MCP reste non livré.
- `POST /v1/plans` est une route locale fondée sur des snapshots PostgreSQL
  chargés par la commande opérateur hors ligne. La quote ne contacte aucun
  provider et ne demande aucun prix live. Les routes
  Prospeo/Apollo/Hunter/Tavily/Exa
  sont dérivées localement des credentials présents ; il n'existe pas de surface
  self-service distante pour les admettre, les configurer ou faire évoluer
  pricing et policy.
  Sans route exacte, la quote retourne `service-unavailable` avant toute
  persistence.
- `plans.quote` ne possède ni idempotency key dans sa requête, ni contrat de
  transport de replay. Une redelivery réussie peut créer un nouveau plan et une
  nouvelle quote ; le catalogue annonce donc `not-supported`. L'idempotence
  obligatoire pour la V1 reste à définir via RFC et version de contrat.
- `normalized_input_hash` est validé structurellement puis incorporé au plan,
  mais reste fourni par le client. Sans entrée normalisée ou référence durable
  dans un prochain contrat, le serveur ne peut pas le recalculer ni en prouver
  l'origine. Le bootstrap vérifie l'identité déclarée d'un workflow mais ne
  recalcule pas encore son `contentHash` depuis une représentation canonique
  publique.
- La garantie `hard` borne le pire coût total du plan : maximum des fallbacks
  par node, multiplié par le nombre maximal de tentatives, puis additionné sur
  le DAG et comparé à la quote et au budget. Une quote `estimated` ne devient
  pas artificiellement un plafond ; chaque réservation reste néanmoins bornée
  par le budget. Le claim réserve atomiquement dans le budget du run. Il ne
  réserve pas encore un budget
  partagé entre plusieurs runs au niveau autorité ou workspace : plusieurs
  quotes peuvent donc sur-allouer cette enveloppe globale. Le ledger mesure les
  requêtes provider du run, pas une facture ou un quota partagé externe.
- Les lignes de plan antérieures à la migration de provenance peuvent rester
  sans `run_plan_sources`. Le chemin `POST /v1/plans` exige une provenance
  complète, mais la migration ne fabrique pas de sources qu'elle ne peut pas
  prouver.
- `GET /v1/capabilities` ne retourne que des références id/version présentes à
  la fois dans une enveloppe exacte et dans le catalogue runtime composé. Ce
  catalogue reflète la présence des credentials, l'ordre opérateur et le gate
  de droits Exa
  Prospeo/Apollo/Hunter/Tavily/Exa, mais
  n'expose ni secret, ni health live, ni prix ou quota provider.
- L'adapter et le processus complet `apps/worker` avec sa leaf task ont été
  exécutés contre la fixture Hatchet self-host candidate. Une fenêtre
  `SIGKILL` après complétion Hatchet et avant `recordStarted` est qualifiée ; un
  crash de Hatchet, les autres fenêtres du runtime, le redémarrage PostgreSQL,
  la pause/reprise et l'upgrade/rollback restent non vérifiés. Roots,
  fan-out/fan-in et l'absence de fan-in prématuré sont qualifiés sur la fixture
  réelle avec routage/claim automatique. Un échec requis peut désormais
  converger atomiquement avec ses descendants `skipped` et un
  `ResultManifest` d'échec. Le vertical live qualifie aussi une sortie provider
  validée, sa convergence, son fallback et son export après redémarrage. Les
  migrations `0013` à `0019` exigent de drainer
  et arrêter les workers antérieurs avant application :
  un ancien writer ne réveille pas les nouvelles queues après ses transitions,
  donc le rolling upgrade reste hors de la preuve.
  Le reconciler
  application/PostgreSQL est composé périodiquement dans `apps/worker` ; un
  budget épuisé exige toujours une intervention opérateur explicite.
- `runs.cancel` annule atomiquement un run `queued` et son replay exact. Pour un
  run `running` ou `waiting`, la commande persiste `cancelling` et réveille le
  scheduler. `SettleCancellation` converge ensuite vers `cancelled` uniquement
  lorsque chaque tentative et réservation est durablement fermée, puis projette
  atomiquement la cellule en `skipped`. Les tests application prouvent aussi que
  les effets préparés, réclamés, en vol ou ambigus maintiennent l'annulation
  ouverte. Le gate live exerce pour sa part le cas `queued` et son replay exact.
- Le bearer API key est un profil local self-host. Il n'existe ni OAuth distant,
  ni terminaison TLS, ni validation audience/issuer, ni transport MCP distant
  qualifié.
- Le bootstrap hors ligne n'est pas un lifecycle HTTP de clés : aucune route de
  création, liste, rotation ou révocation de clés API n'est fournie par cette
  tranche.
- Les credentials provider viennent de l'environnement ou du fichier privé
  `0600` du gate et restent en mémoire des processus. Il n'existe pas encore de
  `SecretsPort`, rotation ou stockage durable de secrets.
- Aucun hébergement managé/public, domaine, release, support opérationnel ou
  préparation production n'est démontré. La topologie Compose du gate est une
  fixture locale jetable, pas une stack de référence supportée.
- Le rescan du 2026-07-23 a corrigé les versions vulnérables de `fast-uri` et
  `@hono/node-server`. `npm run security:audit` contrôle le lockfile de
  production après `npm ci` dans la CI. Ce résultat reste une preuve ponctuelle,
  pas une acceptation durable du risque supply-chain ni un substitut aux scans
  des artifacts de release.
- Les steps et tentatives disposent du claim, de l'outbox, de la leaf task, du
  règlement exact, de la reprise périodique fenced et d'un
  scheduler DAG automatique de matérialisation ainsi que d'un routage/claim
  automatique. La planification publique dérive désormais capabilities et
  routes d'un même catalogue statique, fige leur ordre et leur provenance dans
  le plan, puis refuse tout workflow sans route exacte avant persistence.
  Tavily et Exa partagent la capability et le fallback retryable est durablement
  prouvé. Le classement reste un ordre explicite configuré, pas un scoring live
  adaptatif ; signaux humains, délégation et budget partagé autorité/workspace
  restent absents.
- L'implémentation et la qualification BYOK locales d'Exa et Tavily ne valent
  pas approbation de leurs conditions standard pour une distribution OSS, ni
  validation juridique ou production.
- Le [kit local de conformité des plugins](./plugin-conformance.md) produit un
  rapport machine-readable pour l'artifact, la matrice et le runtime exacts. Il
  n'exerce aucun provider, credential ou réseau réel ; le host ne bloque pas
  techniquement l'egress. Les adapters providers maintenus par Kurobara
  utilisent un bridge de confiance distinct ; aucune sandbox tierce, CI Linux
  ou production n'est qualifiée.
- Le catalogue utilise le namespace réservé `.invalid`. Le contrôle du domaine
  public, la qualification complète Draft 2020-12 et la matrice de compatibilité
  restent des gates de `CONTRACT-001`.
- Le site, le Worker Cloudflare, l'ancien stockage et les anciens clients ont
  été supprimés. Un SDK HTTP et une CLI minimaux couvrent maintenant import et
  apply, le snapshot watch, l'export direct d'application et l'annulation sur les
  contrats V1. Console, MCP, SSE, lifecycle d'export durable et packaging public
  restent à construire ; leur absence est explicite et ne vaut pas livraison.
- La qualification locale du 20 juillet 2026 a passé les profils fixture et
  live avec `--require-clean` depuis un clone `--no-local`; Codex CLI `0.144.4`
  y a aussi piloté la fixture sans mutation. Claude Code `2.1.81` reste non
  qualifié : le compte local a refusé la session avant tout token ou outil
  faute de crédit. Cette compatibilité optionnelle ne bloque pas la gate
  agent-neutral. Aucun package, image ou endpoint public n'est déclaré
  qualifié.
- Les gates d'architecture sont locales ; leur branchement comme checks GitHub
  requis appartient encore au backlog.

## Sources de conception

- [Frontières du monolithe modulaire](../architecture/module-boundaries.md)
- [Système de contrats](../architecture/contract-system.md)
- [Domaine et cycles de vie](../architecture/domain-lifecycle.md)
- [Kit local de conformité des plugins](./plugin-conformance.md)
- [Roadmap publique V1](../../ROADMAP.md)
