# RFC-0012 — Cycle de vie des exports de datasets Contact

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-23
- Supersedes: none
- Related ADRs: ADR-0005, ADR-0007

## Summary

Kurobara donne à chaque export d'un dataset Contact généré une identité durable,
un manifest audit-safe et une expiration effective. Le serveur dérive la source
de génération, les observations, la policy et les droits provider depuis sa
configuration et la lineage restreinte ; le caller public choisit seulement le
dataset, le format et, éventuellement, les champs.

Le manifest `2.0.0` référence la génération et son plan immuables, le hash et la
taille exacts du flux, les classes de données, les observations, la finalité, le
territoire, la version de policy et le snapshot des droits provider. Il ne
contient ni ligne exportée, ni valeur de contact, ni identifiant sujet provider.
Son expiration effective est la borne la plus restrictive entre policy, droits
provider et observations.

Une restriction Contact écrit d'abord un tombstone workspace-scoped, puis relie
dans la même transaction ses clés HMAC versionnées aux livraisons déjà
enregistrées et ajoute leurs événements de révocation. L'état public suit
l'ordre de priorité `revoked`, `expired`, `delivered`, `prepared`. La révocation
empêche une nouvelle livraison ou lecture dans Kurobara ; elle ne prétend pas
rappeler un CSV ou JSONL déjà reçu par un client.

## Current implementation reality

Avant cette décision, la révision locale possède déjà :

- le registre interne `export_deliveries` et ses événements append-only pour les
  exports d'application de recette ;
- un garde Contact fondé sur des tombstones HMAC-SHA-256 workspace-scoped ;
- un export générique CSV/JSONL qui consulte les tombstones avant et pendant le
  flux d'un dataset Contact ;
- une lineage restreinte qui relie chaque record Contact généré à son sujet
  provider exact et à ses instants d'observation.

La révision locale qui implémente ce RFC ajoute le manifest
`generated-dataset` `2.0.0`, l'expiration effective, les liens HMAC
sujet-livraison, les preuves de révocation et une policy d'export Contact
configurée localement. Les contrats expérimentaux de lecture et révocation d'une
livraison et d'enregistrement d'une restriction sont projetés par REST, SDK
TypeScript et CLI. Migration PostgreSQL, use cases, transports, concurrence et
restauration passent leurs checks locaux ensemble.

La révision locale ajoute
`KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON` aux process API et worker. Le
tableau contient de une à seize clés `{current, secret, version}`, une seule clé
courante et des versions antérieures retenues pour le readback. Les variables
legacy `KUROBARA_CONTACT_PRIVACY_HMAC_SECRET` et
`KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION` restent supportées, mais ne
peuvent pas être combinées au keyring. Un dump/restore avec une clé historique
et une clé courante relit tombstone, aliases, livraison révoquée et preuve sans
PII. Le retrait d'une ancienne clé et la répétition sur le candidat public exact
restent des gates de publication.

Les records et datasets Contact restent immuables. La révision de travail
révoque les livraisons, bloque les nouveaux exports correspondants et refuse les
lectures publiques Contact actuelles après restriction. Toute nouvelle surface
de lecture devra encore être vérifiée avant d'être exposée.

## Problem

Un export Contact est un nouvel effet de divulgation. Le simple fait de vérifier
un tombstone au début du stream ne suffit pas à répondre aux questions
suivantes :

- quelle génération et quel plan ont produit les valeurs ;
- quelles classes, observations, finalité et conditions provider ont autorisé
  la sortie ;
- jusqu'à quand la livraison pouvait être terminée ;
- quel acteur a reçu quel flux exact ;
- quelles livraisons sont concernées lorsqu'une restriction arrive plus tard ;
- comment refuser une completion après expiration ou révocation sans muter les
  preuves historiques.

Accepter ces informations dans le payload public permettrait au caller ou à un
agent de s'octroyer des droits, un TTL ou une provenance. Stocker les valeurs de
contact dans le registre recréerait une copie sensible. Supprimer les records
immutables casserait la provenance et l'audit sans garantir que le fichier déjà
téléchargé a disparu.

## Goals and non-goals

### Goals

- identifier chaque livraison Contact générée par une intention immuable ;
- dériver côté serveur source, observations, finalité, territoire, TTL, policy
  et droits provider ;
- faire échouer l'export entier si un record, une classe, une observation ou une
  autorisation ne peut pas être prouvé ;
- vérifier le hash et la longueur exacts avant l'événement `delivered` ;
- rendre lecture et révocation explicitement owner-only ;
- propager atomiquement une restriction exacte vers toutes les livraisons liées
  du workspace ;
- conserver tombstones, manifests, transitions et preuves sans PII brute ;
- masquer une valeur révoquée ou expirée de toute nouvelle lecture Kurobara sans
  réécrire l'historique immuable ;
