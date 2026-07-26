# RFC-0006 — Suivi d'une application de recette

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-19
- Supersedes: none
- Related ADRs: ADR-0005

## Summary

Ce RFC fixe une lecture durable, agrégée et sans contenu de cellule pour suivre
une application de recette. `recipe-applications.get@1.0.0` lit un snapshot
PostgreSQL par `application_id`. REST et le SDK exposent cette lecture ; la CLI
`recipe watch` la répète par polling jusqu'à un état terminal,
`needs_replay` ou jusqu'au timeout explicite du client.

Cette décision amende aussi RFC-0005 : lorsqu'un `recipes.apply` retrouve un
calcul actif portant l'identité exacte de la cellule, il épingle dans la même
transaction ce `CellResult` et son `Run` à l'application avant de retourner
`active`. Le suivi peut alors converger sans nouvelle passe. Aucun second
lifecycle d'application n'est créé.

## Problem

RFC-0005 crée des applications et des runs durables, mais sa réponse ne décrit
qu'une passe de réconciliation. Un opérateur ne peut pas distinguer ensuite une
application encore en cours, terminée ou incomplètement liée sans relancer la
commande d'application. Cette relance est sûre, mais elle mélange reprise et
observation et ne permet pas une attente CLI bornée.

La première surface de suivi doit donc dériver une vue utile depuis les données
métier existantes, sans exposer les cellules, les valeurs, les raisons d'échec
ou la topologie des runs et sans transformer l'orchestrateur en source de
vérité.

## Goals and non-goals

### Goals

- définir une opération de lecture unique pour REST, SDK TypeScript et CLI ;
- dériver un état stable depuis le graphe d'application, les liaisons, les
  `CellResult` et les `Run` conservés dans PostgreSQL ;
- retourner seulement des identités d'application et des compteurs bornés ;
- rendre l'attente CLI déterministe par polling et timeout client explicite ;
- permettre au suivi de converger lorsqu'une application partage un calcul
  déjà actif ;
- préserver l'isolation par workspace et l'autorité `recipes:read`.

### Non-goals

- créer un lifecycle, un job ou un orchestrateur d'application distinct ;
- retourner cellules, runs, valeurs, raisons, provenance ou coûts ;
- ajouter cursor, pagination, `observed_at`, SSE ou streaming ;
- ajouter annulation, export ou appel provider ;
- exposer une projection MCP ;
- publier, déployer ou stabiliser ces surfaces locales expérimentales.

## Proposal

### Snapshot durable counts-only

`recipe-applications.get@1.0.0` est une lecture idempotente inhérente. Elle
reçoit seulement `application_id`, une chaîne fermée de 1 à 255 caractères
contenant au moins un caractère non blanc. Le workspace est dérivé de la clé
API vérifiée.

La réponse fermée contient `workspace_id`, `application_id`, `dataset_id`,
`recipe_id`, `recipe_revision`, `state`, `terminal` et huit compteurs :
`total_cell_count`, `bound_cell_count`, `unbound_cell_count`,
`pending_cell_count`, `running_cell_count`, `succeeded_cell_count`,
`failed_cell_count` et `skipped_cell_count`. Le total est compris entre 1 et
10 000 ; chaque autre compteur est compris entre 0 et 10 000.

Les invariants suivants sont contrôlés à la frontière de sortie et dans les
tests :

- `bound_cell_count + unbound_cell_count = total_cell_count` ;
- la somme des cinq compteurs de statut est égale à `bound_cell_count` ;
- `needs_replay` signifie `unbound_cell_count > 0` et `terminal = false` ;
- `running` signifie aucune cellule non liée, au moins une cellule pending ou
  running et `terminal = false` ;
- `succeeded` signifie toutes les cellules succeeded, aucun autre statut et
  `terminal = true` ;
- `completed_with_errors` signifie aucune cellule non liée, pending ou running,
  au moins une cellule failed ou skipped et `terminal = true`.

`state` est un read model dérivé. Il ne devient pas un nouvel agrégat métier et
n'ajoute aucune transition aux lifecycles canoniques de `Run` et `CellResult`.

### Amendement du calcul actif de RFC-0005

La branche `active` de RFC-0005 ne peut plus rester une simple observation.
Avant de retourner `active`, `recipes.apply` lie dans sa transaction de cellule
l'identité exacte du `CellResult` et du `Run` actifs à l'application courante.
Cette liaison ne crée ni nouveau run, ni coût, ni effet provider. La terminaison
du run partagé devient ainsi visible au prochain snapshot.

Une application partiellement persistée avant cet amendement peut encore avoir
des cellules non liées. Son état est `needs_replay` ; rejouer exactement le même
`recipes.apply` réconcilie ces cellules de façon idempotente.

### Projections et polling

- REST : `GET /v1/recipe-applications/{application_id}` ;
- SDK TypeScript : `recipeApplications.get(request)` ;
- CLI : `recipe watch`, polling du même endpoint et sortie JSON ;
- MCP : projection différée, sans tool exécutable.

