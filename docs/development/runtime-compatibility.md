# Compatibilité du runtime V1

- Statut : **matrice locale partielle, aucune qualification de production**
- Date de vérification : **2026-07-20**
- Publication : **aucune**

Cette matrice sépare les versions réellement exécutées des dépendances seulement
compilées. Une version requise absente ou non qualifiée reste une gate de
`RUNTIME-001` ; un outil explicitement optionnel ne bloque pas le candidat.
Codex CLI et Claude Code sont des clients d'automatisation observés, pas des
composants requis du runtime Kurobara.

| Composant | Version | Preuve de cette tranche | Statut |
| --- | --- | --- | --- |
| Node.js | `24.14.0` | typecheck, tests, build et contrôles d'architecture | vérifié localement |
| npm | `10.9.4` | installation verrouillée et scripts racine | vérifié localement |
| Codex CLI | `0.144.4` | fixture complète `--require-clean` pilotée dans le sandbox workspace-write | vérifié localement pour ce parcours |
| Claude Code | `2.1.81` | invocation non interactive refusée avant tout token ou outil par le crédit du compte | non qualifié, optionnel |
| PostgreSQL Kurobara | `16.13` | tests sur bases jetables, migrations `0001` à `0027` | vérifié localement |
| Ajv | `8.20.0` | validation stricte JSON Schema 2020-12 de l'output local, tests d'acceptation, rejet et référence de contrat | vérifié localement |
| Plugin contracts / SDK / host / conformance | `0.1.0` | tarballs locales installées offline, template extérieur compilé et rapport canonique exercé sous le profil `dev.kurobara.plugin-conformance/local-v1@1.1.0` | matrice exacte Node `24.14.0` sur `darwin/arm64` et `linux/x64` |
| Hatchet TypeScript SDK | `1.26.0` | tests adapter, smoke et processus worker complet contre le serveur ci-dessous | vérifié localement |
| PostgreSQL du harness Hatchet | `17.9` | services internes Hatchet et application Kurobara isolés, conteneurs sains, tests Kurobara sur bases jetables et trois scénarios worker | vérifié comme fixture locale |
| Hatchet OSS server | tag/image `v0.95.3`, digest `sha256:059e79e7f5044581cd2394b5b4212b0911642ed5486662c4a637d0bcf028ecdc` | readiness, worker SDK, quatre leaf tasks automatiquement routées d'un DAG root/fan-out/fan-in avec effet `deterministic-local`, redémarrage propre, lookup du run terminé et collision dans le TTL ; Hatchet reste actif pendant le `SIGKILL` du processus Kurobara | candidat qualifié localement, non supporté |

