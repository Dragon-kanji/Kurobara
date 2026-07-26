# RFC-0002 - Plugin SDK, sidecar et input durable des runs

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre
- Implementation owner: unassigned
- Created: 2026-07-19
- Supersedes: none
- Related ADRs: ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0006

## Summary

Ce RFC propose la frontière d'extension qui doit précéder le premier provider
Kurobara. Il définit un manifest et un SDK de plugin versionnés, un contrat de
sidecar JSON-RPC 2.0 réservé au harness et au mode développeur non fiable, ainsi
qu'un input de run durable que l'application peut fournir à un adapter sans
placer son contenu dans le kernel.

La proposition conserve le runtime existant : PostgreSQL reste la vérité
métier, l'application possède autorité, budget et transitions, et un adapter ne
peut ni accorder un droit, ni décider seul d'un retry ou d'une dépense. Le
sidecar et son manifest ne constituent pas une sandbox. Aucun plugin tiers ne
devient installable en production tant qu'une isolation et un contrôle d'egress
réels ne sont pas qualifiés.

Ce RFC a été accepté le 2026-07-20 comme décision staged. Il autorise la
stabilisation locale des contrats provider-neutral, du SDK fonctionnel, du
profil sidecar et de leur harness ; il ne déclare aucune interface plugin
publiée ou supportée. La révision qui précédait cette décision contenait une
tranche préparatoire : un schéma de
manifest marqué `local-development-only`, ses types générés, le package privé
`@kurobara/plugin-sdk` et son validateur de manifest, ainsi que des ports et un
helper d'input JSON borné, un record PostgreSQL immuable lié au plan, puis sa
projection optionnelle jusqu'au `LeafEffectRequest` mono-step. Cette tranche ne
possédait aucun ingress public et restait exercée par l'effet
`deterministic-local`.

Le package SDK était alors limité au manifest : aucun `SecretsPort`, protocole sidecar
JSON-RPC, host runtime, harness de conformité réseau, adapter provider ou appel
réseau n'était implémenté. Un catalogue applicatif séparé pouvait figer les
routes déjà admises par la composition root et refusait un plan public sans
route exacte ; il n'implémentait aucune des interfaces plugin proposées par ce
RFC. Aucun provider réel n'était choisi, composé ou appelé.

La première tranche d'implémentation reste plus étroite que le RFC complet. La
révision courante ajoute les contrats fonctionnels et l'enveloppe
`PluginProtocolMessage` à la source canonique, génère leurs types, complète le
SDK provider-neutral et ajoute la frame canonique `PluginSidecarJsonRpcFrame`.
Le host local process-per-call et une installation offline par tarballs
qualifient un adapter réellement externe au workspace, sans réseau. Une seconde
sous-tranche ajoute désormais le schéma canonique de rapport, un kit privé, une
matrice exacte `darwin/arm64`, une sonde d'effet temporaire et le wrapper du
template. L'enforcement d'egress, les adapters défectueux couvrant chaque
classe, les secrets et le premier provider appartiennent toujours aux tranches
suivantes.

## Problem

Au moment de la proposition, la fondation possédait déjà les primitives de reprise nécessaires à un
effet externe : `operation_key` stable, réservation, tentative durable, issue
ambiguë, lookup et règlement atomique. Elle ne possédait toutefois pas encore la
frontière fonctionnelle d'un provider :

- le contrat HTTP de `plans.quote` transporte seulement un
  `normalizedInputHash`, sans valeur normalisée ou référence d'upload. Une
  tranche locale peut désormais valider et attacher au plan un
  `ValidatedRunInput` inline, mais aucune route publique ne l'ingère encore ;
- `LeafEffectPort` peut recevoir cet input validé de façon optionnelle sur un
  workflow mono-step, mais pas encore la capability exacte, une deadline
  d'appel, une configuration, une référence de credential ou une policy
  d'egress exécutable ;
- un premier schéma fermé de manifest et un package SDK privé existaient en
  statut `local-development-only`, sans méthodes fonctionnelles provider,
  `SecretsPort`, contrat sidecar, host runtime ou kit de conformité réseau ;
- le lookup courant distingue `found`, `not-found` et `outcome-unknown`, mais
  l'application traite prudemment tout `not-found` post-effet comme une
  observation non concluante ;
- le worker accepte seulement l'adapter synthétique local et ne qualifie ni
  timeout provider, ni egress, ni réponse hostile, ni facture BYOK ;
- une sortie JSON locale validée peut terminer un run, mais ce précurseur inline
  ne remplace ni stockage objet, ni provenance provider, ni rétention d'une
  réponse brute protégée.

Créer directement un adapter HTTP maintenu par Kurobara contre ces seules primitives
figerait des choix implicites sur l'input, les secrets, l'egress, la
compatibilité et la réconciliation. Ces choix modifient une frontière publique
et des garanties de sécurité ; ils doivent donc être décidés avant le premier
provider.

