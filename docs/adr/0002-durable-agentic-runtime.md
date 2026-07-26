# ADR-0002 — Socle d'exécution durable

- Statut : **accepté pour la cible V1**
- Date : **2026-07-17**
- Portée : runtime self-host et exécution des workflows
- Précisé par : [RFC-0001](../rfcs/0001-v1-module-contract-domain-baseline.md) et [ADR-0004](./0004-v1-module-contract-domain-baseline.md)

## Problème à résoudre

Un run Kurobara peut durer plus longtemps qu'un processus, appeler plusieurs
services externes, se ramifier, attendre une décision humaine et reprendre après
une panne. Les appels sortants peuvent être facturés et ne sont pas toujours
répétables sans risque. Une file de jobs seule ne suffit donc pas : le produit a
besoin d'un historique métier durable, d'une orchestration reprise après crash et
d'une règle explicite pour chaque effet de bord.

La V1 doit fournir ces garanties sans imposer une plateforme distribuée complexe
à un opérateur self-host.

## Décision

La cible retient une architecture à deux responsabilités :

1. **PostgreSQL porte la vérité Kurobara** : runs, plans figés, décisions de
   routage, budget, signaux, résultats, provenance et journal métier.
2. **Hatchet OSS pilote l'exécution durable** derrière un
   `OrchestrationPort` : ordonnancement, reprise, temporisation, concurrence et
   coordination des tâches.

L'API TypeScript et les workers utilisent une version LTS de Node.js épinglée au
moment de chaque release. Le déploiement de référence démarre avec Hatchet en
mode self-host compact, sur un réseau privé. L'application et l'orchestrateur ont
des bases ou rôles PostgreSQL séparés. Les gros résultats passent par un stockage
compatible S3 derrière `ObjectStoragePort`.

Le domaine, le compilateur de workflow et le moteur de policy ne dépendent pas
du SDK Hatchet. Les identifiants, statuts et contrats publics restent ceux de
Kurobara. Une autre implémentation d'orchestration doit pouvoir remplacer
Hatchet sans modifier ces contrats.

Redis, Kafka, RabbitMQ et un moteur de recherche séparé ne font pas partie de la
topologie initiale. Leur ajout exige une mesure démontrant que le socle retenu ne
tient plus un objectif explicite.

## Frontière transactionnelle

La création d'un run, son premier événement et son message d'outbox sont écrits
dans une même transaction applicative. Un dispatcher remet l'outbox à
l'orchestrateur. Le retour suit le chemin inverse par des écritures SQL
idempotentes et un reconciler compare périodiquement l'état Kurobara à l'état du
workflow externe.

Les garanties propres à Hatchet, y compris une fenêtre de déduplication, ne
remplacent jamais la garantie métier. PostgreSQL impose notamment :

- une association unique entre `run_id` et exécution d'orchestrateur ;
- une clé d'opération stable par effet externe ;
- un claim atomique avant chaque appel potentiellement facturable ;
- une unicité des mouvements du ledger ;
- des transitions d'état par compare-and-set.

Une remise en file peut donc recréer du travail technique, mais elle ne peut pas
obtenir une seconde autorisation métier pour le même effet.

### `RunPlan` single-use

Une instance de `RunPlan` crée au plus un `Run` logique. Cette règle ne limite
pas la réutilisation d'un `WorkflowSpec` ou d'un `CompiledWorkflow` : une nouvelle
exécution repasse par `plans.quote` et reçoit plan, quote et snapshots neufs.

`runs.create` enregistre atomiquement la consommation du plan, l'idempotency key
scopée au workspace et à l'opération, le `Run`, `RunQueued` et la première
outbox. Même clé et même intention normalisée retournent le résultat initial ;
même clé et autre intention produisent `idempotency-key-reused`; une autre clé
sur un plan consommé produit `run-plan-already-consumed`. Un échec avant commit
ne consomme ni plan ni clé.

## Sémantique des effets externes

