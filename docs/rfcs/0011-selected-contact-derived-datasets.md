# RFC-0011 — Datasets dérivés pour les contacts sélectionnés

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-22
- Supersedes: none
- Related ADRs: ADR-0005, ADR-0006, ADR-0007

## Summary

Kurobara matérialise la révélation d'identité professionnelle, la résolution
d'email professionnel et, lorsqu'elle est explicitement demandée, sa
vérification comme des
`DatasetGeneration` dérivées. Chaque génération reçoit un dataset source
`ready`, une sélection exacte de un à trois records et produit un nouveau
dataset immuable de même cardinalité. Une page traite exactement un record
source et déclenche au plus un effet provider.

Le parcours P0 est une chaîne explicite :

```text
shortlist Contact
  → contacts.identity.reveal
  → contacts.work-email.resolve
  → inspection de work_email_verification par le client ou l'agent
  → contacts.work-email.verify (optionnel et explicitement demandé)
  → dataset Contact enrichi prêt
  → export exact CSV ou JSONL
```

Le dataset de résolution conserve le statut renvoyé par Prospeo. Le client ou
l'agent l'inspecte et décide s'il crée une génération de vérification distincte.
Le serveur ne crée, ne saute et ne remplace jamais automatiquement cette
génération par une copie du statut existant. Une demande explicite de
vérification exécute Hunter Verifier pour chaque record sélectionné. Résolution
Prospeo et Verifier restent ainsi deux capacités, deux décisions et deux coûts
distincts, sans introduire un orchestrateur propre aux contacts.

Cette décision réutilise l'aggregate `DatasetGeneration`, les `Run`,
`Attempt`, réservations et écritures de consommation existants. Elle ne crée ni
second orchestrateur, ni table de ledger parallèle, ni lifecycle d'opération
Contact concurrent.

## Current implementation reality

Sur la révision locale qui implémente cette décision :

- la recherche d'entreprises, la shortlist et les trois capacités Contact
  utilisent des `DatasetGeneration` durables ;
- la shortlist publique conserve une identité `obfuscated` et la lineage
  restreinte conserve le sujet provider ;
- la migration `0029_contact_derived_dataset_lineage.sql` et les loaders
  PostgreSQL relisent sous le même workspace le record sélectionné et sa
  lineage provider restreinte ;
- l'API et le worker composent Prospeo Search Person/Enrich Person, Hunter
  Verifier et une route Finder alternative lorsque les credentials et le secret
  privacy requis sont présents ; Finder peut être priorisé par un ordre provider
  explicite, mais le plan actuel à une tentative ne bascule jamais après une
  indisponibilité ou un simple `NO_MATCH`/`not_found` Prospeo ; Apollo reste opt-in hors de l'ordre par
  défaut ;
- REST, le SDK TypeScript et la CLI créent les générations dérivées et suivent
  leurs identités stables ;
- `datasets.export@1.0.0` expose le dataset final en CSV ou JSONL, avec un garde
  Contact supplémentaire ;
- la gate métier fixture exerce directement les adapters provider et les codecs
  sans réseau. Elle ne traverse pas à elle seule l'application, PostgreSQL, le
  worker, HTTP, le SDK ou la CLI ; ces couches possèdent des tests séparés. En
  particulier, `test/integration/http-sdk-dataset-export.test.ts` fait consommer
  le vrai handler HTTP d'export chunké par le SDK.

Le statut `Accepted` enregistre la décision et cette section décrit sa
composition locale. Un probe séparé et expurgé du 22 juillet a qualifié Search
Person puis Enrich Person sur un sujet borné, avec répétition de search gratuite,
email professionnel vérifié et aucun mobile. Il ne prouve ni le parcours durable
complet, ni Hunter live, ni une release, un package ou un service public.

## Problem

Les trois enrichissements aval ont besoin des garanties déjà résolues par
`DatasetGeneration` : sélection immuable, budget, deadline, reprise,
idempotence, résultat ambigu, coût, matérialisation et lineage. Leur donner un
aggregate, un scheduler et un ledger propres dupliquerait ces garanties et
créerait deux vérités concurrentes dans PostgreSQL.

