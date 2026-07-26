# Preflight de budget et de cardinalité du sourcing

- Statut : **fondation exécutable, composée dans la planification durable**
- Ticket : `KRB-BUDGET-002A`
- Périmètre : décision pure et provider-neutral, utilisée avant la persistance
  d'un plan interne de génération
- Hors périmètre du garde pur : appel provider, réservation, compteur durable,
  replay et réconciliation ; ces responsabilités appartiennent au runtime de
  génération qui le compose

Ce document décrit le garde pur `evaluateSourcingBudgetPreflight` livré par
`@kurobara/policy-engine`. Il transforme des caps, une quote, un budget et une
deadline déjà résolus en une décision déterministe. Il ne recherche aucune
entreprise ou personne. Les `dry-run` REST, SDK et CLI de la verticale de
sourcing le composent ; ils ne sont pas implémentés dans ce package.

## Invariants

1. Toutes les cardinalités sont explicites. L'absence d'une valeur n'est
   jamais interprétée comme « tous les résultats ».
2. Les huit caps sont des entiers sûrs et bornés : `maxCompanies`,
   `maxContactsPerCompany`, `maxContactsTotal`, `maxEnrichments`, `maxPhones`,
   `maxResults`, `maxPages` et `maxCalls`.
3. Les bornes entreprise/contact ont trois usages explicites. Une recherche
   d'entreprises peut garder `maxContactsPerCompany=0` et
   `maxContactsTotal=0`. Une shortlist applique
   `maxContactsTotal <= maxCompanies * maxContactsPerCompany`. Un
   enrichissement d'une sélection déjà matérialisée utilise
   `maxCompanies=0`, `maxContactsPerCompany=0` et un `maxContactsTotal`
   positif. Une capacité entreprise/contact partielle avec des contacts à
   produire est refusée, et tout produit hors de la plage des entiers sûrs est
   refusé. `maxEnrichments` ne dépasse pas `maxContactsTotal`, `maxPhones` ne
   dépasse pas `maxEnrichments` et `maxPages` ne dépasse pas `maxCalls`.
4. Quote et budget utilisent exactement la même unité provider-native. Le
   preflight n'effectue aucune conversion entre crédits, pages, appels,
   records ou devises.
5. La somme `spent + reserved` ne dépasse pas `limit`. Une borne de coût
   autorisée doit tenir dans le budget encore disponible.
6. Les quotes `hard` et `estimated` exigent toutes les deux un `upperBound`.
   Une quote `unknown` est refusée par défaut. Elle ne devient admissible que
   si une autorisation non interactive explicite fournit aussi un plafond dur,
   fini et exécutable dans la même unité.
7. La quote et la deadline doivent être valides au moment de l'évaluation.
8. Tout refus positionne `stopExternalEffects` et `stopFallback`. Un caller ne
   peut pas transformer un refus de budget en absence provider ou en route de
   secours.
9. Des faits non objets, un objet imbriqué malformé ou un accessor obligatoire
   échouent fermés avec `input-invalid`, sans lancer d'exception ni produire de
   snapshot. Une propriété héritée ne compte jamais comme valeur fournie : elle
   produit le reason code d'absence correspondant.

## Entrées et décision pure

`evaluateSourcingBudgetPreflight(facts: SourcingBudgetPreflightFacts)`
n'effectue aucune I/O et n'accepte ni query, ni credential, ni endpoint, ni
payload provider. Ses faits réunissent exactement :

- `limits`, les huit caps dans un `SourcingCardinalityLimitInput` ;
- `quote`, un `CostQuote` existant avec `hard`, `estimated` ou `unknown`, son
  unité, son éventuel `upperBound` et son expiration ;
- `budget`, un `BudgetLimit` existant avec unité, limite, dépensé et réservé ;
- `deadline` du plan évalué et `now`, l'heure d'évaluation ;
- `unknownCostPolicy`, une `UnknownSourcingCostPolicy` toujours explicite :

```ts
type UnknownSourcingCostPolicy =
  | { mode: "deny" }
  | { mode: "explicit-non-interactive"; hardCap: number };
```

Le second mode n'est pris en compte que pour une quote `unknown`. `hardCap`
doit être un montant valide inférieur ou égal au budget restant.

La décision expose :

- `allowed` ;
- des reason codes fermés et ordonnés de manière stable ;
- `stopExternalEffects` et `stopFallback`.