## Goals and non-goals

### Goals

- définir une identité et une compatibilité de plugin vérifiables avant son
  chargement ou tout accès réseau ;
- permettre à un adapter externe de compiler contre un SDK sans importer le
  kernel, l'application, PostgreSQL ou Hatchet ;
- fournir au provider un input validé, immuable et tenant-scoped sans déplacer
  son payload dans le domaine pur ;
- borner secrets, egress, deadline, taille, coût et autorité à chaque appel ;
- rendre idempotence, issue inconnue, lookup et règlement mesurables par un
  conformance kit ;
- conserver provenance et output normalisé sans exposer payloads bruts ou
  credentials dans les événements, erreurs, logs ou rapports ;
- permettre un rollback qui désactive l'adapter sans perdre l'état durable ni
  relancer un effet externe.

### Non-goals

- choisir ou implémenter le premier provider BYOK ;
- publier une marketplace ou autoriser l'installation communautaire en
  production ;
- prétendre qu'un manifest ou un test de conformité sandboxe du code arbitraire ;
- garantir exactement une exécution sur une API externe ;
- définir le stockage objet, les URLs signées ou la restauration complète des
  artifacts ;
- définir le routing adaptatif ou le fallback entre providers ;
- introduire une dépendance obligatoire au service managé ;
- envoyer une clé réelle ou archiver une fixture propriétaire dans le dépôt.

## Proposal

### 1. Source canonique et manifest de plugin

Le schéma du manifest réside déjà dans le catalogue canonique de
`packages/contracts` et son type `PluginManifest` est produit par la chaîne de
génération existante. Les futurs schémas des appels SDK, des réponses JSON-RPC
et du rapport de conformité devront rejoindre cette même source ; une copie
manuelle dans un adapter ne sera pas une source alternative.

La fondation locale ferme les champs, fixe `apiVersion` à
`dev.kurobara.plugin/v1` et décrit identité, capabilities avec contrats exacts,
auth, idempotence, lookup, timeouts, économie et hosts d'egress TLS. Son statut
de publication `local-development-only` signifie qu'elle n'est ni une API
plugin supportée, ni une permission runtime. Le validateur du SDK ajoute des
contrôles sémantiques sur les doublons, l'ambiguïté d'auth, les destinations
locales dangereuses et le contrat de reprise.

Le contrat de reprise expose aussi le profil one-shot fermé
`idempotency.mode=none` + `lookup.mode=none` avec
`authoritativeNotFound=false`. Ces trois valeurs forment une seule variante :
aucun mélange avec `native-key`, `lookup-only`, `by-operation-key`,
`by-external-operation-id` ou une absence autoritative n'est accepté. Cette
déclaration rend l'absence de preuve explicite ; elle ne crée ni idempotence ni
réconciliation locale fictive.

Un manifest fermé décrit au minimum :

- `apiVersion`, identité et version du package ou sidecar ;
- versions du SDK et du protocole compatibles ;
- capabilities exactes et leurs versions ;
- `ContractRef` d'input, d'output, de configuration et d'erreur ;
- schémas d'auth déclarés sans valeur de secret ;
- modes d'idempotence, de lookup, de retry et de timeout ;
- garantie économique, unité, version de pricing et méthode d'estimation ;
- classes de données, régions et règles de rétention déclarées ;
- permissions requises, dont destinations réseau par scheme, host, port,
  méthodes et chemins ;
- fonctionnalités optionnelles négociables et limites quantitatives.

Le manifest est canonicalisé et empreinté. La version et le fingerprint admis
sont figés dans la configuration ou le snapshot de route avant un run. Un champ
de contrôle inconnu, une version incompatible, un doublon d'identité, une
capability hors contrat ou une permission non admise provoquent un refus avant
le démarrage du sidecar, la résolution d'un secret ou l'ouverture d'une socket.

Déclarer une capability ou une permission ne l'accorde jamais. L'autorité du
run, la policy serveur et la configuration opérateur restent prépondérantes et
ne peuvent qu'intersecter ou réduire ce que le manifest demande.

### 2. SDK fonctionnel

Le package privé `@kurobara/plugin-sdk` expose désormais la frontière
fonctionnelle provider. Il dépend seulement de `@kurobara/contracts` et du
validateur JSON Schema Ajv ; les tests d'architecture autorisent cette direction
SDK -> contrats et refusent les imports vers kernel, ports, application,
adapters ou worker. Il valide les messages protocolaires sans les muter,
applique les corrélations sémantiques connues avant effet et retourne des
snapshots clonés et deep-frozen. Ses erreurs restent fermées et expurgées, sans
diagnostic Ajv, payload provider ou valeur sensible.

La tranche locale expose les huit méthodes du contrat canonique :

