# RFC-0009 — Révocation durable des données de contact

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-21
- Supersedes: none
- Related ADRs: ADR-0007

## Summary

Kurobara introduit un registre interne, append-only et workspace-scoped de
tombstones pour empêcher qu'une identité de contact soumise à restriction
déclenche ensuite une découverte, un enrichissement, un retry, un fallback ou
un refresh externe.

Une identité exacte est transformée en HMAC-SHA-256 versionné avant toute
persistance. La valeur brute, le message canonique et le secret ne sont jamais
écrits en base, dans une preuve ou dans un log. Une autorisation pré-effet
recalcule les clés encore lisibles, relit PostgreSQL, ajoute les restrictions
durables à la policy contact existante et conserve ses contrôles de finalité,
territoire et TTL.

Cette décision ne réécrit pas les records immuables actuels et ne crée pas de
commande publique DSR. Une fondation interne distincte de
`KRB-PRIVACY-003` enregistre désormais des manifests d'export audit-safe et
leurs transitions, mais elle n'est exposée par aucune route, SDK ou CLI. Aucun
effet Contact live ne peut être admis tant que son chemin API/worker ne compose
pas explicitement ce garde.

## Current reality

Avant cette décision :

- `evaluateContactPrivacy` fournit une décision pure et fail-closed pour les
  classes, actions, finalités, territoires, restrictions et TTL ;
- PostgreSQL ne conserve aucun tombstone de contact ;
- aucun use case ne relit une restriction durable avant un effet Contact ;
- il n'existe pas encore de stockage Contact, de route contact live ou de
  registre d'exports délivrés à expurger ;
- les datasets, records, cell results et artifacts existants portent des
  invariants d'immutabilité qui ne peuvent pas être contournés silencieusement.

Le code livré avec ce RFC ajoute le modèle, les ports, les use cases et la
persistance du garde. La révision courante contient aussi le registre interne
`0026_export_delivery_registry.sql` : il empêche une future livraison marquée
révoquée et conserve une preuve après EOF vérifié, sans effacer ni rappeler une
copie déjà reçue. Il ne doit pas être branché à une surface publique tant que
les sujets exacts et les droits provider sont fournis par le caller au lieu
d'être dérivés de la lineage durable côté serveur. Sa présence ne prouve donc
pas qu'une future route Contact compose ces gardes, ni qu'une donnée déjà sortie
de Kurobara a été révoquée.

## Problem

Une décision privacy seulement en mémoire disparaît au restart et peut être
ignorée par un retry, un fallback ou un second provider. Stocker un email en
clair dans un registre de suppression recréerait précisément la donnée que la
restriction doit protéger. Un hash non keyé reste attaquable par dictionnaire.

Le même signal peut aussi être redélivré, arriver en concurrence ou changer de
clé d'idempotence. Une notification tardive ne doit ni créer plusieurs preuves
incompatibles, ni réautoriser l'effet après restauration. Enfin, la rotation de
la clé HMAC ne doit pas rendre invisibles les tombstones écrits sous une version
précédente.

## Goals and non-goals

### Goals

- conserver une preuve durable sans valeur de contact brute ;
- isoler chaque clé, requête et tombstone par workspace ;
- rejouer la même identité et la même raison vers la même preuve ;
- refuser la réutilisation d'une clé d'idempotence pour une autre intention ;
- traiter sans doublon la concurrence, le restart et la redelivery ;
- conserver des reasons fermées pour opt-out, suppression, email revendiqué et
  demande de la personne ;
- composer le tombstone avec la décision contact et ses contrôles TTL ;
- permettre une rotation de secret sans ressusciter une identité restreinte.

### Non-goals

- conserver une base légale, décider de la conformité ou vérifier l'identité
  juridique d'un demandeur ;
- exposer une route REST, un SDK, une CLI ou un outil MCP DSR ;
- muter globalement les datasets, records, cell results ou caches immuables ;
- suivre ou révoquer les CSV, JSONL et autres exports déjà délivrés ;
- contacter un provider, envoyer un message ou exécuter une suppression externe ;
- accepter un nom, un domaine ou un profil approximatif comme identité exacte.

## Proposal

### Identité exacte et digest versionné

Le caller présente transitoirement l'une des identités suivantes :

- `email`, normalisé en NFC, espaces périphériques retirés et casse abaissée ;
- `provider-subject`, composé d'un `provider_key` canonique et de
  l'identifiant exact normalisé en NFC.

Le nom, le domaine seul, l'entreprise ou une similarité probabiliste ne sont
jamais acceptés. La valeur canonique alimente un message séparé par domaine et
version :

