# Modèle d’autorité agentique — cible V1

- Statut : **décision normative de conception**
- Date : **2026-07-17**
- Réalité actuelle : **un sous-ensemble interne d'`AuthorityEnvelope` contrôle
  workspace, permission, capability, budget et deadline ; le parcours HTTP
  local lie aussi l'acteur authentifié au sujet de l'enveloppe pour
  `capabilities.list`, `plans.quote`, puis `runs.create`. Délégation, worker
  durable et contrat public complet restent absents**

## Objet

Ce document définit le sens attendu de l’autorité pour un run agentique et ses
délégations. Il décrit les règles que les futures frontières d’exécution devront
faire respecter, indépendamment du moteur d’orchestration, du protocole, du
fournisseur ou du mode d’hébergement retenu.

Le modèle s’applique lorsqu’un humain, une application ou un agent confie une
tâche à un sujet d’exécution. Il ne donne jamais à un modèle la capacité de
s’autoriser lui-même. Une instruction générée, un nom d’outil ou une métadonnée
de protocole ne remplace pas une décision d’autorisation.

## Cible et état livré

Les noms employés ci-dessous sont un vocabulaire de domaine cible. En
particulier, `AuthorityEnvelope` désigne un concept normatif. Ses propriétés
devront être représentées dans les futurs contrats canoniques et vérifiées par
des tests de conformité avant toute annonce de support.

Le package kernel possède désormais une représentation TypeScript interne
partielle, consommée par le policy engine et la préparation d'un run. Le serveur
HTTP local authentifie une clé DB, dérive son acteur, son workspace et ses
permissions. La discovery et la quote chargent l'enveloppe exacte demandée et
refusent de manière indistinguable une enveloppe absente ou appartenant à un
autre sujet avec
`authority-subject-mismatch`. La discovery exige en plus la permission
`capabilities:list` dans la clé et l'enveloppe, vérifie sa deadline, puis ne
retourne que l'intersection avec un registre runtime explicitement composé. Ce
registre reste vide sans credential admis ; avec une configuration BYOK
explicite, il expose uniquement la capability commune aux adapters Tavily et
Exa effectivement composés. La création vérifie à nouveau que l'acteur
correspond au `subjectActorId` figé dans le plan. Cette preuve ne constitue ni
le contrat sérialisé complet, ni une délégation multi-agent, ni une preuve de
worker durable. Lorsqu'un comportement non couvert par cette tranche est décrit
au présent, il exprime une obligation de la cible V1.

## Vocabulaire

- **Sujet** : identité autorisée à exécuter une tâche. Le sujet peut représenter
  un utilisateur, un service, un rôle agent ou une instance de sous-run, sans
  confusion entre ces identités.
- **Délégant** : sujet ou autorité humaine qui accorde une fraction de son
  autorité à un enfant.
- **Enfant** : sous-run ou rôle recevant une autorité dérivée et bornée.
- **Enveloppe d’autorité** : photographie versionnée des droits, limites et
  obligations applicables à une exécution.
- **Effet externe** : action susceptible de modifier un système hors de la
  transaction métier locale, de consommer une ressource ou d’engager un coût.
- **Gate humain** : point où une action demeure interdite jusqu’à réception
  d’une décision humaine durable, valide et suffisamment autorisée.
- **Contrat de résultat** : définition préalable de ce qu’un enfant peut
  retourner et des preuves nécessaires pour que son parent l’accepte.

## `AuthorityEnvelope`

Chaque run et chaque délégation cible possède une enveloppe immuable et
versionnée. Une modification d’autorité produit une nouvelle décision explicite ;
elle ne réécrit pas silencieusement l’enveloppe déjà utilisée.