Le tag `v0.95.3` et son image sont publiés en amont, mais aucune GitHub Release
correspondante n'est publiée. La dernière release GitHub visible est
`v0.94.10`, qui précède l'implémentation serveur exigée par l'idempotence du SDK
`1.26.0`. Le harness traite donc `v0.95.3` comme candidat immuable, jamais comme
version stable ou supportée. Voir le [harness local](../../infra/hatchet/README.md),
le [changelog du SDK](https://docs.hatchet.run/reference/changelog/typescript),
la [release v0.94.10](https://github.com/hatchet-dev/hatchet/releases/tag/v0.94.10)
et le [diff v0.94.10...v0.95.3](https://github.com/hatchet-dev/hatchet/compare/v0.94.10...v0.95.3).

Le profil plugin ne couvre aucune autre combinaison. Il ne prouve ni provider,
credential, contrôle réseau, sandbox, composition API/worker ou
runtime tiers de production. Le package de conformité et le template restent
privés et aucun artifact n'est publié sur un registre. Voir le
[guide du kit local](./plugin-conformance.md).

## Garanties qualifiées

- une start key stable et durable est créée avec le run et son message outbox ;
- `starting` est persisté avant l'appel externe ;
- un start enregistré avant l'échec de règlement n'est pas relancé ; une issue
  inconnue déclenche ensuite un lookup exact sans second start ;
- timeout, exception, lookup ambigu ou absent imposent une réconciliation ;
- le reconciler PostgreSQL utilise un lease fenced par item, un délai avant
  retry et un budget persistant plafonné à cent tentatives ; son claim système
  couvre les workspaces sans liste statique, tandis que chaque règlement reste
  borné au workspace et au token exacts du claim. Une claim finale expirée est
  reaped atomiquement en `reconciliation_exhausted` avec son outbox en
  `dead_letter` par un reap borné exécuté une fois par cycle ;
- `apps/worker` lance et supervise périodiquement ce reconciler entre l'executor
  et le dispatcher, sans chevauchement de cycles ;
- une queue PostgreSQL coalescente réveille un scheduler système après le claim
  du run et chaque transition terminale de step. Le même commit matérialise les
  `StepRun ready`, leurs événements `StepReady` et consomme le job ; un rollback
  conserve le job pending. `SKIP LOCKED`, l'ordre d'accès
  `run verrouillé → plan immuable lu → steps verrouillés → job verrouillé` et des
  identités déterministes empêchent doublons, wake-up perdu et fuite
  cross-workspace ;
- chaque `StepRun ready` réveille une queue de routage durable. Le scheduler
  choisit la première route figée du plan dont l'adapter est effectivement
  composé, puis committe dans une transaction la décision immuable, la
  réservation, la tentative claimée, les événements, l'outbox et le binding.
  Une absence permanente de route échoue fermée sans coût ; une indisponibilité
  temporaire conserve le job avec backoff ;
- après acceptation d'une leaf task, un second reconciler PostgreSQL réclame les
  callbacks non terminaux avec `SKIP LOCKED`, provenance d'adapter, lease/token,
  délai initial, timeout, backoff et budget persistants. Il rappelle
  `ExecuteLeafAttempt` depuis l'identité exacte et ne resoumet pas Hatchet ;
- après le seuil, `not-found` ne conclut jamais l'absence définitive d'effet :
  la tentative reste `ambiguous` et sa réservation reste détenue. Seul `found`
  peut régler le ledger ; l'épuisement ferme le job technique sans fabriquer
  une issue métier ;
- le lookup Hatchet est borné à la fois dans le use case et dans le transport
  HTTP Axios du SDK ; un endpoint blackholé est interrompu par le transport ;
- une collision Hatchet réelle est revalidée par workspace, run, événement,
  start key et identifiant externe avant d'être acceptée comme replay ;
- le payload enveloppé renvoyé par `runs.list` est normalisé à la frontière SDK,
  puis validé avec les métadonnées exactes ;
- `ClaimRun` est journalisé et rejoué sans second événement métier ;
- chaque claim de tentative ajoute atomiquement une outbox et un binding
  `effect:<attempt_id>` ; le dispatcher utilise lease/token, `SKIP LOCKED`,
  backoff et lookup exact avant toute nouvelle soumission. Une liste Hatchet
  vide reste `outcome-unknown` : elle n'est jamais interprétée comme une preuve
  d'absence linéarisable ;
- une tentative terminalisée avant tout start externe annule encore son binding
  `pending`. Si le binding avait déjà atteint `starting`, la tentative terminale
  reste au contraire réclamable en `reconciliation_required` afin de retrouver
  l'exécution externe exacte et de ne pas perdre sa corrélation ;
- `resetPending` verrouille binding, message et tentative dans le même ordre que
  le seuil d'effet, et ne s'applique qu'à une tentative encore `claimed`. Un
  callback tardif est fenced après le reset ; toute preuve post-effet déjà
  visible sur un binding `pending` le répare en `reconciliation_required` au
  prochain claim au lieu de l'annuler ;
- la task Hatchet `kurobara-step-attempt-v1` valide strictement workspace, run,
  step, tentative, événement et start key, puis appelle le use case d'effet ;
- le fake d'orchestration couvre acceptation, collision, rejet et issue inconnue,
  tandis que l'adapter d'effet `deterministic-local` qualifie uniquement le
  règlement local à coût nul. Son lookup ne retourne `found` qu'après une
  exécution observée dans le processus courant ; un redémarrage ne fabrique pas
  de succès rétroactif ;
- l'effet local produit un objet JSON déterministe sans donnée utilisateur. Le
  worker enregistre son schéma canonique au démarrage, vérifie son fingerprint
  contre le manifest généré et injecte un validateur Ajv `8.20.0` strict. Le
  `ContractRef` du plan doit correspondre exactement au catalogue, au schéma et
  à leurs fingerprints ; un contrat absent, un fingerprint différent ou une
  propriété additionnelle ferme la transition en échec ;
- seul le sink unique du DAG peut produire l'output du run. Après validation,
  PostgreSQL persiste atomiquement un artifact JSON normalisé immuable, limité à
  64 Kio, le `ResultManifest`, les événements `RunResultManifestRecorded` et
  `RunCompleted`, puis la commande `CompleteRun`. Le run ne passe à
  `completed/complete` qu'avec ce bundle cohérent.

Le smoke réel soumet une identité synthétique unique, observe une exécution du
worker et attend l'état `COMPLETED`. Il redémarre ensuite proprement le seul
service Hatchet, relit le même identifiant et vérifie qu'une seconde soumission
dans le TTL de 120 secondes retourne la collision existante sans seconde
exécution. Le token de la fixture auth-disabled reste une variable de processus
et n'est ni imprimé ni persisté par Kurobara. Le handoff inter-phases ne contient
que des identifiants synthétiques, utilise le mode `0600` et est supprimé.
Le qualifier `hatchet:worker` lance séparément le vrai processus
`apps/worker`, crée un plan et un run valides, exécute une task leaf Hatchet
réelle avec effet `deterministic-local` et relit
les états PostgreSQL/Hatchet exacts. Son scénario de crash attend la fin Hatchet,
bloque précisément la transaction `recordStarted`, tue le worker et termine ses
backends PostgreSQL bloqués avant de relâcher la barrière,
puis prouve après restart l'adoption du même identifiant externe avec un seul
settlement, un seul événement de succès et une seule entrée de ledger. Son
scénario DAG matérialise successivement `root`, le fan-out `left`/`right`, puis
le fan-in `join` seulement après les deux succès. Les quatre exécutions Hatchet
sont distinctes et terminées, avec quatre settlements et quatre entrées de
ledger à coût nul. Elles proviennent de quatre décisions de routage immuables,
quatre réservations et quatre claims automatiques ; l'adapter synthétique est
admis par le plan, jamais choisi arbitrairement par le worker. Le qualifier
persiste un seul artifact pour le sink `join`, valide son payload avec Ajv, puis
finalise le run avec un seul manifest et les événements de complétion. Après un
redémarrage du worker, une réactivation artificielle du job déjà terminal
converge vers `stale-terminal` sans dupliquer artifact, manifest, commande ou
événement. Le scénario de crash attend désormais que le résultat global soit
durable avant le `SIGKILL`, puis prouve après reprise l'adoption du même
identifiant externe et la stabilité du bundle de résultat.

## Gates Hatchet encore ouvertes

Avant de fermer `RUNTIME-001`, la matrice doit encore démontrer sur une version
amont publiée et supportable :

1. crash avant la soumission distante et fenêtres réelles autour d'un effet
   provider ; la fenêtre leaf après fin Hatchet et avant `recordStarted` est
   désormais qualifiée pour l'effet local déterministe ;
2. rétention et lookup au-delà du TTL d'idempotence configuré ;
3. crash non propre de Hatchet et redémarrage de PostgreSQL ;
4. pause/reprise et annulation ;
5. upgrade puis rollback avec données existantes ;
6. convergence globale en résultat partiel et annulation avec
   `ResultManifest` prouvé ; le succès complet et l'échec fail-closed sont
   couverts séparément, sans output inventé ;
7. routage adaptatif et fallback multi-provider.

Les migrations `0013` à `0019` ne sont pas qualifiées pour un déploiement
roulant avec des workers antérieurs encore actifs : ces anciens writers ne
créent pas les jobs de scheduling ou de routage après leurs transitions.
Jusqu'à la qualification upgrade/rollback, ils doivent donc être drainés et
arrêtés avant application de la migration correspondante et démarrage des
nouveaux schedulers. Les backfills uniques ne remplacent pas cette barrière de
version.

La fenêtre entre la persistance de `starting` et l'appel distant reste
volontairement traitée comme inconnue : sans preuve externe, Kurobara ne relance
pas automatiquement. L'opérateur peut effectuer le lookup exact via le
reconciler ; après épuisement du budget, le binding devient
`reconciliation_exhausted` et son message outbox `dead_letter` pour investigation
et intervention explicite.

La [fondation exécutable](./v1-foundation.md) décrit les preuves et limites
liées à cette matrice.