Une recette de cellule générique ne constitue pas non plus la bonne unité. La
révélation d'identité produit plusieurs champs cohérents, doit copier l'emploi
sans en modifier artificiellement la fraîcheur et doit transmettre une lineage
provider restreinte à l'étape email. Une mutation en place du dataset source
casserait enfin son immutabilité et rendrait replay, audit et export ambigus.

La route technique de révélation ne partage pas nécessairement l'identité de
la source. Par exemple, l'effet `prospeo-person-enrichment` consomme un sujet du
namespace `prospeo-person-search`. Confondre route et namespace empêcherait de
réutiliser une identité acquise par une route différente.

## Goals and non-goals

### Goals

- réutiliser le runtime durable et le ledger existants ;
- borner chaque étape à un à trois records sélectionnés du même dataset ;
- produire un record dérivé pour chaque record source, y compris en cas de
  `not_found` certain ;
- conserver une lineage exacte `source_dataset_id` + `source_record_id` ;
- séparer la route d'effet du namespace d'identité provider ;
- vérifier privacy et tombstones avant planification puis juste avant l'effet ;
- arrêter toute nouvelle dépense sur une issue ambiguë ;
- distinguer résolution et vérification, exposer le statut du resolver et
  laisser le client ou l'agent choisir explicitement s'il paie une vérification ;
- rendre le dernier dataset réutilisable par une recette ou un export exact ;
- exposer les mêmes identités, états et erreurs via REST, SDK TypeScript et CLI.

### Non-goals

- téléphone, email personnel ou waterfall multi-provider automatique ;
- scraping LinkedIn, outreach ou envoi de messages ;
- mutation en place d'un dataset ou d'un record source ;
- UI, MCP, planner LLM ou décision produite par un modèle ;
- lifecycle, scheduler, ledger ou orchestrateur spécifique aux contacts ;
- endpoint synchrone qui retourne directement une coordonnée provider ;
- qualification juridique des usages ou droits du compte BYOK de l'opérateur.

## Proposal

### Une génération par capacité

Les capacités P0 sont :

- `contacts.identity.reveal@1.0.0` ;
- `contacts.work-email.resolve@1.0.0` ;
- `contacts.work-email.verify@1.0.0`.

Chacune crée une `DatasetGeneration` avec :

- un `source_dataset_id` dont la matérialisation est `ready` ;
- de un à trois `source_record_ids` uniques, dans l'ordre demandé ;
- un dataset de destination distinct ;
- une autorité, une deadline et un budget explicites ;
- une query fermée qui ne contient aucun identifiant provider ;
- une limite de trois pages, trois records et trois effets au maximum ;
- une partition source par record sélectionné.

Une page correspond à un record source et à au plus un effet externe. Elle
charge sous le même workspace le record et sa lineage restreinte, applique les
contrôles, exécute l'effet demandé, puis checkpoint atomiquement le record
dérivé, sa lineage et la référence au coût réglé. L'ordre des pages suit l'ordre
immuable de la sélection.

Les transitions, tentatives, réservations, règlements, annulations et
réconciliations utilisent les tables et ports existants de
`DatasetGeneration` et du runtime `Run`. Une migration peut étendre la lineage
ou les read models, mais aucune table de coûts ou d'opérations Contact parallèle
n'est admise.

### Datasets dérivés immuables et lineage 1:1

Chaque record source produit exactement un record destination. La nouvelle
identité de record est déterministe pour la génération et la source ; elle ne
remplace pas l'identité du record source. La lineage interne conserve au
minimum :

```text
source_dataset_id
source_record_id
source_generation_id?
effect_adapter_key?
provider_identity_namespace?
provider_subject_id?
operation_key?
usage_entry_id?
```

Les identifiants provider, clés d'opération et références de ledger restent
internes. La projection publique expose les identités Kurobara, les statuts et
une provenance expurgée, jamais le sujet provider.