| Élément normatif | Sens attendu |
| --- | --- |
| Version de l’enveloppe | Identifie sans ambiguïté les règles interprétées. Une version inconnue est refusée. |
| Sujet | Identifie le sujet d’exécution, sa nature et l’autorité qui l’a authentifié. |
| Workspace | Fixe le domaine d’isolation dans lequel toutes les autres portées sont interprétées. |
| Capabilities et outils | Énumère les aptitudes métier et les outils utilisables. L’absence d’une permission vaut refus. |
| Portées de ressources et de données | Limite les objets, opérations, classes de données, régions, modes de lecture ou d’écriture et contraintes de conservation accessibles. |
| Réservation de budget | Réserve une borne au sein du budget parent, avec unité, devise éventuelle, montant disponible et référence de ledger. |
| Deadline et TTL | Donne une échéance absolue et une durée de validité maximale (`TTL`) lorsque l’une ou l’autre s’applique. La limite la plus proche prévaut. |
| Concurrence | Borne le nombre d’actions, d’étapes ou d’enfants actifs simultanément. |
| Profondeur et fan-out | Borne le niveau de délégation restant, le nombre total d’enfants et les créations concurrentes. |
| Gates humains | Nomme les actions qui exigent une décision humaine, la qualité d’identité requise et la portée de cette décision. |
| Conditions d’arrêt | Énumère les faits qui interdisent de poursuivre ou d’engager de nouveaux effets. |
| Chaîne de délégation | Référence le parent, le délégant, le motif et la suite d’identités qui a conduit à l’enveloppe. |
| Contrat de résultat | Fixe la forme, la taille, les états de terminaison, les artefacts permis et les preuves attendues. |
| Contexte de décision | Référence les versions de policies et de contrats, la provenance et les identifiants d’audit nécessaires à la relecture. |

Les conditions d’arrêt couvrent au minimum l’épuisement du budget, l’échéance,
l’annulation, la révocation de l’identité, l’invalidation d’une policy ou d’un
contrat, l’échec terminal et un effet externe devenu ambigu. Une installation
peut imposer des arrêts supplémentaires ; elle ne peut pas ignorer ceux hérités
du parent.

La commande opérateur PostgreSQL hors ligne peut installer une photographie
`1.0.0` pour un workspace local. Cette écriture administrative n’est ni une
délégation agentique, ni une preuve d’autorité humaine, ni une surface
self-service : les use cases revalident encore version, sujet, permissions,
capabilities, budget et deadline avant toute utilisation.

## Réduction monotone parent vers enfant

Une délégation dérive une nouvelle enveloppe, mais ne crée aucune autorité. La
création de l’enfant est autorisée uniquement si la réduction peut être prouvée
sur toutes les dimensions suivantes :

1. les capabilities et outils de l’enfant sont des sous-ensembles de ceux du
   parent ;
2. chaque portée de ressource ou de donnée est égale ou plus étroite, dans le
   même workspace ;
3. le budget réservé à l’enfant est prélevé sur le disponible du parent et ne
   peut dépasser celui-ci ;
4. l’échéance de l’enfant n’est jamais postérieure à celle du parent ;
5. les plafonds de concurrence, profondeur, fan-out et tours ne dépassent pas
   les limites encore disponibles dans la chaîne ;
6. un gate humain hérité ne peut être retiré, contourné ou rendu moins exigeant ;
7. les conditions d’arrêt du parent restent actives et peuvent seulement être
   renforcées ;
8. l’enfant ne peut déléguer que si ce droit est explicite et si toutes les
   limites résiduelles permettent une nouvelle dérivation ;
9. le contrat de résultat de l’enfant reste acceptable par celui de son parent.

Si une dimension est absente, incompréhensible ou impossible à comparer, la
délégation est refusée. Une valeur implicite ne doit jamais être interprétée
comme une extension de droits.

## Identité et chaîne de délégation

Le runtime cible distingue l’utilisateur demandeur, le service qui autorise, le
run parent, le rôle délégué et l’instance qui exécute. Un enfant n’usurpe ni le
nom ni les credentials du parent. Il reçoit une identité ou une capacité
dérivée, limitée à sa propre enveloppe et révocable indépendamment lorsque cela
est possible.