- préserver l'export générique non-Contact lorsque la policy Contact est absente.

### Non-goals

- rappeler, effacer ou modifier une copie déjà reçue hors de Kurobara ;
- décider d'une base légale, d'un droit contractuel ou d'une autorisation de
  redistribution pour l'opérateur ;
- permettre au caller de fournir purpose, territoire, durée, observations,
  provenance ou droits provider ;
- ajouter téléphone, email personnel, outreach, MCP ou service hébergé ;
- rendre le registre ou les clés HMAC lisibles par un agent ;
- suivre les exports non-Contact dans cette tranche ;
- annoncer une release ou une API publique hébergée.

## Proposal

### Admission et fail-whole

Le serveur classe un dataset comme Contact seulement si sa matérialisation
`ready`, son schéma fermé, sa génération, son plan et sa lineage restreinte
forment une preuve cohérente dans le workspace authentifié. Une incohérence ne
le rétrograde jamais en export générique : elle refuse le flux entier.

Pour chaque record Contact matérialisé, le serveur exige au moins un sujet
provider exact, ajoute l'email exact lorsqu'il est présent, et retrouve les
instants d'observation des classes sélectionnées. Chaque champ doit appartenir à
la taxonomie Contact fermée. Une ligne orpheline, une observation absente, deux
providers dans le même export ou une classe inconnue refusent toute la
livraison ; aucune ligne partielle n'est rendue.

Un dataset sans lineage Contact reste exportable par le chemin générique
existant. Il ne reçoit ni `delivery_id`, ni faux snapshot de policy ou de droits.
L'absence de configuration Contact ne bloque donc pas les datasets ordinaires.

### Manifest généré côté serveur

Le manifest `2.0.0` conserve :

```text
workspace + owner
dataset + format + field IDs
content hash + content length
generation + generation plan + plan hash
capability ID + capability version
data classes + observed_at + expires_at
policy version + purpose + territory + policy expiry
provider-rights mode + version + expiry
```

Le `delivery_id` est dérivé de l'intention canonique qui couvre ce manifest. Le
replay de la même intention retrouve la même livraison ; une réutilisation
incompatible de sa clé idempotente échoue. Aucun champ du manifest ne révèle les
valeurs, sujets, digests HMAC, credentials ou payloads provider.

La policy locale est chargée par
`KUROBARA_CONTACT_EXPORT_POLICY_JSON`. Elle définit un purpose, un territoire,
une version, un TTL de snapshot, une rétention maximale par classe et un
snapshot de droits par provider. Ces faits restent une déclaration de
l'opérateur : Kurobara les borne et les conserve, mais ne les transforme pas en
validation juridique.

L'expiration effective est :

```text
min(
  policy_expires_at,
  provider_rights_expires_at,
  chaque observed_at + rétention de sa classe
)
```

La préparation et la completion sont interdites dès que `now >= expires_at`.

### Préparation, streaming et completion

L'encodage CSV ou JSONL est d'abord parcouru en entier sous les gardes privacy
afin d'établir une taille et un SHA-256 bornés. Le registre prépare ensuite la
livraison et relie toutes les clés sujet HMAC. Le second parcours émet le flux en
revérifiant restrictions, taille et hash. Seule la consommation réussie de la
fin du flux enregistre `delivered`.

Une restriction, une dérive de contenu, une erreur d'encodage, un abandon avant
la fin ou une expiration ne produit jamais une fausse completion. Un export
Contact est fail-whole au niveau de l'autorisation et de la preuve ; comme tout
stream réseau, un client peut néanmoins avoir reçu un préfixe avant une rupture
de connexion et doit traiter un fichier sans reçu final comme invalide.

Pour un export CLI suivi sur stdout, un reçu privé `prepared` contenant
seulement l'identité opaque, l'intégrité annoncée et l'expiration est synchronisé
avant le premier octet. Il reste récupérable si le flux ou le readback échoue.
Après EOF et confirmation `delivered`, la CLI le remplace atomiquement par le
reçu final. Le reçu provisoire identifie la livraison ; il ne prouve jamais sa
completion.

### États publics et autorité

Les surfaces de cycle de vie exposent seulement un reçu borné : identité de
livraison et de dataset, format, hash, longueur, dates et état. Elles n'exposent
ni owner, ni manifest interne, ni sujets ou digests.

La lecture et la révocation explicite cherchent la livraison par
`workspace_id + owner_actor_id + delivery_id` et exigent
`contacts:export`. Une livraison d'un autre owner retourne le même résultat
non-divulgant qu'une identité inconnue. La priorité de présentation est :

1. `revoked`, même si le TTL est aussi dépassé ;
2. `expired`, si aucune révocation n'existe et que la borne est atteinte ;
3. `delivered`, si la fin du flux exact a été vérifiée ;
4. `prepared`.

