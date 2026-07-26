# RFC-0007 — Export direct d'une application de recette

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-19
- Supersedes: none
- Related ADRs: ADR-0005

## Summary

Ce RFC fixe `recipe-applications.export@1.0.0`, un téléchargement CSV ou JSONL
recalculé depuis l'application de recette et ses résultats durables exacts. Une
prévalidation complète établit la taille et le SHA-256 avant le succès HTTP ;
une nouvelle passe transmet ensuite les octets avec backpressure et vérifie la
même preuve. REST, le SDK TypeScript et `recipe export` consomment cette logique
sans bufferiser le fichier complet.

Ce téléchargement n'est pas le futur lifecycle d'export durable d'API-002. Il
ne crée ni `export_id`, ni artifact stocké, ni URL signée, ni rétention, ni
reprise par offset.

Depuis la migration interne `0026_export_delivery_registry.sql`, une fondation
séparée peut enregistrer un manifest audit-safe et les transitions
`prepared`, `delivered` et `revoked` autour de ce stream. Elle n'est pas
composée dans la route REST, le SDK ou la CLI de ce RFC : les sujets privacy
exacts et les droits provider doivent d'abord être dérivés côté serveur depuis
la lineage durable. Le download public décrit ici reste donc éphémère et ne
promet aucun registre de livraison.

## Problem

Le use case interne sait déjà projeter la recette exacte sur le dataset source,
mais aucun client HTTP ne peut récupérer ses octets. L'exposer directement sans
prévalidation autoriserait aussi un codec à échouer après les premiers chunks :
le serveur aurait alors déjà committé un `200` et ne pourrait plus retourner un
Problem Details cohérent.

Le catalogue suppose en outre que toute opération retourne du JSON. Encoder un
fichier en base64 ou lui inventer un schéma objet dupliquerait le contrat et
annulerait le bénéfice du streaming.

## Goals and non-goals

### Goals

- exposer la projection enrichie exacte, ordonnée et isolée par workspace ;
- accepter CSV et JSONL avec une sélection ordonnée optionnelle de champs ;
- borner les octets par record et par export dans la configuration serveur ;
- refuser avant les headers les états non exportables et erreurs d'encodage
  prévisibles ;
- transmettre taille et SHA-256 exacts, puis les revérifier côté client ;
- publier un fichier CLI seulement après EOF et preuve complète, sans écraser
  une destination existante ;
- étendre le compilateur canonique à une sortie binaire streamée.

### Non-goals

- créer ou persister un artifact, un manifest d'export ou une URL de download ;
- exposer reprise, range, rétention, pagination, SSE ou stockage objet ;
- inclure provenance, fraîcheur, confiance ou coût dans le fichier ;
- ajouter provider, MCP, UI, push, publication ou déploiement ;
- fermer API-002 ou ARTIFACT-001.

## Proposal

### Opération et requête

`recipe-applications.export@1.0.0` est une lecture à idempotence inhérente,
transportée par `POST /v1/recipe-application-exports`. Le body JSON fermé
contient `application_id`, `format` (`csv` ou `jsonl`) et éventuellement
`field_ids`, tableau unique non vide dont l'ordre est conservé. Le workspace
vient exclusivement de la clé API vérifiée.

Le transport POST évite de placer jusqu'à 256 identifiants dans une URL. Il ne
crée aucune ressource et peut être rejoué : le SDK n'ajoute toutefois aucun
retry automatique.

La permission dédiée est `recipes:export`. Elle autorise les valeurs enrichies,
contrairement à `recipes:read`, limité au snapshot counts-only. Les limites
`max_record_bytes` et `max_export_bytes` sont des politiques du serveur et ne
sont jamais contrôlées par la requête.

### Prévalidation et stream vérifié

L'application vérifie d'abord l'application, la recette exacte, l'import
terminé, les champs et chaque liaison `CellResult` succeeded. Elle effectue
ensuite un encodage complet à blanc, sans conserver les chunks, pour calculer
`content_length` et `content_sha256`. Une erreur codec ou un dépassement total
est donc refusé avant le `200`.

Le body HTTP consomme une nouvelle projection exacte. Chaque chunk est produit
à la demande ; la taille et le hash sont recalculés. Le dernier chunk non vide
reste en attente jusqu'à la preuve EOF. Un drift, une erreur codec inattendue ou
une preuve finale différente interrompt la connexion avant que le nombre
d'octets annoncé puisse être publié. Aucun JSON d'erreur n'est injecté au milieu
du fichier.

Les headers de succès sont :

- `Content-Type: text/csv; charset=utf-8` ou
  `application/x-ndjson` ;
- `Content-Length` exact ;
- `X-Kurobara-Content-SHA256: sha256:<hex>` ;
- `Content-Disposition` avec un filename statique par format ;
- `Cache-Control: private, no-store` ;
- `X-Content-Type-Options: nosniff`.

L'annulation du client ferme l'itérateur, donc le curseur PostgreSQL. Le use
case conserve seulement les preuves bornées par les cellules de l'application,
jamais le fichier complet.

### SDK et CLI

`recipeApplications.export(request, options)` valide la requête, les problèmes,
le media type et tous les headers contractuels. Il retourne un iterable binaire
one-shot et lazy. Le client impose aussi un maximum local, compte les octets,
recalcule le SHA-256, propage l'`AbortSignal` et refuse une fin différente de
`Content-Length` ou `X-Kurobara-Content-SHA256`.