Une décision autorisée contient en plus `snapshot`, détaché de l'entrée, avec
exactement `budget`, `deadline`, `hardExecutionCap`, `limits` et `quote`. Elle
retourne uniquement `reasonCodes: ["allowed"]` et positionne les deux gardes à
`false`. Une décision refusée omet `snapshot` et positionne les deux gardes à
`true`.

Cette décision ne crée pas seule un plan immuable. Le use case interne
`makePlanDatasetGeneration` la compose, sous verrou d'idempotence, avec une
query normalisée, des routes, une autorité et un stockage transactionnel. La
tranche suivante peut instancier depuis ce plan un `DatasetGeneration` à zéro
et une matérialisation `building`, mais elle ne consomme aucun cap, ne réserve
aucun coût et n'exécute toujours aucun effet provider.

## Cardinalités

Les caps décrivent des bornes distinctes, même lorsque plusieurs valent le même
nombre :

| Cap | Borne | Interprétation du zéro |
| --- | --- | --- |
| `maxCompanies` | entreprises acceptées | aucune entreprise |
| `maxContactsPerCompany` | contacts acceptés pour une entreprise | aucune shortlist contact |
| `maxContactsTotal` | contacts acceptés sur toutes les entreprises | aucun contact |
| `maxEnrichments` | contacts pouvant recevoir un enrichissement payant | aucun enrichissement |
| `maxPhones` | téléphones pouvant être demandés | aucun téléphone |
| `maxResults` | résultats acceptés par la génération bornée | aucun résultat |
| `maxPages` | pages externes pouvant être commencées | aucun appel paginé |
| `maxCalls` | effets externes pouvant être commencés | aucun appel externe |

Les combinaisons admises sont donc distinctes :

- entreprise seule : `maxCompanies > 0`, `maxContactsPerCompany = 0` et
  `maxContactsTotal = 0` ;
- shortlist : `maxCompanies > 0`, `maxContactsPerCompany > 0` et
  `maxContactsTotal` borné par leur produit ;
- enrichissement sélectionné : `maxCompanies = 0`,
  `maxContactsPerCompany = 0`, avec `maxContactsTotal` et
  `maxEnrichments` bornant uniquement les records source choisis.

Un cap de shortlist ou d'enrichissement ne constitue pas une autorisation
privacy. Le runtime Contacts satisfait séparément `evaluateContactPrivacy` et
ses restrictions durables. À l'inverse, une décision privacy favorable ne peut
jamais augmenter un de ces caps.

L'évaluateur refuse les incohérences suivantes sans inventer de
stratégie de pagination :

- une seule des deux dimensions entreprise/contact active alors que
  `maxContactsTotal > 0` ;
- en mode shortlist,
  `maxContactsTotal > maxCompanies * maxContactsPerCompany` ;
- `maxEnrichments > maxContactsTotal` ;
- `maxPhones > maxEnrichments` ;
- `maxPages > maxCalls`.

Le produit `maxCompanies * maxContactsPerCompany` doit lui-même rester un
entier sûr. La consommation atomique de chaque borne, y compris sous
concurrence et après restart, est assurée par `KRB-DATASET-GEN-001`.

## Quote, budget et incertitude

La garantie de quote conserve sa sémantique existante, avec une borne connue
obligatoire pour `hard` et `estimated` :

- `hard` utilise `upperBound` comme `hardExecutionCap` ;
- `estimated` conserve `upperBound` comme pire coût connu mais utilise tout le
  budget restant comme `hardExecutionCap` ; l'estimation ne devient donc pas
  artificiellement une garantie dure ;
- `unknown` utilise le `hardCap` de la policy explicite comme
  `hardExecutionCap`.

Le budget reste le plafond d'autorité de l'effet externe. Une quote ne l'augmente
pas. Pour `unknown`, l'autorisation explicite et le plafond dur forment une
condition supplémentaire, pas une conversion de la garantie en `hard`. Cette
autorisation doit être présente dans l'entrée non interactive ; un prompt, une
variable absente ou une valeur par défaut ne vaut pas consentement.

Le preflight ne contacte pas le provider pour estimer un prix et n'interprète
pas son dashboard. Les adapters admis fournissent une quote locale issue d'un
snapshot de pricing. Si obtenir l'estimation nécessite déjà un
effet externe, cette opération n'est pas un `dry-run` et doit être planifiée et
budgétée séparément.

## Reason codes publics du package