Les projections locales restent cohérentes :

- `dataset export` crée le flux et retourne son reçu de livraison lorsqu'il
  s'agit d'un dataset Contact ;
- `dataset export-status` lit le reçu owner-only ;
- `dataset export-revoke` ajoute une révocation owner-only ;
- `contact restrict` enregistre un tombstone exact avec une clé idempotente.

REST, SDK TypeScript et CLI partagent les mêmes opérations canoniques.
MCP reste différé.

### Restriction et propagation atomique

`contact restrict` accepte transitoirement un email exact ou un sujet provider
exact, une raison fermée et une clé d'idempotence. La valeur brute est
normalisée puis transformée en HMAC-SHA-256 versionné ; elle n'apparaît ni dans
la réponse, ni dans le registre, ni dans la preuve.

Sous une seule transaction PostgreSQL :

1. les identités de registration et de livraison sont verrouillées dans un
   ordre stable ;
2. le tombstone est inséré ou son replay exact est retrouvé ;
3. toutes les versions HMAC dérivées sont liées à ce tombstone ;
4. les livraisons du workspace qui partagent une de ces clés reçoivent un
   événement `revoked` idempotent ;
5. une preuve audit-safe est écrite pour chaque couple tombstone-livraison ;
6. les compteurs affectés et nouvellement révoqués sont lus avant commit.

L'ordre tombstone-first garantit qu'un échec de propagation annule toute la
transaction : il n'existe ni tombstone annoncé sans ses révocations, ni
révocation annoncée sans preuve. Les gardes pré-effet et pré-export consultent
ensuite le même tombstone durable.

### Immutabilité et masquage

La révocation ne modifie ni ne supprime les records, la lineage, les coûts ou
les manifests historiques. Les nouvelles surfaces de lecture doivent appliquer
un overlay workspace-scoped : une valeur liée à un sujet révoqué ou arrivée à
expiration est masquée ou la lecture entière est refusée selon son contrat.

Cet overlay doit couvrir exports, résultats Contact, sources d'enrichissement,
caches et projections avant publication. La migration du registre ne suffit pas
à prouver ce comportement ; chaque surface doit être testée avec une
restriction tardive, un restart et une restauration.

## Public contracts and compatibility

Les opérations `export-deliveries.get@1.0.0`,
`export-deliveries.revoke@1.0.0` et
`contact-privacy.restrict@1.0.0` sont ajoutées au catalogue expérimental
`local-development-only`. Elles n'annoncent aucune stabilité publique.

`datasets.export@1.0.0` conserve son payload de sélection. Un dataset Contact
peut ajouter des métadonnées de livraison au transport et au reçu CLI ; un
dataset non-Contact conserve le comportement générique sans registre. Le
workspace, l'owner, la policy, les droits, la provenance et l'idempotence de
livraison ne deviennent pas des entrées choisies par le client.

La migration préserve les manifests recette `1.0.0` existants et ajoute le type
discriminé `generated-dataset` `2.0.0`. Les anciens manifests ne sont pas
réécrits en v2 et ne reçoivent pas une provenance inventée.

## Security, privacy and agent authority

- le workspace et l'owner viennent exclusivement de la clé API vérifiée ;
- `contacts:privacy` autorise l'enregistrement d'une restriction exacte ;
- `contacts:export` autorise l'export Contact, sa lecture et sa révocation
  owner-only ; `datasets:export` reste requis pour le flux ;
- un agent ne fournit ni policy, ni droits, ni TTL, ni observation, ni
  attribution ou identifiant owner ;
- les erreurs de lecture/révocation ne distinguent pas livraison inconnue,
  autre workspace ou autre owner ;
- tombstones, liens et preuves n'enregistrent aucune valeur brute ;
- l'absence de policy, de provider, d'observation ou de clé HMAC requise échoue
  fermée pour Contact seulement ;
- un replay ou fallback ne peut pas réautoriser une livraison révoquée ;
- une révocation explicite de livraison ne remplace pas une demande sujet :
  seule la restriction sujet bloque aussi les futurs effets correspondants.

## Data, operations and rollback

La migration est roll-forward. Elle étend les livraisons existantes, backfill
leur expiration depuis leur manifest v1, puis restaure les gardes append-only.
Elle ajoute les liens sujet-livraison, les liens tombstone-sujet et les preuves
de révocation. Après la première écriture v2, un rollback qui retire ces tables
ou colonnes peut réautoriser une sortie et n'est pas acceptable.

Une sauvegarde cohérente doit contenir au minimum datasets, lineage restreinte,
tombstones, requêtes idempotentes, livraisons, liens sujet, événements et preuves
de révocation. Elle ne suffit pas sans les versions HMAC nécessaires, conservées
hors PostgreSQL. La restauration doit :