La chaîne conserve, pour chaque maillon :

- l’identité du délégant et celle du sujet enfant ;
- le parent direct et le run racine ;
- le motif et le moment de la délégation ;
- la version d’enveloppe accordée ;
- la décision de policy qui a admis ou refusé l’opération.

Cette chaîne est append-only du point de vue métier. Une révocation empêche les
nouvelles délégations et les nouveaux effets ; elle n’efface ni les coûts ni les
effets déjà observés.

## Planner non fiable et validation des outils

La sortie d’un planner est une proposition non fiable. Elle peut être
malformée, incohérente, injectée par un contenu externe ou demander davantage
d’autorité que le sujet n’en possède. Elle n’est jamais exécutée directement.

Avant la création d’un enfant ou tout appel d’outil, une frontière de confiance
valide au minimum :

- la forme, la version, la taille et la cohérence de la demande ;
- l’identité du sujet, le workspace et la chaîne de délégation ;
- la capability, l’outil et l’opération demandés ;
- les portées de ressources et de données de chaque entrée ;
- la policy applicable, le budget disponible, l’échéance et la concurrence ;
- les gates humains et les conditions d’arrêt ;
- l’identité stable de l’opération avant tout effet externe.

Les descriptions, annotations et sorties d’outils sont traitées comme des
données. L’autorisation serveur et les invariants métier prévalent toujours. Un
appel refusé ne doit produire ni effet externe, ni réservation persistante
orpheline, ni délégation partielle.

## Budget, réservations et ledger

Le budget est une autorité consommable, pas une simple information destinée à
l’affichage. Toute opération potentiellement facturable et toute délégation qui
en reçoit une part obtiennent une réservation atomique avant l’exécution.

Les règles suivantes s’appliquent :

- la somme des montants dépensés et réservés ne dépasse jamais la borne du run
  parent ;
- le budget d’un enfant est retranché du disponible du parent, et non ajouté au
  budget global ;
- chaque réservation est réglée, libérée ou laissée dans un état explicite à
  réconcilier ;
- un mouvement de ledger possède une identité stable et n’est comptabilisé
  qu’une fois ;
- un retry de la même opération réutilise son identité et ne reçoit pas
  automatiquement une nouvelle autorisation de dépense ;
- un coût sans borne exécutable reste estimé ou inconnu et ne peut pas être
  présenté comme une garantie stricte.

Une réservation concurrente qui perd la course au disponible échoue avant
l’effet. Les coûts réellement engagés restent enregistrés après annulation ou
échec.

## Gates humains durables

Une demande d’approbation et sa réponse sont des faits métier persistants. Elles
ne reposent pas sur la mémoire d’un worker ni sur la présence continue d’une
connexion.

Une décision humaine cible est :

- liée au workspace, au run, à l’étape et à l’action concernée ;
- attribuée à une identité disposant de la permission requise ;
- versionnée, datée, dédupliquée et soumise à expiration si la décision est
  temporelle ;
- persistée avant la notification du moteur d’orchestration ;
- consommée au plus une fois pour l’action autorisée.

Le worker consulte l’état durable avant de se suspendre afin qu’une réponse
arrivée tôt ne soit pas perdue. Une réponse rejouée ne déclenche pas un second
effet. Une approbation ne peut élargir l’enveloppe existante : une autorité
supplémentaire exige une nouvelle décision explicite et une nouvelle version
d’enveloppe.

## Annulation, deadlines, TTL et propagation

L’annulation, l’expiration de la durée de validité ou le dépassement de la
deadline ferment immédiatement l’accès à toute nouvelle délégation, réservation
ou effet externe. La demande d’arrêt se propage aux descendants, même si le
moteur d’orchestration met du temps à interrompre leur travail technique.

Un appel déjà envoyé ne peut pas toujours être annulé. Il est alors réglé selon
son résultat observé ou placé en réconciliation. Les résultats partiels, coûts
et traces déjà produits restent visibles. L’annulation est une transition
d’état et non une promesse de rollback universel.

