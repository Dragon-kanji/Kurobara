# Politique opératoire des données de contact

- Statut : **verticale Contact et lifecycle d'export qualifiés localement**
- Tickets : `KRB-PRIVACY-001`, `KRB-PRIVACY-002`, `KRB-PRIVACY-003`
- Périmètre : V1 locale, self-hosted, BYOK et owner-only
- Hors périmètre : conseil juridique, choix d'une base légale, outreach,
  rappel d'un fichier déjà reçu, suppression cross-workspace et service hébergé

Ce document décrit la policy pure livrée dans `@kurobara/policy-engine`, le
registre PostgreSQL append-only de tombstones et le registre de
livraison/révocation des exports Contact qualifié localement. La shortlist
Contact est désormais composée :
l'API exige la permission `contacts:discover`, un parent Entreprises `ready` et
des caps stricts, puis le worker exécute Prospeo Search Person avec une clé BYOK
locale. Les records publics n'exposent ni email, ni téléphone, ni identifiant
provider ; la shortlist est marquée `identity_completeness=obfuscated` et le
`person_id` reste dans la lineage restreinte.

Prospeo Enrich Person est composé pour l'identité et l'email professionnel des
seuls records sélectionnés ; `enrich_mobile=false` est imposé. Le garde
tombstone est relu avant les effets sélectionnés et avant puis pendant leur
export. L'implémentation locale ajoute un manifest `generated-dataset` `2.0.0`,
une expiration effective et la propagation atomique d'une restriction sujet
vers les livraisons liées. REST, SDK TypeScript et CLI exposent le reçu, sa
lecture owner-only, sa révocation et la restriction exacte. Le keyring
multi-version et un dump/restore PostgreSQL avec ancienne et nouvelle clés sont
testés. Le retrait d'une ancienne clé, les futures surfaces Contact et le droit
réel de redistribution provider restent des gates de publication.

L'adapter PDL reste un candidat offline secondaire hors du registre actif.
Hunter Domain Search reste refusé pour la shortlist car il révèle des
coordonnées avant sélection. Dans ce modèle open source self-hosted, l'opérateur
fournit sa clé et demeure responsable des conditions du provider et de son usage
des données.

## Invariants

1. Une classe de donnée absente du snapshot est interdite.
2. `personal-email` et `phone` exigent en plus une activation explicite dans les
   faits évalués ; une règle présente ne suffit pas.
3. Une finalité ou un territoire absent, vide, inconnu ou hors allowlist refuse
   l'action avant tout effet externe.
4. Une restriction privacy refuse l'effet demandé et tout fallback destiné au
   même résultat. Elle ne devient jamais un simple `no-result`.
5. Chaque classe autorisée possède une rétention positive et bornée. Il
   n'existe aucun TTL universel implicite.
6. Un export exige un instant d'observation et ne peut pas étendre la durée de
   vie de la donnée.
7. La contrainte la plus restrictive entre snapshot, opérateur et provider
   est précomposée par le serveur depuis sa configuration et la lineage
   restreinte. Le caller public ne choisit ni purpose, ni territoire, ni TTL ou
   droit provider. L'évaluateur pur ne lit ni contrat ni configuration provider.
   Une condition inconnue bloque le runtime Contact ; BYOK ne confère aucun
   droit supplémentaire.
8. Kurobara n'envoie aucun message et `purposeRef` ne constitue ni une base
   légale, ni une validation juridique.
9. Un export Contact est fail-whole : un record, sujet, provider, champ ou
   instant d'observation non prouvé refuse le fichier entier.
10. `revoked` prévaut sur `expired`, qui prévaut sur `delivered`, qui prévaut
    sur `prepared`.

## Classification

| Classe de policy | Contenu minimal | Défaut | Export | Logs, fixtures et rapports |
| --- | --- | --- | --- | --- |
| `contact-identity` | identité nécessaire pour relier un profil professionnel à une entreprise | refusée si absente du snapshot | seulement si l'action `export` est autorisée et la donnée valide | jamais la valeur |
| `employment` | entreprise, poste, rôle, département, séniorité et pays de la personne | refusée si absente du snapshot | purpose-, territory-, TTL- et provider-gated | jamais la valeur |
| `professional-social-profile` | URL ou handle professionnel minimal, sans contenu scrapé | refusée si absente du snapshot | explicite seulement | jamais la valeur |
| `professional-email` | email professionnel et statut de vérification | révélation séparée de la shortlist | owner-only, TTL et droits provider | jamais la valeur |
| `personal-email` | email non professionnel ou de nature incertaine | refusée par défaut et opt-in explicite | refusée par défaut | jamais |
| `phone` | fixe professionnel, mobile ou type incertain | refusée par défaut et opt-in explicite | refusée par défaut | jamais |
| métadonnée provider restreinte | provider ID, cursor, receipt et request ID | interne seulement | jamais telle quelle | identifiant Kurobara opaque seulement |
| payload provider brut | body entrant ou sortant | rétention zéro par défaut | jamais | jamais |
| tombstone privacy | clé opaque, portée, raison et preuve sans PII | interne restreint | jamais | jamais |