- `describe` pour relire l'identité et les capabilities du manifest ;
- `validateConfig` pour valider une configuration déjà expurgée ;
- `estimate` pour retourner garantie, borne, unité, version de pricing et
  expiration sans appel facturable caché ;
- `execute` pour envoyer une opération autorisée avec son identité stable ;
- `lookup` pour réconcilier cette même opération sans la réexécuter ;
- `normalize` pour convertir une réponse non fiable vers l'output canonique ;
- `health` pour produire un fait borné destiné au routing, sans décision métier ;
- `classifyError` pour mapper un diagnostic provider vers des classes Kurobara
  fermées et expurgées.

Après invocation de `execute` ou `lookup`, une exception, une réponse hostile
ou une corrélation invalide devient `outcome-unknown` avec une erreur
`adapter-fault` expurgée ; elle n'est jamais présentée comme un échec certain.
Pour un manifest one-shot, la méthode `lookup` reste présente dans la surface
protocolaire fixe mais le wrapper SDK n'invoque pas son implémentation et
retourne exclusivement `outcome-unknown`.
En mode `by-external-operation-id`, la tranche locale exige la référence en
entrée et n'accepte `found` que pour un succès qui réénonce exactement cette
référence. Le contrat courant interdit cette référence sur un outcome final
`failed` : ce cas reste donc volontairement `outcome-unknown` plutôt que d'être
attribué sans preuve.

Le code runtime actuel du SDK ne lit ni environnement, ni disque, ni réseau. Un
adapter déterministe prouve la surface et les invariants sans être composé dans
l'API ou le worker. Le SDK, l'adapter exemple et le host produisent des tarballs
compilés ; une fixture extérieure au workspace les installe offline et exerce
les huit méthodes via le sidecar. Aucun package n'est publié et aucun plugin
tiers n'est importé dans le processus worker de confiance.

### 3. Sidecar JSON-RPC 2.0

Le profil retenu utilise JSON-RPC 2.0 sur `stdio`, en UTF-8 sans BOM, avec un
document JSON compact par ligne terminée par LF. Les sauts de ligne contenus
dans une valeur JSON sont échappés et ne créent pas de nouvelle frame.

Les contrats fonctionnels utilisent une enveloppe canonique fermée
`PluginProtocolMessage` avec les seules clés `apiVersion`, `direction`, `method`
et `payload`. `apiVersion` vaut `dev.kurobara.plugin-protocol/v1`. Cette
enveloppe n'est pas à elle seule une frame JSON-RPC. Le host local mappe :

- une requête vers `{ "jsonrpc": "2.0", "id": ..., "method":
  "plugin.<method>", "params": <PluginProtocolMessage request> }` ;
- une réponse vers `{ "jsonrpc": "2.0", "id": ..., "result":
  <PluginProtocolMessage result> }`.

L'`id` JSON-RPC reste une corrélation technique et ne remplace jamais
`operation_key`. Le host vérifie la cohérence entre la méthode externe
`plugin.<method>`, `direction` et `method` dans l'enveloppe interne. La V1
autorise un seul appel en vol par sidecar et n'ajoute ni notification ni méthode
d'annulation au protocole. Le host impose la deadline, ferme l'entrée puis
termine le processus de façon bornée ; un arrêt ou un timeout pendant `execute`
produit `outcome-unknown`, sauf preuve déterministe que l'effet n'a pas commencé.

Dans ce framing, le host local impose :

- version JSON-RPC exacte, clés dupliquées refusées, IDs non ambigus et allowlist
  de méthodes ;
- validation canonique des params et résultats ;
- limites de taille, profondeur, nombre de messages et travail concurrent ;
- timeout par appel inférieur à la deadline métier restante, avec deadline et
  quote revérifiées après spawn avant tout envoi ;
- stdout réservé au protocole et stderr borné puis expurgé ;
- environnement, répertoire de travail et descripteurs hérités minimaux ;
- arrêt borné, kill après dépassement et état de santé explicite ;
- aucune transmission du token Hatchet, de l'URL PostgreSQL ou d'un credential
  sans rapport avec l'opération exacte.

La terminaison ou le timeout du sidecar pendant `execute` produit une issue
inconnue sauf preuve déterministe que l'appel externe n'a pas commencé. Le host
ne transforme jamais un crash en échec certain pour autoriser un retry.

Le mode V1 tiers reste `harness` ou `development-untrusted`. L'activation
production d'un sidecar communautaire est refusée tant qu'une sandbox, une
allowlist réseau effectivement appliquée et des permissions observables ne sont
pas qualifiées sur la topologie de référence.

### 4. Input durable hors du kernel