## Effets externes ambigus et réconciliation

Chaque effet externe reçoit une identité d’opération stable avant son envoi. Si
le processus perd la confirmation après l’envoi, ou si le fournisseur ne permet
pas de déterminer l’issue, l’opération devient ambiguë.

Dans cet état :

1. aucune nouvelle dépense ni tentative aveugle n’est autorisée pour
   l’opération ;
2. la réservation et les éléments de provenance restent conservés ;
3. une procédure de lecture fournisseur, de réconciliation ou de décision
   humaine détermine la suite ;
4. le règlement final enregistre l’effet confirmé, l’absence d’effet ou
   l’impossibilité persistante de conclure.

Une clé d’idempotence fournie à un service externe réduit le risque, mais ne
remplace pas cette sémantique métier.

## Contrat de résultat

Avant la délégation, le parent fixe un contrat de résultat qui indique au
minimum :

- les états de terminaison admis, notamment succès, échec, annulation, résultat
  partiel ou ambigu ;
- la structure attendue, sa version et ses limites de taille ;
- les classes d’artefacts autorisées et leurs règles d’accès ;
- les preuves de provenance et de coût nécessaires ;
- les critères de complétude et les erreurs typées possibles.

Le résultat est validé à la frontière de retour. Un contenu non conforme est un
échec explicite ; il n’est ni accepté silencieusement ni converti en succès par
le parent. Les résultats partiels sont conservés uniquement lorsqu’ils sont
prévus par le contrat et clairement distingués d’un accomplissement complet.

## Échec, retry et compensation

L’échec d’un agent n’accorde pas, à lui seul, le droit de relancer, de changer
d’outil ou d’élargir une portée. Une policy explicite décide si une nouvelle
tentative, un fallback ou une intervention humaine reste compatible avec
l’enveloppe et le budget.

Une compensation est un nouvel effet métier. Elle possède sa propre
autorisation, son identité d’opération, sa réservation éventuelle, sa policy et
son résultat. Elle ne doit pas être présentée comme l’effacement certain d’un
effet antérieur. Si la compensation échoue ou devient ambiguë, cet état est
auditable séparément.

## Provenance, audit et expurgation

Le journal métier doit permettre de reconstruire pourquoi une action était
admise, refusée ou interrompue. Les faits d’audit couvrent au minimum :

- l’identité et la version de l’enveloppe ;
- le sujet, le délégant et la chaîne de parents ;
- les versions de policies et de contrats appliquées ;
- les décisions de délégation et de routage ;
- les appels d’outils, identités d’opération et transitions d’effets ;
- les gates et décisions humaines ;
- les réservations, règlements et libérations de budget ;
- les résultats, artefacts, erreurs, annulations et compensations.

Les secrets, credentials, données personnelles brutes et contenus sensibles ne
sont pas recopiés dans les événements ou la télémétrie par défaut. L’audit
référence des artefacts protégés lorsqu’une preuve détaillée doit être conservée,
avec contrôle d’accès, rétention et expurgation adaptés. Les logs techniques
aident au diagnostic mais ne deviennent jamais la source de l’autorité.

## Invariants obligatoires

1. **Conservation de l’autorité** : aucune délégation ne possède un droit absent
   de sa chaîne parente.
2. **Isolation du workspace** : une enveloppe ne peut ni lire ni modifier une
   ressource d’un autre workspace.
3. **Conservation du budget** : dépenses et réservations restent sous la borne
   autorisée malgré les courses, retries et reprises après panne.
4. **Borne temporelle** : aucune nouvelle action ne commence après l’échéance la
   plus restrictive de la chaîne.
5. **Identité d’effet** : un effet externe possède une identité métier stable
   avant son envoi.
6. **Gate durable** : une action soumise à approbation ne part qu’après une
   décision valide, persistée et consommable pour cette action.