Un téléphone de type incertain suit la classe `phone`. Une entreprise
individuelle ou une personne enregistrée dans un registre ne devient pas une
donnée non personnelle par défaut.

## Snapshot et décision pure

`evaluateContactPrivacy(policy, facts)` n'effectue aucune I/O. Le snapshot
versionné fournit :

- les `purposeRefs` autorisées ;
- les territoires autorisés, distincts du siège employeur et d'une juridiction
  légale ;
- une expiration absolue du snapshot ;
- pour chaque classe admise, les actions `discover`, `enrich` ou `export` et un
  `maxRetentionMilliseconds` positif.

Les faits fournissent l'action, la finalité, le territoire de la personne, les
classes demandées, les activations explicites, les restrictions actives et
l'heure courante. Un export fournit aussi `observedAt` pour chaque classe.

La décision retourne la version de policy, les classes refusées, les limites de
rétention, des reason codes fermés et deux gardes explicites :
`stopExternalEffects` et `stopFallback`. Toute décision refusée positionne les
deux gardes à `true`.

Les reason codes privacy sont distincts d'une absence ou d'une panne provider :

- signaux : `provider-opt-out`, `provider-deletion`,
  `provider-claimed-email`, `operator-subject-request`, `privacy-tombstone`,
  `territory-restriction` ;
- policy : `policy-expired`, `purpose-unresolved`, `purpose-denied`,
  `territory-unresolved`, `territory-denied` ;
- données : `data-class-missing`, `data-class-unknown`,
  `data-class-duplicate`, `data-class-disabled`,
  `explicit-opt-in-required`, `action-denied` ;
- restrictions : `restriction-unknown` refuse un signal runtime absent de la
  taxonomie au lieu de l'ignorer ;
- rétention : `retention-limit-invalid`, `observation-time-missing`,
  `observation-time-invalid`, `ttl-expired`.

La policy traite les reason codes dans un ordre canonique. Elle n'accepte aucune
valeur de contact ou identité de sujet : ses décisions et ses tests restent
expurgés par construction.

## TTL et export

Le TTL effectif d'une valeur observée est le minimum entre :

1. `observedAt + maxRetentionMilliseconds` pour sa classe ;
2. l'expiration absolue du snapshot ;
3. la borne de droits provider dérivée par le serveur depuis la policy locale.

Une durée nulle, négative, non entière sûre ou produisant un dépassement est
refusée. `now >= expiresAt` produit `ttl-expired`. Pour `discover` et `enrich`,
la décision fournit la durée maximale et l'expiration absolue du snapshot ; le
consumer doit recalculer la borne effective dès que `observedAt` existe. Pour
`export`, l'absence de `observedAt` échoue fermée.

L'implémentation locale relit côté serveur la génération, son plan, la capability,
les sujets et les observations exacts. La configuration
`KUROBARA_CONTACT_EXPORT_POLICY_JSON` fournit purpose, territoire, version,
durée de policy, rétention par classe et droits par provider. L'expiration de la
livraison est la plus petite des bornes obtenues. Son absence, un provider non
déclaré ou une observation incomplète bloque uniquement l'export Contact ; un
dataset générique reste exportable sans registre de livraison.

Le flux est prévalidé en entier pour établir longueur et SHA-256, puis rejoué
sous le même garde. La completion `delivered` n'est enregistrée qu'après la fin
exacte. Pour stdout, la CLI conserve avant le premier octet un reçu de
récupération `prepared`, puis le remplace par `delivered` après readback. Un
client doit considérer invalide tout fichier interrompu ou dont le reçu reste
`prepared`. `expired` empêche une nouvelle completion ; une révocation
explicite reste visible même après expiration.

La policy pure ne supprime pas une donnée expirée. Les records historiques
restent immuables ; l'overlay est qualifié sur les lectures publiques Contact
actuelles et l'export. Toute nouvelle surface devra fournir la même preuve avant
d'être exposée. Le
[RFC-0012](../rfcs/0012-contact-export-delivery-lifecycle.md) sépare ce masquage
de la fausse promesse d'effacer un CSV déjà reçu.

## Runbook DSR et restriction

Le contrat expérimental local `contact-privacy.restrict@1.0.0` et la commande
`contact restrict` matérialisent ce runbook dans la révision locale. Leur
qualification locale ne constitue pas encore une publication :

1. l'opérateur vérifie la demande et l'enregistre avec une clé idempotente ;
2. le système écrit d'abord un tombstone workspace-scoped sans donnée brute ;
3. toute découverte, retry, fallback, refresh ou export consulte ce tombstone
   avant un nouvel effet ;
4. dans la même transaction, chaque clé sujet HMAC est reliée aux livraisons
   correspondantes et chaque livraison reçoit un événement `revoked` idempotent ;
5. les records et résultats immuables ne sont pas réécrits ; toutes les
   nouvelles lectures doivent appliquer l'overlay de restriction ;
6. coûts et preuves minimales restent auditables sans conserver la valeur ;
7. un résultat idempotent compte les livraisons affectées et nouvellement
   révoquées sans PII ;