Ces codes appartiennent à l'API TypeScript de `@kurobara/policy-engine`. Ils ne
constituent pas encore un contrat REST, SDK HTTP ou CLI :

- entrée : `input-invalid` ;
- limites : `limit-unknown`, `limit-missing`, `limit-invalid`,
  `limit-overflow`, `limits-inconsistent` ;
- temps : `deadline-invalid`, `deadline-elapsed` ;
- budget et quote : `budget-invalid`, `quote-invalid`, `quote-expired`,
  `quote-unit-mismatch`, `quote-upper-bound-required`,
  `quote-exceeds-budget` ;
- coût inconnu : `unknown-cost-authorization-required`,
  `unknown-cost-hard-cap-required`, `unknown-cost-hard-cap-invalid` ;
- succès : `allowed`.

Une entrée hostile peut produire plusieurs codes de refus dans leur ordre
canonique. `allowed` n'est jamais combiné à un autre code.

## Conditions d'arrêt

Un caller doit traiter `stopExternalEffects=true` comme une frontière :

- aucun premier appel ;
- aucune page suivante ;
- aucun retry facturable ;
- aucun enrichissement ou téléphone supplémentaire ;
- aucun fallback vers un autre provider.

La décision pure ne peut voir ni un Run en cours ni une réponse perdue. Le
runtime durable réévalue les bornes entre deux effets et conserve l'arrêt
lorsqu'une tentative ou une page devient `ambiguous`. Seule une
réconciliation autoritative pourra alors permettre une nouvelle décision ; une
idempotency key provider ne suffit pas à prouver l'absence d'effet.

## Composition dans le runtime durable

`KRB-DATASET-GEN-001` transforme cette fondation en garde-fou produit :

1. valider la query publique avec son schéma versionné, la normaliser et
   calculer son hash côté serveur ;
2. figer query, hash, idempotency key, route, autorité, caps, quote, budget et
   deadline dans la même intention de génération ;
3. rejouer exactement même clé et même intention, et refuser toute collision
   sans effet ;
4. persister les compteurs de cardinalité séparément du ledger financier tout
   en les rattachant au même plan immuable ;
5. réserver et vérifier atomiquement les bornes avant chaque nouvelle page ;
6. relire l'état durable après restart et ne jamais redemander une page déjà
   committée ;
7. bloquer page, retry et fallback sur une issue ambiguë ;
8. exposer le preflight sans effet et les mêmes limites via REST, SDK
   TypeScript et CLI, sans défaut illimité.

La tranche interne `KRB-DATASET-GEN-001A` couvre la normalisation locale, le
plan snapshoté et son replay PostgreSQL. `KRB-DATASET-GEN-001B` instancie ce plan
avec des compteurs et un coût agrégé initialisés à zéro ; ce snapshot n'est pas
une consommation. `KRB-DATASET-GEN-001C` revalide les huit caps, le budget et la
deadline dans la transaction qui autorise le premier seuil d'effet, conserve la
réservation en cas d'issue ambiguë et checkpoint le coût certain depuis le Run.
Le parent `KRB-DATASET-GEN-001` et la composition locale de `KRB-BUDGET-002`
couvrent désormais les pages suivantes, le budget agrégé de génération,
`plans.quote`, le dry-run public et les recherches publiques d'entreprises et
de contacts. Le bundle suivi
[`planning-bundle.company-contact.v1.json`](../../examples/planning-bundle.company-contact.v1.json)
borne la verticale de recette locale. Il ne constitue toutefois pas un ledger
global d'autorité partagé entre plusieurs générations : la borne totale du
harness métier repose aussi sur sa topologie explicite et sur une tentative au
plus par étape. La correspondance exacte entre l'unité interne `requests` et
les crédits facturés par chaque provider reste une condition d'admission et
d'exploitation séparée.

## Observabilité et données interdites

Les logs et métriques peuvent conserver les reason codes, unités et
compteurs bornés. Ils ne doivent contenir ni query brute, ni credential, ni
payload provider, ni identité de contact. Les tests et exemples utilisent
uniquement des valeurs synthétiques et n'appellent aucun réseau.

Une unité, une garantie ou un plafond inconnu ne doit jamais être normalisé en
zéro pour faire passer le garde. Un zéro explicitement fourni dans un cap de
cardinalité signifie au contraire que cette catégorie est désactivée et reste
visible dans le snapshot.