7. **Arrêt sur ambiguïté** : une issue externe inconnue bloque toute nouvelle
   dépense liée jusqu’à réconciliation.
8. **Validation des résultats** : un parent n’accepte qu’un résultat conforme au
   contrat annoncé.
9. **Traçabilité** : toute autorisation et tout refus importants sont reliés à
   leur identité, leur policy, leur budget et leur provenance.
10. **Annulation effective** : dès que l’arrêt est observé, aucun descendant ne
    peut obtenir une nouvelle autorisation d’effet.

## Scénarios d’acceptation testables

Ces scénarios qualifient l'implémentation complète. La tranche locale prouve
seulement un sous-ensemble : clé bearer persistée et permissions, isolation de
workspace lors de la création/lecture, et refus d'un acteur authentifié qui
n'est pas le sujet de l'enveloppe du plan. Le test HTTP/PostgreSQL utilise un
vrai socket loopback et une base jetable. Il ne prouve pas délégation,
révocation pendant un run, réduction parent-enfant, gates humains, worker
Hatchet, ledger complet ou exposition distante.

| Scénario | Résultat attendu |
| --- | --- |
| Un enfant demande un outil absent de l’enveloppe parent | Délégation ou appel refusé avant tout effet et motif d’autorisation enregistré. |
| Un enfant demande une ressource d’un autre workspace | Refus systématique, sans lecture de la ressource ni fuite dans l’erreur. |
| Une délégation réclame un budget supérieur au disponible | Refus atomique, sans création d’enfant actif ni mouvement de ledger orphelin. |
| Deux enfants réservent simultanément le dernier budget disponible | Au plus une réservation gagne, et l’invariant de conservation reste vrai. |
| L’échéance demandée par l’enfant dépasse celle du parent | Délégation refusée avec une erreur de réduction monotone. |
| Un enfant tente de supprimer un gate humain hérité | Délégation refusée ; aucune exécution n’atteint l’outil protégé. |
| Le fan-out ou la profondeur résiduelle est épuisé | La nouvelle délégation est refusée sans modifier les enfants existants. |
| Un planner produit une demande malformée ou hors portée | Validation en échec ; aucun run enfant, appel d’outil ou coût n’est créé. |
| Une réponse humaine arrive avant que le worker attende, puis est rejouée | La première réponse valide est retrouvée et consommée une fois ; le replay n’ajoute aucun effet. |
| Une approbation est fournie par une identité insuffisante ou après expiration | Le gate reste fermé et le refus est attribué à la bonne règle. |
| L’annulation survient pendant un appel externe | Aucun nouvel effet ne démarre ; l’appel en vol est réglé ou marqué ambigu, puis les descendants convergent vers l’arrêt. |
| Le worker tombe après l’envoi mais avant l’accusé fournisseur | L’opération devient ambiguë, conserve sa réservation et n’est pas relancée avant réconciliation. |
| Un enfant renvoie une sortie non conforme | Le parent reçoit un échec de validation ou un résultat partiel explicitement autorisé, jamais un succès implicite. |
| L’identité du sujet est révoquée pendant le run | Les effets déjà constatés restent tracés ; les futurs appels et délégations sont refusés. |
| Une compensation est nécessaire après un échec | Elle ne démarre qu’avec sa propre autorisation et son résultat ne masque pas l’effet original. |
| Un événement d’audit concerne une donnée sensible | L’événement contient les références et métadonnées nécessaires sans exposer le secret ou le contenu brut protégé. |

## Références publiques

- [Architecture cible V1 OSS agentique](./v1-oss-agentic.md)
- [ADR-0002 — Socle d’exécution durable](../adr/0002-durable-agentic-runtime.md)
- [ADR-0003 — Contrats canoniques et protocoles d’intégration](../adr/0003-contracts-and-agent-protocols.md)
- [Principes d’usage responsable](../../RESPONSIBLE_USE.md)
- [Roadmap publique](../../ROADMAP.md)
- [Présentation du projet](../../README.md)