1. garder API et workers Contact arrêtés ;
2. restaurer PostgreSQL et le keyring correspondant ;
3. appliquer ou vérifier toutes les migrations ;
4. relire tombstones, livraisons expirées/révoquées et liens sujet ;
5. prouver qu'une nouvelle lecture ou livraison reste bloquée ;
6. seulement ensuite réactiver les effets Contact.

Le keyring de la révision locale accepte de une à seize versions uniques et
exactement une clé `current`. Une rotation ajoute d'abord la nouvelle clé,
conserve les anciennes avec `current=false`, puis déplace le marqueur courant.
Le retrait d'une ancienne version reste interdit sans migration et readback
prouvant qu'aucun tombstone ou lien actif n'en dépend. Perte de clé, restore
drill et readback après restart restent des gates explicites de publication.

## Alternatives

- **Accepter policy et droits dans le payload d'export** : rejeté ; un caller
  pourrait s'octroyer une finalité, un TTL ou des droits.
- **Tracer tous les exports génériques** : différé ; la tranche ferme le risque
  Contact sans imposer une policy fictive aux datasets ordinaires.
- **Livrer ligne par ligne en ignorant les sujets refusés** : rejeté ; le fichier
  deviendrait partiel et sa cardinalité/provenance ambiguë.
- **Supprimer physiquement les records révoqués** : rejeté ; cela casse
  immutabilité, coûts et audit sans effacer les copies externes.
- **Stocker les emails dans le registre** : rejeté ; cela crée une nouvelle copie
  de la donnée restreinte.
- **Révoquer seulement par `delivery_id`** : insuffisant ; une restriction sujet
  doit atteindre toutes les livraisons et tous les futurs effets liés.
- **Considérer `expired` avant `revoked`** : rejeté ; la preuve d'une restriction
  explicite ne doit pas être masquée par le passage du temps.

## Risks

- une clé HMAC perdue rend les tombstones historiques impossibles à rapprocher ;
- le JSON local atteste une policy opérateur, pas ses droits réels ;
- une réponse réseau interrompue peut avoir transmis un préfixe sans completion ;
- un client peut conserver ou redistribuer un fichier déjà livré malgré une
  révocation ultérieure ;
- une surface de lecture Contact oubliée peut réexposer un record immuable ;
- le double parcours d'encodage augmente le coût local et exige une borne stricte
  de taille ;
- la coexistence des manifests v1 et v2 exige des guards et parsers fermés.

## Verification plan

1. migrer une base contenant un manifest v1 et relire son état inchangé ;
2. préparer et compléter un export Contact v2 avec source, TTL, policy et droits
   dérivés côté serveur ;
3. refuser l'export entier pour lineage, classe, observation, provider, policy
   ou sujet incomplet ;
4. prouver que l'absence de `KUROBARA_CONTACT_EXPORT_POLICY_JSON` bloque Contact
   mais pas un dataset générique ;
5. vérifier replay exact, conflit, isolation workspace et owner-only ;
6. tester `revoked > expired > delivered > prepared` aux bornes temporelles ;
7. enregistrer une restriction après livraison et prouver, dans une seule
   transaction, tombstone, liens, événement et preuve sans PII ;
8. tester la course entre preparation, completion, révocation et expiration ;
9. scanner tables, erreurs, logs, fixtures et reçus pour les sujets synthétiques ;
10. tester REST, SDK TypeScript et les quatre commandes CLI sur PostgreSQL réel ;
11. vérifier qu'une restriction tardive masque toute nouvelle lecture Contact ;
12. exécuter restart et restore drill avec toutes les versions HMAC requises.

## Open questions

- La procédure de retrait d'une version HMAC ancienne reste à qualifier par une
  migration et un readback des dépendances.
- Toute future lecture Contact devra choisir et tester son overlay sans casser
  l'immutabilité des records historiques.
- Les droits réels de conservation et de redistribution restent une
  responsabilité opérateur et un gate juridique de publication.

## Decision

Le 23 juillet 2026, le decision owner accepte le registre de livraison v2 pour
les datasets Contact générés, la dérivation serveur de la source, de la policy,
des droits et des TTL, le refus fail-whole, et la priorité publique
`revoked > expired > delivered > prepared`.

Il accepte aussi `GET` et révocation owner-only, ainsi qu'une restriction sujet
atomique qui écrit le tombstone avant de propager ses clés HMAC vers toutes les
livraisons liées. Les records historiques restent immuables et doivent être
masqués des nouvelles lectures. Aucune promesse n'est faite de rappeler un
fichier déjà reçu. Les exports non-Contact restent disponibles sans delivery
tracking.

L'acceptation et la qualification locale ne valent pas publication. Le retrait
des anciennes clés, la répétition clean-room du restore, les droits provider et
les gates supply-chain/GitHub/release restent obligatoires avant de présenter
cette verticale comme publiable.
