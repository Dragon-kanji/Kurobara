# RFC-0004 — Tranches de transport headless

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-19
- Supersedes: none
- Related ADRs: ADR-0004, ADR-0005

## Summary

Ce RFC propose de figer seulement la première tranche de transport headless
locale et expérimentale : l'import streaming d'un dataset via la même opération
canonique pour REST, le SDK TypeScript et la CLI non interactive.

L'opération `datasets.import@1.0.0` est projetée en
`POST /v1/dataset-imports` et en commande `dataset import`. REST reçoit un
multipart avec une partie JSON `metadata` et une partie binaire streaming
`source`, puis retourne un résultat JSON borné. La projection MCP reste
explicitement différée : cette tranche ne doit pas annoncer un tool exécutable.

## Problem

Les codecs et le use case d'import existants consomment un flux borné sans
charger le dataset complet en mémoire. Le compilateur de contrats ne projette
pour l'instant que des corps JSON ou des paramètres GET. Encoder le fichier en
base64, utiliser un parseur multipart qui matérialise tout le corps ou recopier
`Dataset` et `Field` dans un nouveau schéma affaiblirait les garanties déjà
prouvées.

Les autres besoins de `KRB-CLIAPI-001` ne possèdent pas encore les mêmes
prérequis : l'application de recette fan-out vers plusieurs `Run`, le suivi
exige une projection publique durable et SSE, et l'export durable dépend du
cycle d'artifacts. Les inclure dans ce premier changement rendrait son contrat
ambigu et sa vérification non bornée.

## Goals and non-goals

### Goals

- définir une seule identité `datasets.import@1.0.0` ;
- réutiliser les schémas canoniques `Dataset@1.0.0` et `Field@1.0.0` par leurs
  `$id` exacts ;
- conserver le flux source hors du document JSON sans en perdre le hash,
  le format ou les limites ;
- rendre succès et problèmes déterministes pour REST et la CLI ;
- ne générer aucun tool MCP tant que cette surface P1 n'est pas implémentée ;
- rester local, expérimental, sans provider, publication ou déploiement.

### Non-goals

- composer ou suivre l'application agrégée d'une recette ;
- définir SSE, `Last-Event-ID`, rétention ou heartbeat ;
- créer un export durable, une URL signée ou un cycle d'artifact ;
- publier, stabiliser ou garantir HTTP, SDK, CLI ou MCP avant la gate de release ;
- publier le namespace `.invalid` ou annoncer une API supportée.

## Proposal

### Opération canonique

`datasets.import@1.0.0` référence :

- `DatasetsImportRequest@1.0.0` pour les métadonnées ;
- `DatasetsImportResponse@1.0.0` pour le résultat JSON ;
- la permission `datasets:import` ;
- une idempotence requise portée par `import_id` et l'intention exacte ;
- les problèmes communs d'authentification, validation, disponibilité et
  contrat, plus les trois problèmes propres à l'import.

La même combinaison `workspace`, `import_id`, définition, version de codec,
format, limites et `source_content_hash` peut être rejouée. Une divergence
retourne `dataset-import-conflict`. Le serveur recalcule le SHA-256 des octets
bruts ; une différence retourne `dataset-source-mismatch` après suppression
transactionnelle des lots provisoires. Une erreur terminale du document ou
d'un record retourne `dataset-import-failed` sans exposer la ligne source.

### Projection REST

`POST /v1/dataset-imports` consomme `multipart/form-data` avec exactement :

- `metadata`, `application/json`, validé par `DatasetsImportRequest` ;
- `source`, `text/csv` ou `application/x-ndjson`, traité comme flux d'octets.

Le parseur HTTP doit préserver la backpressure et les limites réelles. Il
ne peut pas utiliser une API qui matérialise implicitement tout le multipart.
Le succès retourne `200 application/json` avec compteurs durables et
`replayed`. Le premier succès et son replay utilisent le même statut afin que
l'idempotence ne crée pas deux formes de résultat.

### Projection CLI

La commande est `dataset import`. Sa projection générée expose la même
identité d'opération, les mêmes schémas et les mêmes problèmes. Le wrapper
lit les métadonnées et le fichier séparément, envoie le flux sans base64 et
écrit le résultat JSON stable.

Les codes de sortie générés sont : `0` succès, `2` requête ou transport
invalide, `3` authentification ou autorisation, `4` ressource absente, `5`
conflit, `6` rejet métier ou de données, `70` erreur interne et `75`
indisponibilité temporaire. Le message humain n'est pas une API.

### Projection MCP