`recipe export` exige un timeout, une limite locale et une destination fichier.
La commande écrit un temporaire privé dans le même répertoire, calcule le
SHA-256, ferme et synchronise le fichier, puis le publie sans écrasement. Un
échec, timeout, `SIGINT` ou `SIGTERM` supprime seulement ce temporaire. Un succès
écrit sur stdout un reçu JSON stable avec l'application, le format, le nombre
d'octets et le hash ; le fichier n'est jamais mélangé à stdout dans cette
tranche.

## Public contracts and compatibility

Le catalogue passe de `0.4.0` à `0.5.0`. Le compilateur impose désormais
exactement un `output_schema_id` JSON ou un `output_stream`. Un stream déclare
une propriété de format énumérée, un media type unique et une extension par
format ; OpenAPI produit des bodies `string/binary` marqués streamés. Une
projection MCP streamée reste obligatoirement différée.

L'opération, son schéma de requête et les problèmes
`recipe-application-export-unavailable@1.0.0` et
`export-too-large@1.0.0` sont additifs, expérimentaux et
`local-development-only`.

Les problèmes publics distinguent requête invalide, permission, absence
tenant-safe, état non exportable, dépassement, invariant de sortie et panne
interne. Les détails de codec, record, cellule, recette et PostgreSQL restent
expurgés.

## Security, privacy and agent authority

Le fichier est `confidential`. Un `application_id` absent ou d'un autre
workspace produit le même 404. Le serveur ne fait confiance ni au workspace,
ni aux limites, ni au type de sortie fournis par un client. La CLI ne reçoit
jamais la clé en argument direct et refuse d'écraser fichier, répertoire ou
symlink existant.

La commande est bornée par permission, taille, timeout et annulation. Elle ne
déclenche aucun provider, dépense, nouvelle recette, run ou mutation métier.
Son répertoire de destination reste une frontière de confiance contrôlée par le
processus appelant ; cette tranche ne prétend pas résister à un processus local
hostile capable d'en remplacer les entrées pendant la publication.

## Data, operations and rollback

PostgreSQL reste la source de vérité pour application, dataset, recette,
liaisons et résultats. Le download est éphémère et recalculé. Les limites sont
configurées au démarrage de l'API ; une configuration invalide bloque le
processus plutôt que d'affaiblir les bornes.

Un rollback retire route, client, commande et contrat sans migrer ni supprimer
de donnée. Les applications et résultats existants restent lisibles et
rejouables par les autres surfaces.

## Alternatives

- **GET avec champs répétés en query** : rejeté pour cette tranche ; la taille
  maximale du schéma dépendrait des limites d'URL du serveur intermédiaire.
- **JSON/base64** : rejeté car il bufferise, gonfle et décrit faussement le
  fichier comme une enveloppe objet.
- **Streamer sans prévalidation** : rejeté ; une erreur codec prévisible
  deviendrait une troncature après `200`.
- **Créer tout de suite un artifact durable** : différé à API-002 et
  ARTIFACT-001 ; stockage, rétention, URL signée et reprise sont un autre
  lifecycle.
- **Autoriser stdout ou overwrite en CLI** : différé pour garder une première
  publication locale atomique et non destructive.

## Risks

- la prévalidation ajoute une passe PostgreSQL et un encodage CPU ; elle évite
  en échange les échecs prévisibles après headers ;
- un drift exceptionnel entre prévalidation et stream ferme la connexion ; le
  SDK et la CLI le traitent comme un échec, jamais comme un fichier valide ;
- la preuve par cellule est bornée à 10 000 entrées, mais n'est pas O(1) ;
- un export volumineux consomme temporairement de l'espace disque côté CLI ;
- SDK et CLI restent privés et non distribués.

## Verification plan

1. générer le catalogue `0.5.0`, huit opérations, trente problèmes, OpenAPI,
   CLI et aucune projection MCP d'export ;
2. tester les schémas fermés, le descripteur de stream et les mutations
   invalides du compilateur ;
3. tester prévalidation, hash, taille, réitération, dépassement et drift dans
   l'application ;
4. tester auth, mapping des problèmes, headers, backpressure et annulation HTTP ;
5. tester media type, limites, troncature, drift SHA-256 et cancellation du SDK ;
6. tester publication atomique CLI, mode privé, destination intacte, timeout et
   nettoyage ;
7. exécuter le parcours réel PostgreSQL → API → SDK → processus CLI pour CSV et
   JSONL, sélection ordonnée, `null`, isolation et replay byte-identique ;
8. exécuter check, typecheck, tests, build, génération sans drift et
   `git diff --check` sous Node/npm qualifiés.

## Open questions

- la future surface artifact réutilisera-t-elle exactement ces formats ou un
  manifest signé supplémentaire ;
- quels seuils observés justifieront une reprise par offset ou un stockage objet.

## Decision

**Accepted le 2026-07-19.** Le decision owner retient un download direct
prévalidé et streamé, avec permission `recipes:export`, preuve longueur/SHA-256
et publication CLI atomique. Le futur export durable avec identité, stockage et
rétention reste séparé. Aucune objection non résolue ni nouvel ADR n'est requis ;
ADR-0005 est amendé avec cette quatrième surface headless.