```text
["kurobara-contact-privacy-subject", "1.0.0", kind, provider_key, value]
```

Le système produit ensuite un `ContactPrivacySubjectKey` :

```text
algorithm: hmac-sha-256
format_version: 1.0.0
secret_version: opérateur-scoped, non secrète
identity_kind: email | provider-subject
provider_key: vide pour email, obligatoire pour provider-subject
digest: 64 caractères hexadécimaux
```

Le message et la valeur ne quittent pas le processus. La preuve ne retourne que
le tombstone opaque ; le digest complet reste interne à la persistence.

### Lifecycle des secrets

Le runtime reçoit par configuration au moins une clé de 256 bits et exactement
une version `current`. Le secret n'est ni chargé depuis PostgreSQL, ni accepté
dans un contrat public, ni loggé. Une rotation suit l'ordre suivant :

1. ajouter la nouvelle version sans retirer les anciennes ;
2. la rendre `current` pour les nouvelles écritures ;
3. continuer à dériver toutes les versions historiques pour chaque lecture ;
4. vérifier readback, restart et restauration avant tout retrait ;
5. ne retirer une version qu'après une migration démontrant qu'aucun tombstone
   actif ne dépend d'elle.

Supprimer une ancienne clé sans cette preuve est une perte de garde et reste
interdit. La rotation et la sauvegarde des secrets relèvent de l'opérateur ; le
registre ne permet pas de reconstruire la valeur ou le secret.

### Raisons fermées

Un tombstone porte exactement une raison parmi :

- `provider-opt-out` ;
- `provider-deletion` ;
- `provider-claimed-email` ;
- `operator-subject-request`.

Elles sont identiques aux restrictions de `KRB-PRIVACY-001`. La lecture les
injecte dans `evaluateContactPrivacy`, qui positionne
`stopExternalEffects=true` et `stopFallback=true`. Les reason codes restent
distincts d'un résultat absent ou d'une panne provider.

### Registre append-only et idempotence

PostgreSQL conserve deux tables internes :

```text
contact_privacy_tombstones
├─ workspace_id + tombstone_id
├─ subject key versionnée
├─ reason_code
├─ intent_hash
└─ registered_at

contact_privacy_registration_requests
├─ workspace_id + idempotency_key
├─ tombstone_id + intent_hash
└─ requested_at
```

Le tombstone est unique par workspace, clé exacte et raison. La requête lie une
clé d'idempotence au tombstone. Sous transaction et advisory locks :

- même clé, même identité et même raison rejouent la preuve ;
- nouvelle clé, même identité et même raison rejouent la même preuve et
  enregistrent la nouvelle requête ;
- même clé avec identité ou raison divergente échoue sans écriture ;
- une seule création gagne sous concurrence.

Les deux tables refusent `UPDATE` et `DELETE`. `registered_at` est celui de la
première preuve ; une redelivery ne le réécrit pas.

### Garde pré-effet et TTL

`AuthorizeContactEffect` :

1. dérive les clés de toutes les versions configurées ;
2. lit les tombstones du workspace authentifié ;
3. fusionne leurs raisons avec les restrictions déjà observées ;
4. lit l'heure depuis le `ClockPort`, pas depuis le payload ;
5. appelle `evaluateContactPrivacy` avec le snapshot, la finalité, le
   territoire, les classes et les éventuels `observedAt` ;
6. retourne la décision et les IDs de tombstone, jamais les digests.

Un tombstone n'a pas de TTL implicite. Les données demandées conservent les TTL
de leur snapshot : un tombstone absent ne peut donc pas autoriser une policy
expirée ou une valeur expirée. Tout futur chemin Contact doit appeler ce garde
au dernier point certain avant chaque effet, y compris retry, fallback et
refresh.

Le garde ne conserve pas un verrou PostgreSQL pendant un appel réseau. Une
restriction arrivant exactement après la décision ferme les effets suivants,
mais ne peut pas annuler rétroactivement un effet déjà parti. Les futurs
workers doivent donc conserver leur `operation_key`, enregistrer le tombstone
avant toute expurge et réconcilier toute issue en vol sans retry aveugle.

## Public contracts and compatibility

Aucun contrat public n'est créé. Les types, tables, digests et IDs de tombstone
sont internes. Une future route DSR doit versionner authentification,
permissions, preuve de vérification, rate limit et erreurs sans exposer la clé
de sujet.

L'ajout au runtime PostgreSQL est compatible avec les datasets et runs
existants. Il ne transforme pas un dataset non prêt, ne modifie aucun payload
public et n'autorise aucun provider.

## Security, privacy and agent authority

- le workspace vient de l'identité authentifiée, jamais de l'agent ou du
  provider ;