La tranche préparatoire locale définit `ValidatedRunInput` et
`InputContractValidatorPort`. Le helper applicatif refuse les formes JSON
hostiles, limite l'input inline à 65 536 octets canoniques, le valide contre la
`ContractRef` exacte via les registrations JSON Schema existantes, puis
recalcule le hash déclaré par le plan. La persistence optionnelle crée un enfant
PostgreSQL immuable `run_plan_inputs`, tenant-scoped et lié au plan par son hash.
Le chargement d'exécution revalide workspace, plan, contrat et hash avant de
projeter la preuve et sa valeur vers le `LeafEffectRequest` d'un workflow
mono-step. Les tests ajoutés couvrent le helper, le parsing hostile, la
persistence et la projection ; ils ne constituent pas un ingress ou un test
provider.

Lorsque l'ingress public correspondant sera implémenté, sa première version
fera évoluer `plans.quote` pour accepter uniquement un input normalisé inline,
borné à 65 536 octets canoniques. Une référence d'upload et son lifecycle objet
sont différés à `API-002` et `ARTIFACT-001`.
L'adapter HTTP le valide contre la `ContractRef` d'input exacte avant mapping.
L'application canonicalise la valeur, recalcule son hash et demande sa
persistence par un port tenant-scoped. Aucun de ces chemins publics n'est
encore câblé.

Le registre durable d'input conserve au minimum : workspace, contrat exact,
hash, taille, classification, état de finalisation, rétention, timestamps et
référence de contenu. Le payload vit dans PostgreSQL pour une petite fixture ou
derrière le futur port de stockage objet ; il ne vit ni dans `Run`, ni dans les
événements du kernel, ni dans une commande Hatchet.

`RunPlan` continue de porter la `ContractRef` et le hash immuables. La décision
confirme que l'input réside dans un record applicatif tenant-scoped lié au plan,
sans ajouter son payload au kernel. Le futur
bridge provider devra résoudre l'input, revalider identité, workspace, contrat,
hash et état finalisé, puis construire la demande SDK.

Les mappings de l'input racine et des outputs de prédécesseurs vers chaque step
doivent devenir explicites et versionnés. La première implémentation ne doit pas
inventer une agrégation multi-sink ou un mapping implicite pour accélérer le
provider de référence.

### 5. Secrets et credentials BYOK

Un `SecretsPort` applicatif futur stockera ou résoudra des credentials par
référence tenant-scoped. Manifest, plan, événements, snapshots de routing et
rapport de conformité ne contiennent jamais la valeur brute.

Avant résolution, l'application vérifie workspace, acteur, permission,
capability, provider, version de configuration, deadline et révocation. Le
credential résolu est limité à l'appel et au provider exact. Le mode de remise
au sidecar — secret éphémère, broker HTTP hôte ou autre canal — est explicitement
différé à `AUTH-001`, `SECURITY-001` et à un RFC d'amendement. Jusqu'à cette
décision et ses preuves, le harness sidecar utilise uniquement une
authentification `none` avec des fixtures synthétiques. Aucun credential n'est
transmis au sidecar.

Rotation et révocation empêchent les nouveaux effets. Elles n'effacent ni une
dépense déjà observée, ni la provenance, et ne changent pas l'identité d'une
opération ambiguë en cours de lookup.

### 6. Egress borné

Le manifest déclare les destinations nécessaires et la configuration opérateur
les réduit. Une requête sortante utilise une URL construite depuis une base
validée ; un payload ou une réponse provider ne peut pas choisir librement une
destination.

Le transport refuse par défaut userinfo, fragment, scheme non admis, port
inattendu, redirection, changement d'origine et résolution vers une plage non
autorisée. Méthode, chemin, headers, taille de requête, taille de réponse
décompressée et timeouts de connexion, headers et body sont bornés. Les erreurs
de parsing ou de transport retournent des reason codes fermés sans recopier URL,
headers, body ou secret.

La validation applicative d'un hostname ne protège pas seule contre DNS
rebinding, proxy, configuration système ou code malveillant. Le conformance kit
mesure le comportement d'un adapter coopératif ; seule une sandbox ou un broker
d'egress contrôlé par le host peut devenir une frontière de sécurité pour du
code tiers. La fixture initiale utilise uniquement une origine loopback exacte
et vérifie qu'un serveur leurre non admis ne reçoit aucune requête.

### 7. Idempotence, timeout et lookup

`operation_key` reste l'identité métier transmise comme idempotency key lorsque
le provider le supporte. Une redelivery technique de la même tentative conserve
`attempt_id` et `operation_key`. Un retry métier crée un nouvel `attempt_id` mais
conserve l'`operation_key`, conformément au runtime durable existant.

L'adapter valide la forme transport de la clé avant réseau et transmet
exactement la valeur autorisée. Il n'utilise à sa place ni `run_id`, ni
`attempt_id`, ni l'identifiant JSON-RPC. L'absence de support provider est une
capability économique et de fiabilité visible ; elle ne doit pas être masquée
par une clé locale sans effet externe.