Les champs source sont copiés sans réécrire leur `observed_at`. Seuls les
champs réellement produits par la capacité reçoivent une nouvelle observation.
La société, l'emploi et leur fraîcheur ne sont donc pas artificiellement
rafraîchis par une révélation d'identité ou un lookup d'email.

Un résultat certain sans valeur ne supprime pas la ligne. Il produit un record
1:1 avec un statut fermé `not_found`, une consommation exacte et aucune valeur
inventée. Une restriction privacy, une annulation, un échec terminal ou une
issue ambiguë ne rendent pas le dataset destination `ready`.

### Route technique et namespace d'identité

`effectAdapterKey` identifie le composant qui exécute l'effet courant.
`providerIdentityNamespace` qualifie l'origine et le format du sujet provider
relu dans la lineage. Ils sont validés séparément et ne sont pas requis égaux.

Une route annonce explicitement les namespaces qu'elle sait consommer. Le
worker refuse avant réseau un namespace non supporté. Le sujet provider ne vient
jamais du client, de la query publique ou d'un record projeté ; il est relu
depuis la lineage du même workspace.

En P0, Prospeo Enrich Person consomme un sujet du namespace
`prospeo-person-search`. Hunter Finder peut utiliser l'identité professionnelle
complète et le domaine comme route initiale explicitement priorisée. Le plan P0
n'autorise qu'une tentative provider : Finder n'est déclenché ni après une
indisponibilité, ni par un résultat Prospeo `NO_MATCH`/`not_found`. Hunter Verifier utilise l'email résolu par la
génération précédente. Aucun de ces inputs sensibles
n'est accepté directement depuis le client au moment de l'effet.

### Révélation d'identité

La génération d'identité accepte seulement un contact `obfuscated`. La réponse
Prospeo est réduite à prénom, nom, nom complet, profil professionnel et date
d'observation. L'emploi et l'entreprise viennent du record source.

Email personnel, téléphone et waterfalls restent désactivés ;
`enrich_mobile=false` est toujours imposé et toute coordonnée incidente est
supprimée à la frontière adapter. Enrich Person peut néanmoins facturer un email
retourné pendant l'identité. Un résultat
avec une identité incomplète ou une identité provider incohérente échoue fermé.

### Résolution et vérification de l'email professionnel

La résolution exige une identité `full` et un domaine d'entreprise. Prospeo
Enrich Person constitue le provider P0 ; Hunter Finder reste une route de
résolution alternative explicitement priorisable, pas un failover automatique
après une erreur ou un `not_found`. La sortie
allowlistée conserve l'email
professionnel, sa source, sa confiance éventuelle, son observation et le statut
de vérification retourné, sans convertir un score propriétaire en vérité
universelle.

Après la résolution, le client ou l'agent lit le record matérialisé :

- il peut conserver le dataset de résolution comme dataset final, notamment si
  le statut Prospeo répond déjà à son besoin ;
- il peut demander explicitement `contacts.work-email.verify@1.0.0` pour une
  sélection exacte ; chaque page admise déclenche alors au plus un effet Hunter
  Verifier si privacy, budget et deadline l'autorisent ;
- `valid`, `accept_all`, `unknown`, `invalid` et une preuve absente restent des
  statuts distincts ;
- un `not_found` certain reste distinct d'une panne ou d'une ambiguïté.

Le serveur ne possède aucune policy de skip ou de copie automatique fondée sur
la fraîcheur du statut du resolver. Même lorsqu'il observe `valid`, il ne crée
pas une génération de vérification implicite. Inversement, une génération de
vérification explicitement demandée n'est pas remplacée par une copie sans
effet.

Résolution et Verifier possèdent des routes, `operation_key`, réservations et
écritures de consommation distinctes. Prospeo documente un ré-enrichissement
gratuit pendant 90 jours, mais Kurobara ne garantit ni sa disponibilité ni sa
facturation ; son budget reste exprimé en `requests`, pas en crédits Prospeo
exacts. Une issue ambiguë interdit retry,
fallback et nouvelle dépense. Seule une réconciliation autoritative peut faire
évoluer cette page ; à défaut, la génération reste `ambiguous`.