L'entrée MCP porte `availability: deferred` avec une raison publique. Le
compilateur conserve l'opération dans le catalogue, mais ne produit aucun tool
`import_dataset`. Un futur RFC ou ticket MCP réutilisera l'opération sans
présenter cette tranche API/CLI comme déjà exécutable via MCP.

## Public contracts and compatibility

Tous les nouveaux documents utilisent le namespace réservé
`schemas.kurobara.invalid`, le statut `local-development-only` et une version
initiale `1.0.0`. Ils ne modifient aucune opération existante. Le catalogue
local reçoit un nouvel ensemble de membres et un nouveau fingerprint.

La résolution des `$ref` externes reste locale au catalogue : aucune requête
réseau n'est permise et toute cible absente bloque la compilation. OpenAPI et
TypeScript projettent ces références depuis le même registre au lieu de copier
la structure des primitives produit.

Après publication, changer le chemin, les noms de parties, les media types,
l'idempotence, l'autorité ou la sémantique des problèmes exigera une nouvelle
version d'opération ou une preuve de compatibilité conforme à RFC-0001.

## Security, privacy and agent authority

Le workspace reste dérivé de la clé API vérifiée et doit correspondre aux
identités contenues dans `Dataset` et `Field`. Le fichier source n'apparaît ni
dans un problème, ni dans un log contractuel, ni dans une fixture. Les limites
de record, lot et source sont appliquées à la frontière réelle ; les métadonnées
du client ne s'accordent aucune autorité.

L'import ne déclenche pas de provider et ne consomme aucun budget économique.
Ses bornes de ressource sont `max_record_bytes`, `batch_limits` et la limite de
transport configurée. Une deadline de run ne s'applique pas à cette opération
de données locale ; le client peut utiliser un timeout de transport sans le
confondre avec une autorité durable.

## Data, operations and rollback

Le multipart ne devient pas un stockage. La source traverse l'adapter HTTP vers
le use case streaming existant. `source_content_hash` lie les octets complets à
l'intention et l'import initial d'un dataset reste unique et immuable.

Tant que ces contrats restent locaux et expérimentaux, le rollback peut retirer
la surface entrante, mais doit préserver la lecture des imports déjà persistés.
Retirer ou modifier l'opération exige ensuite le processus RFC applicable et
une régénération cohérente du catalogue.

## Alternatives

- **Base64 dans JSON** : rejeté, car il augmente la taille et matérialise le
  fichier au lieu de préserver le streaming.
- **Dupliquer `Dataset` et `Field`** : rejeté, car cela crée une seconde source
  de vérité.
- **Deux opérations metadata/upload dès maintenant** : rejeté après qualification
  de `@fastify/busboy@3.2.0` avec backpressure et nettoyage sur déconnexion.
- **Ajouter apply, SSE et export dans la même tranche** : rejeté pour cette
  décision ;
  leurs décisions d'agrégation, de rétention et d'artifact restent ouvertes.

## Risks

- OpenAPI décrit un multipart ; la preuve de backpressure reste portée par les
  tests de l'adapter et doit être rejouée pour chaque changement de parseur.
- SDK et CLI sont encore des packages privés de développement local, pas des
  artifacts distribués ou supportés.
- Le schéma vérifie les bornes locales ; les cohérences workspace/dataset/champs
  et `max_bytes >= max_record_bytes` restent des invariants applicatifs.

## Verification plan

1. résoudre les `$ref` externes sans réseau et refuser une cible inconnue ;
2. valider les fixtures positives et négatives des deux schémas ;
3. générer OpenAPI multipart, types TypeScript, métadonnées CLI et manifests ;
4. vérifier que MCP ne contient pas `import_dataset` ;
5. vérifier l'alignement des problèmes et codes de sortie ;
6. rejouer génération, drift, tests et typecheck sous Node/npm qualifiés ;
7. prouver streaming, replay, conflit, hash divergent, expurgation et isolation
   workspace dans l'adapter puis sur PostgreSQL réel ;
8. exécuter la CLI non interactive contre l'API loopback et vérifier le readback
   durable.

## Open questions

- à quel moment la projection MCP P1 rendra l'import de fichiers ergonomique.

## Decision

**Accepted le 2026-07-19.** Le decision owner retient l'opération locale
`datasets.import@1.0.0`, le multipart strictement ordonné `metadata` puis
`source`, la limite self-host configurable à 1 Gio par défaut, le SDK partagé et
la CLI JSON non interactive. L'acceptation reste conditionnée au statut
`local-development-only`, à l'absence de provider, cloud et publication, ainsi
qu'aux preuves de streaming, d'idempotence, d'isolation et d'expurgation du plan
de vérification. MCP, apply agrégé, SSE et export durable restent des décisions
et livraisons séparées.