Avec le profil one-shot `none/none`, le runtime ne redélivre `execute` qu'une
seule fois. Dès que l'envoi a pu commencer, toute issue incertaine interdit
automatiquement retry et fallback vers un autre provider : une seconde route
pourrait créer un second effet ou un second coût sans moyen de réconciliation.
Le fallback reste autorisé uniquement après un rejet certain avant effet, par
exemple validation ou admission refusée avant tout envoi. Cette preuve
pré-effet doit être portée par le runtime ; une simple exception transport,
deadline ou absence de réponse ne suffit jamais.

`execute` retourne seulement : succès certain, échec certain ou
`outcome-unknown`. Timeout, reset, réponse tronquée, JSON hostile, crash après
envoi ou erreur dont l'étape d'envoi n'est pas prouvée produisent
`outcome-unknown`. L'application conserve alors la réservation et interdit une
nouvelle dépense liée. Lorsque le provider a déjà révélé une référence
d'opération externe sûre, l'outcome ambigu la conserve pour permettre un
`lookup` par cette identité sans réexécuter l'effet.

`lookup` doit distinguer :

- `found`, lié à la même opération avec preuve et outcome final ;
- `eventual-not-found`, observation non concluante qui maintient l'ambiguïté ;
- `authoritative-absent`, preuve que l'effet n'existe pas et peut être libéré ;
- `outcome-unknown`, lookup indisponible, invalide ou non attribuable.

Le port courant ne possède pas encore cette distinction complète : son
`not-found` post-effet reste ambigu. Toute évolution doit être versionnée et
migrée sans réinterpréter silencieusement des preuves historiques. La stabilité,
la portée et la durée de validité d'une preuve d'absence autoritative restent à
définir par capability/provider.

### 8. Coût et règlement

`estimate` ne facture pas silencieusement. Il retourne une quote `hard`,
`estimated` ou `unknown`, son unité, la version de pricing, l'expiration et une
borne éventuelle. Une garantie `hard` exige une borne exécutable admise avant le
claim.

`execute` reçoit le snapshot exact de cette quote avec la limite de coût
autorisée. Le SDK refuse une unité divergente ou une borne supérieure à la
limite ; le host local refuse aussi une quote expirée avant invocation.
L'adapter ne peut donc pas substituer
silencieusement une autre version de pricing entre estimation et effet.

Après effet, l'adapter retourne un règlement lié à l'opération et, lorsqu'il
existe, à un receipt provider protégé. Montant, unité et `usage_entry_id` sont
validés avant persistence. Un montant supérieur à la réservation n'est jamais
tronqué ou présenté comme conforme : il bloque la conclusion automatique,
conserve les preuves connues et exige une procédure opérateur qui sera définie
par `RELIABILITY-001`.

Un échec provider peut être facturable ; sa classe d'erreur ne décide donc pas
du règlement. À l'inverse, une libération n'est admise qu'avec une preuve
d'absence d'effet ou de non-facturation compatible avec le contrat de
réconciliation. Le coût observé avec une clé BYOK ne prétend pas remplacer la
facture du provider.

### 9. Normalisation, schémas et provenance

Une réponse provider est une entrée hostile. L'adapter borne et parse la
réponse, `normalize` produit une valeur canonique, puis l'application valide
cette valeur contre la `ContractRef` d'output exacte. Une réussite provider dont
la sortie normalisée viole le contrat règle le coût réellement observé mais
termine la tentative en échec ; elle ne produit pas un succès ou un artifact
inventé. Une réponse impossible à attribuer ou à parser reste ambiguë si l'effet
a pu avoir lieu.

La provenance normalisée doit pouvoir référencer :

- adapter, version, capability et manifest fingerprint ;
- provider, opération externe protégée et mode d'idempotence ;
- timestamps d'observation, fraîcheur et confiance lorsque la capability les
  définit ;
- contrats et version du normalizer ;
- quote, pricing, montant, unité et preuve de règlement ;
- artifact protégé de réponse brute lorsque rétention et droits le permettent.

Les événements et rapports publics utilisent des références et champs sûrs.
Credentials, payloads bruts, URLs sensibles, headers, identifiants tenant et
diagnostics provider ne sont pas copiés dans la télémétrie par défaut.

### 10. Compatibilité

Version produit, version du catalogue, schéma, capability, API plugin, SDK,
sidecar, package provider et configuration évoluent séparément. Le host possède
une matrice explicite des versions d'API plugin supportées et refuse une version
incompatible avant spawn ou réseau.

Les champs de contrôle et outcomes sont fermés. Une nouvelle méthode, un nouvel
outcome de contrôle, une modification du sens de `not-found`, une permission
plus large ou une garantie économique différente exige une version compatible
explicitement prouvée ou une nouvelle version majeure. Une annotation additive
facultative peut rester compatible si anciens host et plugin peuvent l'ignorer
sans changer autorité, coût, sécurité ou résultat.