### Privacy, autorité et budget

Avant de créer la génération, l'application vérifie sélection, permissions,
classes de données, purpose, territoire, tombstones, deadline et pire coût
admis. Elle fige les faits et l'enveloppe d'autorité dans le plan.

Le worker relit la policy et les tombstones au dernier point certain avant
chaque effet, après la quote et la réservation. Une restriction tardive ferme
l'effet et les étapes suivantes. Le workspace vient toujours de l'acteur
authentifié et du plan durable, jamais d'un argument libre du worker.

Le budget agrégé de la sélection est le budget de la `DatasetGeneration`. Les
réservations et règlements par page utilisent le ledger existant et référencent
ce même plan. Une page sautée sans effet ne réserve ni ne règle un coût provider.

### Contrats publics implémentés

REST, le SDK TypeScript et la CLI ne réimplémentent pas le workflow. Ils créent
une génération, retournent ses identités stables, utilisent le suivi générique
de `DatasetGeneration` et lisent le dataset terminal par les mêmes projections.

Les opérations `contacts.identity.reveal@1.0.0`,
`contacts.work-email.resolve@1.0.0` et
`contacts.work-email.verify@1.0.0` sont expérimentales et
`local-development-only`. Elles créent une `DatasetGeneration` et retournent
ses identités stables, son état et la preuve de replay. Le catalogue, OpenAPI,
les types, le SDK et la CLI sont régénérés ensemble. Aucune table ni aggregate
`ContactWorkEmailOperation` durable n'a été créé.

La révélation d'identité ajoute sa propre opération de création de génération.
La CLI peut proposer une commande de parcours complet, mais celle-ci reste une
composition cliente des trois opérations canoniques et du watch générique ;
elle ne possède aucun état métier caché.

Le dernier dataset `ready` est un dataset Contact normal. Il peut alimenter une
recette et est exportable exactement en CSV ou JSONL par la surface générique de
dataset, avec sélection de champs et ordre déterministe. Aucun export Contact
spécial ou join implicite au « dernier résultat » n'est créé. Le registre
durable de livraison, le TTL et les droits provider complets restent une gate de
release séparée.

## Security, privacy and agent authority

- un client sélectionne uniquement des IDs Kurobara de son workspace ;
- les sujets provider sont chargés depuis la lineage restreinte et ne sont ni
  retournés, ni exportés, ni loggés ;
- les payloads provider bruts ne sont pas persistés ;
- les adapters reconstruisent une sortie allowlistée et suppriment téléphone,
  email personnel et champs inconnus ;
- l'email professionnel reste une donnée confidentielle soumise aux permissions,
  TTL, tombstones et droits BYOK de l'opérateur ;
- l'autorité d'un agent est bornée par la sélection, le budget, la deadline, les
  permissions et les conditions d'arrêt du plan ;
- aucune sortie de modèle n'autorise une capacité ou une dépense ;
- une issue ambiguë stoppe la chaîne, sans retry aveugle ni fallback ;
- l'export consulte à nouveau privacy, rétention et droits provider avant de
  délivrer les octets.

## Data, operations and rollback

Les changements de stockage sont roll-forward et additifs. Les datasets source
restent immuables et lisibles si une génération dérivée échoue. Un dataset
destination partiel ne devient jamais `ready` et ne peut être ni recette source
ni exporté.

Une restauration doit préserver datasets, generations, pages, lineage, Runs,
Attempts, réservations, usage, tombstones et registre de livraison avant de
réactiver les workers Contact. Le readback de reprise vérifie la dernière page
certaine et interdit une seconde dépense lorsque l'issue précédente reste
ambiguë.

Avant toute génération dérivée, un rollback peut retirer les nouveaux contrats
et routes. Après une première génération, le rollback désactive les routes mais
conserve les tables communes et les preuves ; il ne supprime ni dataset, ni
lineage, ni écriture de coût.

## Alternatives

- **Muter le dataset Contact en place** : rejeté, car cela casse immutabilité,
  replay et audit de fraîcheur.