- un agent ne lit ni secret HMAC, ni digest, ni table directement ;
- une notification provider non qualifiée ne peut choisir un autre workspace ;
- erreurs, logs et compteurs ne contiennent ni valeur, ni message HMAC, ni
  digest ;
- les clés historiques restent disponibles uniquement au composant de
  dérivation ;
- une collision HMAC ou SHA-256 est traitée comme conflit et aucune fusion
  probabiliste n'est tentée ;
- la décision ne valide ni droit, ni finalité juridique et n'envoie aucun
  message.

## Data, operations and rollback

La migration `0024_contact_privacy_tombstones.sql` est roll-forward. Sur une
base existante, elle crée des tables vides et n'invente aucun tombstone. Une
sauvegarde/restauration doit restaurer le registre avant de rendre les workers
Contact disponibles, puis exécuter un readback avec toutes les versions de clés
requises.

Avant la première écriture, un rollback peut retirer les tables. Après une
écriture, le rollback doit préserver les preuves et garder le garde lisible ;
les supprimer pourrait réautoriser une identité restreinte.

Les records et résultats existants restent immuables. Comme aucun stockage
Contact live n'existe au moment de cette décision, aucune PII existante n'est
laissée sans expurge par ce choix. `KRB-PRIVACY-003` doit décider avant leur
création l'identité d'un export, son manifest de policy/provenance, sa
rétention, sa révocation, et la manière de retirer ou masquer les projections
sans casser les preuves de coût et d'exécution.

## Alternatives

- **Hash SHA-256 non keyé** : rejeté, attaquable par dictionnaire.
- **Email chiffré réversible en base** : rejeté, inutile au matching et augmente
  l'impact d'une compromission.
- **Un seul secret courant** : rejeté, une rotation ressusciterait les anciennes
  restrictions.
- **Tombstone en mémoire ou dans Hatchet** : rejeté, perdu au restart et hors de
  la vérité métier.
- **Supprimer physiquement tous les records dans cette migration** : rejeté ; il
  n'existe pas encore de stockage Contact et les invariants immuables exigent
  une décision séparée fondée sur les surfaces réelles.
- **Inclure exports et artifacts délivrés** : différé à `KRB-PRIVACY-003`, qui
  doit posséder leur identité et leur manifest avant de promettre une révocation.

## Risks

- conserver un ancien digest HMAC protège mieux que la valeur brute, mais reste
  une donnée interne sensible ; l'accès DB doit rester restreint ;
- perdre une clé historique rend ses tombstones impossibles à retrouver ;
- une normalisation future incompatible exigerait un nouveau format et la
  lecture simultanée des anciens formats ;
- un appel réseau peut partir juste avant une notification concurrente ; sa
  réconciliation doit rester certaine et ne pas relancer l'effet ;
- le garde n'est utile que si chaque composition Contact l'appelle ; la gate
  live doit vérifier ce wiring, pas seulement la présence du package.

## Verification plan

1. vérifier que le même sujet produit un digest stable et aucune valeur brute ;
2. tester chaque reason code, les TTL et le fail-closed de la policy ;
3. tester replay, collision d'idempotence et concurrence ;
4. tester l'isolation de deux workspaces avec le même sujet ;
5. écrire sous une ancienne clé, tourner la clé et relire le tombstone ;
6. migrer une base `0023`, redémarrer le runtime et relire la décision ;
7. prouver que `UPDATE` et `DELETE` sont refusés ;
8. scanner tables, erreurs et preuves pour la valeur synthétique ;
9. exiger dans la gate live que discovery, retry, fallback et refresh passent
   par `AuthorizeContactEffect` avant tout provider.

## Open questions

- La future route DSR et la preuve de vérification de la personne sont laissées
  à une décision de contrat public.
- L'expurge des futures projections Contact et la révocation des exports
  délivrés restent `KRB-PRIVACY-003`.
- Le retrait d'une version HMAC historique exige un runbook et une migration
  prouvée ; aucune durée universelle n'est décidée ici.

## Decision

Le 21 juillet 2026, le decision owner accepte le registre interne append-only,
le HMAC-SHA-256 versionné avec lecture multi-version, les quatre raisons fermées
et le garde pré-effet composé avec la policy TTL. L'acceptation est conditionnée
à l'absence de PII brute dans le registre, à l'isolation workspace et aux tests
de replay, concurrence, restart et rotation.

La mutation globale de records immuables et la révocation d'exports ne sont pas
acceptées par ce RFC. Elles restent bloquées jusqu'à `KRB-PRIVACY-003`. Aucun
provider Contact live n'est admis par le seul statut de ce document.