Le conformance report versionné contient au minimum versions et fingerprints
testés, IDs de garanties, statut `passed|failed|not-applicable`, evidence refs
expurgées et résumé déterministe. Il n'accorde pas une compatibilité générale à
une autre version, configuration ou plateforme que celles réellement testées.

La première implémentation suit cette règle avec
`PluginConformanceReport@1.0.0` et le profil
`dev.kurobara.plugin-conformance/local-v1@1.1.0`. Sa matrice ne contient que
Node `24.14.0` sur `darwin/arm64` ; elle n'étend donc aucune garantie à Linux ou
à un runtime de production. Le rapport initial reste un self-test : le harness
fournit l'identité de l'artifact, les vecteurs et la sonde. La preuve de
packaging suivie calcule le fingerprint de sa tarball, mais le rapport n'est ni
signé, ni une attestation autonome de provenance ou d'identité du harness.

### 11. Composition et confiance

Le worker reste la seule composition root qui connaît simultanément application
et adapters concrets. Une registry explicite expose uniquement les adapter keys
effectivement composées au scheduler de routing.

Les adapters TypeScript maintenus par Kurobara peuvent être intégrés au worker après revue,
conformance et configuration explicite. Le sidecar de référence et le serveur
loopback résident dans les fixtures du conformance kit ; ils ne sont ni exportés
comme adapter maintenu par Kurobara, ni sélectionnables par la configuration de production.
La fixture process-per-call actuelle prouve seulement le framing et le
packaging ; elle ne remplace pas ce serveur provider de conformité.

Le premier harness peut utiliser un entrypoint de test dédié qui réemploie les
ports et `composeWorker`. Il ne doit pas ajouter un mode caché à `apps/worker`,
une fallback demo silencieuse ou une route provider dans un plan de production.

## Public contracts and compatibility

Le catalogue local attribue au manifest, à `PluginProtocolMessage`, à
`PluginSidecarJsonRpcFrame` et à `PluginConformanceReport` des `$id` versionnés,
génère leurs types et les marque explicitement `local-development-only` ; cette
preuve ne crée donc pas une version publique supportée. Le contrat d'appels, le
framing sidecar, le host local et un rapport déterministe sont présents et
reproductibles. Le harness réseau et la politique complète de compatibilité
restent différés. Toute nouvelle source canonique devra respecter
`CONTRACT-001`, la preuve du namespace et la génération reproductible.

Le SDK et le sidecar projettent les mêmes schémas et outcomes. JSON-RPC ne crée
pas une seconde sémantique d'erreur. Un adapter in-process et un sidecar qui
annoncent le même profil passent les mêmes suites de contrat.

Un changement du framing retenu, de l'autorité ou de la sémantique fermée des
outcomes exige un RFC qui amende ou remplace explicitement cette décision. Les
choix différés de remise des secrets, d'enforcement d'egress et d'admission
provider devront être décidés par leurs tickets et RFC dédiés avant toute
activation correspondante ; ils ne sont pas figés implicitement par ce RFC.

## Security, privacy and agent authority

- le manifest décrit une demande ; il n'accorde aucune permission ;
- l'application revalide workspace, acteur, capability, budget, deadline,
  révocation et conditions d'arrêt avant chaque effet ;
- le sidecar ne reçoit ni accès PostgreSQL, ni token Hatchet, ni secret global ;
- l'input et les artifacts sont scoped au workspace, classifiés et soumis à une
  rétention explicite ;
- un résultat provider, une description de capability ou une erreur restent des
  données non fiables et ne peuvent élargir l'autorité ;
- `classifyError` reçoit uniquement un diagnostic fermé et déjà expurgé : type
  de signal, statut HTTP, code provider borné ou délai de retry. Message, URL,
  header, body, stack et credential ne traversent pas le contrat partagé ;
- une issue ambiguë bloque retry et fallback payants jusqu'à réconciliation ;
- l'allowlist déclarative et le label de conformité ne remplacent ni sandbox,
  ni enforcement réseau ;
- un secret canary doit rester absent de tout outcome, log, stack, rapport et
  artifact non protégé.

Le threat model final, les rôles de déploiement, la sandbox, l'egress broker, la
rotation, la rétention et l'observabilité restent des gates distinctes de
`SECURITY-001`, `AUTH-001`, `DEPLOY-001`, `ARTIFACT-001` et `OBS-001`.

## Data, operations and rollback

Les futures migrations d'input et de provenance sont additives et
tenant-scoped. Elles ne réécrivent ni `RunPlan`, ni tentative, ni settlement ou
manifest historique. Un backfill ne fabrique jamais le payload d'un ancien hash
ou la preuve provider d'un effet local.

Le feature path reste désactivé par défaut. Un rollback :

1. empêche les nouveaux plans de sélectionner l'adapter concerné ;
2. draine ou réconcilie les opérations déjà envoyées avec la même version ;
3. conserve plugin version, manifest, input, réservation, provenance et preuves
   nécessaires à la lecture ;