8. chaque export durable concerné conserve une preuve de révocation ;
9. l'opérateur reste responsable des copies sorties de Kurobara ;
10. replay et nouvelles surfaces sont testés après traitement ;
11. une restauration relit les tombstones avant de rendre les données
    lisibles.

Un hash simple d'email ou de téléphone n'est pas un tombstone acceptable : il
est attaquable par dictionnaire. Le registre courant utilise HMAC-SHA-256 avec
une version de clé explicite et ne persiste jamais la valeur brute. La révision
de travail charge dans l'API et le worker soit :

- `KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON`, un tableau fermé de une à
  seize entrées `{current, secret, version}`, avec versions uniques et
  exactement une clé courante ;
- le couple legacy `KUROBARA_CONTACT_PRIVACY_HMAC_SECRET` et
  `KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION`.

Les deux modes ne peuvent pas être combinés. Une rotation ajoute la nouvelle
clé `current=true` et conserve les anciennes avec `current=false`, afin que les
tombstones historiques restent retrouvables. Un backup/restore doit rétablir
toutes les versions encore nécessaires avant de démarrer API ou workers
Contact. Retirer une ancienne clé sans migration et readback prouvés peut rendre
invisibles d'anciens tombstones. Le nom ou le domaine seuls ne suffisent jamais
à fusionner ou supprimer globalement des personnes.

## Matrice de redaction

| Surface | Autorisé | Interdit |
| --- | --- | --- |
| Records et API | valeur expressément autorisée, non expirée et non révoquée | payload brut, valeur hors policy, identifiant provider exposé |
| CSV et JSONL | projection owner-only conforme au snapshot et aux droits provider, avec reçu de livraison opaque pour Contact | téléphone ou email personnel par défaut, cursor, receipt provider, request ID |
| Logs, traces et erreurs | reason code, compteurs et identifiants Kurobara bornés | nom, email, téléphone, URL sociale, query, payload, clé de tombstone |
| Métriques | compteurs et reason codes à cardinalité bornée | valeur, identifiant sujet ou provider |
| Fixtures, docs et rapports | domaines réservés et identités manifestement synthétiques | PII réelle ou identité plausible |
| Probe provider privé | statut, coût, compteurs et hash sûr | réponse brute ou donnée personnelle dans un artifact |
| Preuve DSR | compteurs, état et références opaques | donnée supprimée, clé de rapprochement ou diagnostic provider brut |

## Intégration obligatoire des runtimes

La policy ne devient un garde-fou produit que lorsqu'un use case :

1. résout une identité restreinte et recharge les restrictions durables ;
2. évalue la policy avant le premier appel, chaque retry, fallback, refresh et
   export ;
3. persiste la version de policy et la décision avec le plan immuable ;
4. refuse la route entière lorsque `stopFallback` vaut `true` ;
5. propage classification, origine, attribution et expiration jusqu'à la
   projection ;
6. relit le tombstone après restart et restauration.

Le garde d'admission de la shortlist exige `contacts:discover`, un parent prêt,
des bornes de cardinalité/coût/deadline, aucune coordonnée et une lineage
provider restreinte. Les effets sélectionnés relisent les tombstones au dernier
point certain. L'export Contact exige en plus `datasets:export`,
`contacts:export`, la policy locale et une observation exacte par classe. La
restriction DSR exige `contacts:privacy`; la lecture et la révocation d'une
livraison restent owner-only avec `contacts:export`.

Un probe live expurgé a qualifié Search Person puis Enrich Person sur un sujet
borné, sans mobile ni donnée sensible conservée. Cette preuve provider est
distincte des tests locaux du lifecycle et de restauration ; elle ne leur
confère aucun droit provider supplémentaire. L'étape d'identité supprime tout
email incident, sans annuler un éventuel crédit Prospeo. Le rejeu gratuit
annoncé pendant 90 jours n'est pas garanti par Kurobara et le budget interne
reste en `requests`.

## Décision et gates encore ouverts

Le [RFC-0009](../rfcs/0009-contact-data-revocation.md) fixe l'identité HMAC et le
garde pré-effet. Le
[RFC-0012](../rfcs/0012-contact-export-delivery-lifecycle.md) accepte le registre
v2, l'overlay de révocation, l'état public et les contrats owner-only. Les
lectures publiques Contact actuelles et l'export appliquent l'overlay sans muter
les records ; le keyring multi-version est composé dans l'API et le worker ; les
transports REST/SDK/CLI, les courses PostgreSQL et un dump/restore avec readback
sont qualifiés localement. Restent à livrer ou vérifier :

- toute future lecture Contact avant de l'exposer ;
- le retrait d'une ancienne clé, qui exige migration et readback des
  dépendances ;
- la répétition du restore sur le candidat clean-room exact ;
- les droits réels de conservation et redistribution des providers.

Le mode managé, une suppression cross-workspace et les rôles
controller/processor nécessitent une revue distincte ; cette policy locale ne
les prétend pas résolus.