Chaque lecture est sans effet et peut être réessayée. Le SDK expose seulement
`get` et propage l'`AbortSignal` de cette lecture. La CLI exige un timeout
explicite et ne peut pas attendre indéfiniment : elle écrit le snapshot JSON sur
stdout lorsqu'il est terminal ou `needs_replay`. Si le timeout expire pendant
`running`, elle écrit `cli-watch-timeout` sur stderr, termine avec le code 75 et
n'émet aucun JSON de succès.

## Public contracts and compatibility

L'opération, les deux schémas et le problème
`recipe-application-not-found@1.0.0` sont additifs, en
`local-development-only`. Le catalogue passe de `0.3.0` à `0.4.0`.

La réponse n'inclut volontairement ni détails de cellule, ni identifiant de
run, ni valeur, ni raison, ni cursor, ni pagination, ni horodatage
`observed_at`. Toute future extension incompatible exigera une nouvelle version
de contrat. SSE reste une piste future distincte, orientée `runs.watch`, et ne
fait pas partie de ce watch applicatif par polling.

Les problèmes publics sont `authentication-required`,
`authority-permission-missing`, `internal-error`, `invalid-credential`,
`output-contract-violation`, `recipe-application-not-found`, `request-invalid`
et `service-unavailable`. L'absence autorisée retourne le nouveau problème 404,
non retryable.

## Security, privacy and agent authority

La clé vérifiée fournit le workspace et doit autoriser `recipes:read`. Un
`application_id` absent ou appartenant à un autre workspace produit le même
`recipe-application-not-found`, afin de ne pas confirmer l'existence d'une
ressource inaccessible.

La réponse counts-only réduit les risques de fuite : elle ne contient ni donnée
de record, ni valeur de cellule, ni message d'erreur interne, ni secret. Le
polling n'accorde aucune autorité de mutation, d'annulation ou de dépense.

## Data, operations and rollback

PostgreSQL reste la source de vérité. Une lecture cohérente calcule le snapshot
depuis l'application et ses liaisons durables ; Hatchet et la mémoire du process
ne portent aucun état contractuel supplémentaire. Le polling est entièrement
côté client et ne nécessite ni scheduler serveur ni connexion longue.

Un rollback peut retirer les projections de lecture et de polling sans
supprimer les applications, les liaisons, les `CellResult` ou les `Run`. Les
liaisons ajoutées pour un calcul actif sont des références métier durables ;
elles ne sont pas annulées au rollback et ne déclenchent aucun effet externe.

## Alternatives

- **Relancer seulement `recipes.apply`** : rejeté comme unique suivi, car cela
  confond reprise et observation et n'offre pas un read model terminal stable.
- **Créer un agrégat ou job d'application** : rejeté pour cette tranche ; les
  données canoniques suffisent à dériver les quatre états.
- **SSE immédiatement** : différé ; la première cible streaming reste un futur
  `runs.watch`, après preuve qu'un polling borné ne suffit plus.
- **Retourner les cellules et les runs** : rejeté pour garder le contrat petit,
  borné et peu exposant.
- **Ajouter export, provider, cancel ou MCP** : hors scope et sans dépendance
  nécessaire pour une lecture counts-only.

## Risks

- un intervalle de polling trop court peut charger PostgreSQL ; les clients
  doivent appliquer un intervalle explicite et borné ;
- les anciennes applications non réconciliées peuvent rester `needs_replay`
  jusqu'au replay de la même intention ;
- un snapshot peut changer immédiatement après sa lecture, ce qui est attendu
  pour un read model de progression ;
- la CLI et le SDK restent privés et non distribués.

## Verification plan

1. compiler le catalogue `0.4.0` sans drift et vérifier les sept opérations,
   les 28 problèmes, OpenAPI, CLI et l'absence de tool MCP ;
2. valider les bornes de `application_id`, les schémas fermés, les états et les
   compteurs ;
3. tester chaque invariant de compte et chaque combinaison `state`/`terminal`
   à la frontière de sortie ;
4. prouver par PostgreSQL qu'un calcul actif exact est lié dans la transaction
   avant la réponse de `recipes.apply`, puis converge vers un état terminal ;
5. tester not-found, workspace masqué et permission `recipes:read` ;
6. exécuter une lecture SDK et une attente CLI avec succès, erreurs terminales,
   timeout et interruption explicite ;
7. exécuter check, tests, typecheck, build et `git diff --check` sous les
   versions Node/npm qualifiées.

## Open questions

- l'intervalle de polling par défaut qui restera prudent sur une installation
  locale sans rendre la CLI inutilement lente ;
- le seuil observé qui justifierait ultérieurement `runs.watch` en SSE.

## Decision

**Accepted le 2026-07-19.** Le decision owner retient un snapshot PostgreSQL
counts-only et un polling client avec timeout explicite. RFC-0005 est amendé
pour épingler le `CellResult` et le `Run` exacts d'un calcul actif avant retour.
SSE, export, provider, annulation et MCP restent hors scope. Aucune objection
non résolue ni nouvel ADR n'est requis pour cette tranche compatible avec
ADR-0005.