4. retire le sidecar du runtime sans supprimer les records durables ;
5. ne relance et ne compense jamais automatiquement un effet externe déjà
   possible.

Une version de plugin requise pour un lookup historique doit rester disponible
ou disposer d'un migrateur explicitement qualifié. Si elle devient
indisponible, l'opération reste ambiguë et nécessite intervention ; elle ne
devient pas un échec certain par convenance de rollback.

Le conformance kit initial est local, sans credentials et sans provider réel.
La sous-tranche actuelle n'ouvre aucune socket : elle utilise le sidecar
process-per-call sur stdin/stdout, des fixtures synthétiques et un journal
d'effet temporaire supprimé après le test. Les futurs serveurs leurres devront
écouter uniquement sur loopback, fermer sockets et processus après test et ne
modifier aucun état partagé.

## Alternatives

### Premier adapter HTTP avant le SDK

Non retenu par la proposition. Il transformerait les besoins d'un seul provider
en contrat implicite et contournerait l'ordre `PLUGIN-001` -> `PLUGIN-002` ->
`PROVIDER-001` du backlog.

### Importer du code communautaire dans le worker

Rejeté pour la V1. La conformité ne protège pas le processus, les secrets ou le
réseau contre du code arbitraire.

### Conserver uniquement le hash fourni par le client

Insuffisant pour un provider. Le worker ne peut ni recalculer l'origine, ni
retrouver une valeur à exécuter, ni prouver son contrat et sa rétention.

### Placer l'input brut dans le kernel ou les événements

Rejeté. Le domaine pur n'a pas à porter payload, classification, chiffrement ou
cycle objet, et les événements ne doivent pas devenir un canal de fuite.

### Faire confiance à l'adapter pour son propre egress

Insuffisant pour un plugin tiers. L'enforcement appartient au host, au broker ou
à la sandbox de déploiement ; un manifest reste déclaratif.

### Sidecar HTTP au lieu de `stdio`

Option non retenue pour la V1. Elle ne peut être rouverte que par un RFC
d'amendement qui justifie bind réseau, authentification locale, ports, TLS et
exposition SSRF dans les environnements où `stdio` serait difficile à opérer.

## Risks

- un RFC trop large peut retarder le premier parcours provider ; la livraison
  doit être découpée en contrats/SDK, conformance, bridge runtime puis provider ;
- la séparation input, host et sidecar ajoute des mappings et des preuves de
  compatibilité ;
- une lookup API provider peut être eventual-consistent et rendre l'absence
  autoritative impossible ;
- une sandbox portable et un egress broker sont coûteux ; leur absence doit
  maintenir le runtime tiers désactivé plutôt que produire une garantie fictive ;
- un provider peut facturer un échec, modifier sa tarification ou retourner une
  facture supérieure à la borne estimée ;
- conserver une version d'adapter pour la réconciliation historique augmente la
  charge opérationnelle et supply-chain ;
- la réponse brute peut être nécessaire à l'audit tout en étant interdite de
  redistribution ou soumise à rétention courte ;
- le rapport de conformité peut lui-même fuiter URLs, fixtures ou secrets sans
  schéma fermé et tests canary.

## Verification plan

La tranche `PLUGIN-001` qualifie le sous-ensemble local des quatre premiers
axes : contrats et framing générés sans drift, SDK sans I/O ou import interne,
adapter externe compilé contre des tarballs, admission avant spawn et host
borné. `PLUGIN-002A` ajoute le schéma de rapport, son validateur et sa
sérialisation déterministe, une matrice d'une combinaison, neuf IDs de garantie,
la sonde d'effet par `operation_key` et le wrapper du template. Ces preuves ne
qualifient ni adapters défectueux pour chaque classe, conformance réseau, egress
appliqué, secrets, provider, CI Linux ou production.

Le RFC ne sera considéré implémenté qu'après preuves séparées :

1. génération reproductible des schémas manifest, appels et rapport, sans drift ;
2. package SDK compilable par un adapter exemple externe sans import interne ;
3. version incompatible, manifest hostile et permissions élargies refusés avant
   spawn, secret ou réseau ;
4. sidecar JSON-RPC borné sur framing, méthodes, taille, concurrence, timeout,
   crash, stderr et shutdown ;
5. serveur provider loopback et serveur leurre prouvant l'egress exact, les
   redirects refusées et l'absence de contact interdit ;
6. transmission exacte de l'`operation_key` ; selon le manifest, redelivery
   sans second effet et lookup attribuable, ou un seul `execute` one-shot suivi
   exclusivement d'un lookup `outcome-unknown` sans effet ;
7. blackholes connexion/headers/body, resets et réponses perdues transformés en
   ambiguïté avec abort réel du transport ;