- **Utiliser une recette scalar-only pour l'identité complète** : rejeté, car
  l'identité est un bundle cohérent de champs et de lineage.
- **Créer un aggregate et un scheduler Contact** : rejeté, duplication du
  runtime `DatasetGeneration`.
- **Créer un ledger Contact séparé** : rejeté, deux vérités de coût seraient
  possibles pour le même effet.
- **Résoudre puis vérifier dans une seule page** : rejeté, deux effets et deux
  dépenses deviendraient indivisibles et plus difficiles à reprendre.
- **Retourner l'email directement dans la réponse de mutation** : rejeté, la
  requête longue ne fournirait ni reprise, ni readback durable, ni export exact.
- **Ajouter un waterfall automatique P0** : rejeté ; Hunter Finder reste une
  décision de route initiale explicite et bornée. Une génération actuelle ne
  bascule ni après indisponibilité ni après `not_found` ; toute policy de
  failover contrôlé exige un ticket séparé.

## Risks

- le coût annoncé par un adapter peut ne pas être un reçu provider ; la gate
  doit distinguer requêtes, crédits estimés et consommation confirmée ;
- un provider peut refuser l'endpoint malgré une clé présente ; la qualification
  live reste une preuve séparée ;
- copier des champs sans conserver leur observation d'origine fabriquerait une
  fausse fraîcheur ;
- une policy ou un tombstone mal composé rendrait les contrôles purement
  décoratifs ; le test doit vérifier le wiring API et worker ;
- une projection qui choisit implicitement le dernier dataset pourrait joindre
  des intentions différentes ; les IDs source et destination restent requis ;
- la transition des contrats email pré-release modifie leur fingerprint et doit
  être livrée atomiquement avec toutes les projections générées.

## Verification plan

La tranche n'est fermée qu'après les preuves suivantes :

1. une fixture synthétique produit une shortlist `obfuscated`, révèle au plus
   trois identités, résout leurs emails, puis un client fixture inspecte le
   statut et demande explicitement la vérification lorsque nécessaire ;
2. chaque génération conserve exactement la sélection et produit le même nombre
   de records, avec `source_dataset_id` et `source_record_id` relus dans
   PostgreSQL ;
3. un quatrième record non sélectionné ne crée ni page, ni Run, ni réservation,
   ni appel provider ;
4. replay et restart ne répètent aucune page certaine ni aucune dépense ;
5. une issue ambiguë stoppe toute la chaîne jusqu'à réconciliation ;
6. `not_found`, `invalid`, `accept_all`, `unknown` et `valid` restent distincts ;
7. aucun statut de résolution ne crée ou ne saute automatiquement une
   génération de vérification ; le choix du client est observable ;
8. un tombstone ou une expiration entre quote et effet ferme l'appel ;
9. un payload hostile contenant téléphone ou email personnel ne traverse pas
   l'adapter ;
10. REST, SDK TypeScript et CLI retournent les mêmes IDs, états, erreurs et
    résultats ;
11. le dataset final s'exporte en CSV et JSONL avec le même ordre, les mêmes
    valeurs, une provenance et des coûts réconciliables ;
12. la gate clone-propre passe d'abord avec fixtures, puis une qualification
    live privée et bornée confirme séparément les endpoints Prospeo et Hunter.

## Open questions

Aucune question ne bloque la décision P0. Le serveur ne définit pas de seuil de
fraîcheur pour décider d'une vérification à la place du client. Les unités
économiques viennent de snapshots de pricing versionnés ; elles ne sont pas
figées universellement par ce RFC.

## Decision

Accepted le 22 juillet 2026 par Leandre Desmaretz. Kurobara réutilisera
`DatasetGeneration` et son runtime durable pour les trois capacités Contact,
avec datasets dérivés immuables 1:1, lineage source exacte, privacy preflight et
JIT, arrêt sur ambiguïté, vérification explicitement choisie par le client,
parité REST/SDK/CLI et export générique du dataset final. Aucun second
orchestrateur, ledger Contact, provider secondaire ou surface UI/MCP/LLM
n'entre dans le P0.