L'exécution est **au moins une fois**. Kurobara ne promet pas l'exactement-une-fois
sur une API qu'il ne contrôle pas.

Avant un appel externe, le worker réserve atomiquement une borne de coût et
persiste son `operation_key`. Il transmet une clé d'idempotence lorsque le
provider la supporte. Après l'appel, il règle la réservation, conserve la
provenance et référence la réponse brute protégée.

Si le processus tombe après l'envoi mais avant la confirmation, l'opération passe
à `ambiguous`. Aucun retry payant n'est autorisé avant réconciliation fournisseur
ou décision humaine. Un budget strict n'est proposé que lorsque l'adapter sait
fournir une borne exécutable ; avec des clés BYOK, le coût observé ou estimé ne
prétend pas remplacer la facture du fournisseur.

## Attentes, signaux et délégations

Les demandes d'entrée et les réponses humaines sont enregistrées avant leur
publication vers l'orchestrateur. Chaque signal est versionné, scoped au run et
à l'étape, autorisé, puis dédupliqué. Le worker vérifie l'état persistant avant de
suspendre un workflow afin de couvrir le cas où la réponse arrive en premier.

Une délégation entre agents est un sous-run normal : elle possède un parent, un
budget, une deadline, un jeu de capabilities et une profondeur maximale. Elle ne
crée pas un canal d'exécution privilégié hors du ledger ou des policies.

## Profil opérationnel V1

- `api` accepte les commandes courtes et expose la lecture des runs ;
- `worker` héberge dispatcher, orchestration applicative et tâches à effets ;
- PostgreSQL applicatif reste restaurable indépendamment de Hatchet ;
- l'état Hatchet, les objets et la configuration chiffrée entrent dans le plan de
  sauvegarde ;
- images, SDK et migrations sont épinglés dans une matrice de compatibilité ;
- l'upgrade n'est accepté qu'après test de reprise, rollback et restauration ;
- OpenTelemetry relie requête, outbox, workflow, étape et appel provider.

Le mode compact vise un premier opérateur, pas un SLA haute disponibilité. La
réplication des workers, les pools par capability et un control plane séparé
arrivent par paliers mesurés sans changer le modèle métier.

## Effets de la décision

### Bénéfices

- reprise durable et attentes longues sans moteur maison ;
- surface self-host encore lisible ;
- montée en charge par workers spécialisés ;
- protection métier indépendante des détails de l'orchestrateur ;
- chemin de remplacement grâce au port et aux tests de conformité.

### Coûts et risques

- deux états persistants doivent être sauvegardés et réconciliés ;
- tout effet externe doit implémenter claims, idempotence et ambiguïté ;
- les upgrades de l'orchestrateur deviennent une opération qualifiée ;
- une mauvaise séparation entre logique durable et appel réseau peut produire
  des doubles effets ;
- le mode self-host compact ne couvre pas, à lui seul, les besoins HA.

## Solutions écartées pour la V1

- **Queue PostgreSQL ad hoc** : compacte, mais elle reporte sur Kurobara les
  waits, graphes, reprises et outils d'exploitation.
- **Temporal** : robuste, avec un coût opérateur initial supérieur au profil V1.
- **Moteur lié directement au domaine** : rapide au départ, mais rend les
  contrats et le kernel dépendants d'un fournisseur d'orchestration.
- **Bus distribué supplémentaire** : aucun besoin mesuré ne le justifie encore.

## Conditions de réexamen

Un nouvel ADR est requis si la charge mesurée impose un autre broker, si la
topologie doit devenir multi-région, si la licence ou la gouvernance de Hatchet
cesse de convenir, ou si les tests montrent que `OrchestrationPort` ne permet pas
de remplacer le runtime sans toucher au domaine.

## Références publiques

- [Hatchet — dépôt open source et présentation du moteur](https://github.com/hatchet-dev/hatchet)
- [Hatchet — options d'exécution durable](https://hatchet.run/use-cases/durable-execution)
- [OpenTelemetry — modèle de signaux](https://opentelemetry.io/docs/concepts/signals/)