8. montant négatif, unité incohérente, receipt instable et dépassement de borne
   refusés sans troncature ou double mouvement de ledger ;
9. réponses trop grandes, profondes, malformées, redirigées ou hors schéma
   rejetées sans crash ni payload inventé ;
10. canary de secret absent des outcomes, erreurs, logs, preuves et rapports ;
11. crash avant envoi, après acceptation, après réponse, pendant normalisation,
    après lookup et avant règlement repris sans second appel ou second coût ;
12. input durable relu avec workspace, `ContractRef`, hash et état exacts, et
    refusé avant effet en cas de drift ;
13. tests PostgreSQL/Hatchet réels du bridge après disponibilité de l'input et
    des ports, sans composer la fixture comme provider de production ;
14. adapters volontairement défectueux faisant échouer chaque classe de
    garantie dans un rapport machine-readable expurgé ;
15. inventaire de dépendances/licences, SBOM et inspection des artifacts exacts.

Le harness initial privilégie Node 24 (`node:http`, `node:net`, `node:test` et
`child_process`) et les validateurs déjà épinglés. Une nouvelle bibliothèque de
transport, parsing, JSON-RPC ou versioning exige une justification, un pin, une
revue de licence et une mise à jour du SBOM ; sa commodité ne doit pas devenir
une garantie de sandbox ou d'egress.

## Deferred gates

Aucune question restante ne change la frontière acceptée. Les décisions
suivantes restent volontairement hors de son périmètre et doivent être closes
avant d'activer la capacité correspondante :

1. `API-002` et `ARTIFACT-001` décideront le lifecycle d'upload et de stockage
   objet au-delà de l'input inline V1 ;
2. `AUTH-001`, `SECURITY-001` et un RFC d'amendement décideront le `SecretsPort`,
   la remise des credentials et leur rotation ;
3. `SECURITY-001` et `DEPLOY-001` qualifieront la sandbox, l'enforcement d'egress
   portable et les plateformes de production admissibles ;
4. `RELIABILITY-001` et chaque contrat provider définiront la preuve et la durée
   d'une absence autoritative, ainsi que le traitement d'un coût observé
   supérieur à la réservation ;
5. chaque contrat de capability séparera les métadonnées communes de provenance
   de ses champs propres de source, fraîcheur et confiance ;
6. la politique d'upgrade et rollback fixera les versions d'adapter conservées
   pour les lookups historiques ;
7. `PROVIDER-001` choisira un provider seulement après revue de ses APIs,
   conditions, rétention, cache, marques et droits sur les fixtures ;
8. `POLICY-001` et `PROVIDER-002` décideront le routing adaptatif et le fallback.

## Decision

**Accepted le 2026-07-20 par Leandre, decision owner.**

La V1 retient une frontière provider-neutral dont les contrats canoniques
alimentent le SDK TypeScript et le profil sidecar. Le SDK reste indépendant du
kernel, de l'application, de PostgreSQL, de Hatchet et des adapters concrets.

La décision fixe :

1. un input V1 inline, JSON et borné à 65 536 octets canoniques ;
2. sa persistence dans un record applicatif tenant-scoped lié au `RunPlan`,
   sans payload dans le kernel ;
3. les opérations `describe`, `validateConfig`, `estimate`, `execute`, `lookup`,
   `normalize`, `health` et `classifyError` ;
4. `operation_key` comme identité stable de l'effet et l'interdiction de
   réexécuter depuis `lookup` ;
5. les outcomes fermés de réconciliation `found`, `eventual-not-found`,
   `authoritative-absent` et `outcome-unknown` ;
6. l'enveloppe canonique fermée `PluginProtocolMessage`, avec `apiVersion`
   `dev.kurobara.plugin-protocol/v1`, `direction`, `method` et `payload` ;
7. son mapping futur dans `params` ou `result` d'une frame JSON-RPC 2.0 sur
   `stdio`, en UTF-8 sans BOM, avec un document JSON compact par ligne LF et un
   seul appel en vol ;
8. l'absence de méthode d'annulation V1 : le host impose la deadline et termine
   le sidecar de façon bornée, avec `outcome-unknown` après arrêt pendant
   `execute` sauf preuve certaine que l'effet n'a pas commencé ;
9. l'exécution des sidecars tiers uniquement dans le harness ou un mode
   développeur explicitement non fiable ;
10. le transport de la quote exacte et de la limite de coût vers `execute`, la
    conservation optionnelle d'une référence externe sur une issue ambiguë et
    l'interdiction de diagnostics provider bruts dans `classifyError`.

Cette acceptation autorise une implémentation staged des contrats, du SDK et du
harness. Elle ne prouve pas cette implémentation, ne publie aucun package ou
endpoint et n'autorise ni provider réel, credential, permission réseau,
installation runtime tierce ou sidecar communautaire en production. Les gates
différées ci-dessus restent obligatoires avant ces capacités.
