# RFC Kurobara

Un RFC capture une proposition dont les conséquences méritent d'être comprises avant implémentation. Il rend visibles le problème, les options, les compromis, la décision et les preuves attendues.

Le RFC est un document de conception. Son acceptation enregistre un choix ; elle ne démontre pas que le comportement existe, qu'une release le contient ou qu'un support est disponible.

## Registre

| RFC | Sujet | État |
| --- | --- | --- |
| [0001](./0001-v1-module-contract-domain-baseline.md) | Baseline V1 des modules, contrats et cycles de vie | Accepted |
| [0002](./0002-plugin-sidecar-and-run-input.md) | Plugin SDK, sidecar et input durable des runs | Accepted |
| [0003](./0003-dataset-first-headless-v1.md) | V1 dataset-first headless | Accepted |
| [0004](./0004-headless-transport-slices.md) | Tranches de transport headless | Accepted |
| [0005](./0005-recipe-apply-rest-sdk-cli.md) | Application agrégée d'une recette | Accepted |
| [0006](./0006-recipe-application-watch.md) | Suivi d'une application de recette | Accepted |
| [0007](./0007-recipe-application-export.md) | Export direct d'une application de recette | Accepted |
| [0008](./0008-provider-neutral-dataset-generation.md) | Génération provider-neutral de datasets | Accepted |
| [0009](./0009-contact-data-revocation.md) | Révocation durable des données de contact | Accepted |
| [0010](./0010-company-candidate-results.md) | Lecture paginée des candidats entreprise | Accepted |
| [0011](./0011-selected-contact-derived-datasets.md) | Datasets dérivés pour les contacts sélectionnés | Accepted |
| [0012](./0012-contact-export-delivery-lifecycle.md) | Cycle de vie des exports de datasets Contact | Accepted |

## Quand utiliser un RFC

Un RFC est approprié pour :

- créer ou casser un contrat public ;
- modifier une frontière entre kernel, adapters, applications ou service hébergé ;
- introduire une dépendance structurante ou une migration difficile à annuler ;
- changer les garanties de compatibilité, de données, de sécurité ou d'exploitation ;
- définir l'autorité d'un agent, ses garde-fous ou ses interactions humaines ;
- faire évoluer la gouvernance, la licence ou le modèle de contribution ;
- arbitrer un désaccord qui ne peut pas être résolu par une revue locale.

Un correctif limité, une clarification documentaire ou un refactoring qui préserve les interfaces peut suivre directement le [guide de contribution](../../CONTRIBUTING.md).

## Emplacement et identité

Chaque RFC réside dans `docs/rfcs/NNNN-sujet-court.md`. Le numéro est unique et reste attaché au document quelle que soit son issue. Une collision de numéro est résolue avant intégration, sans changer l'identité d'un RFC déjà accepté.

Le document relie les [ADR](../adr/) qu'il crée, remplace ou remet en question. Une décision d'architecture acceptée doit être résumée dans un ADR durable ; le RFC conserve l'analyse et les alternatives.

## Rôles

- **Auteur** : construit la proposition, rassemble les preuves et intègre les objections dans le texte.
- **Decision owner** : mainteneur responsable de conduire la revue et d'enregistrer l'issue.
- **Reviewers** : examinent les domaines qu'ils connaissent et signalent risques, hypothèses ou alternatives.
- **Implementation owner** : porte la livraison après acceptation ; ce rôle peut rester non assigné au moment de la décision.

L'auteur peut aussi être mainteneur, mais ne contourne ni les conflits d'intérêts ni les règles de décision de [GOVERNANCE.md](../../GOVERNANCE.md).

## États

| État | Sens |
| --- | --- |
| `Draft` | Le contenu évolue encore et ne demande pas de décision. |
| `Review` | Le problème, la proposition et les questions ouvertes sont prêts à être examinés. |
| `Accepted` | Le decision owner a consigné le choix, ses conditions et les risques assumés. |
| `Rejected` | Le projet ne retient pas la proposition et garde la justification. |
| `Withdrawn` | L'auteur arrête la proposition sans effacer le dossier. |
| `Superseded` | Un RFC plus récent remplace explicitement cette décision. |

## Cycle de vie

1. L'auteur ouvre un `Draft` avec un périmètre et des non-objectifs explicites.
2. Le decision owner vérifie que la proposition est assez complète pour passer en `Review`.
3. Les objections substantielles sont ajoutées au RFC avec leur réponse ; elles ne disparaissent pas du dossier parce qu'elles ont été résolues.
4. Le decision owner applique la gouvernance et choisit `Accepted`, `Rejected` ou un retour à `Draft`. L'auteur peut choisir `Withdrawn`.
5. Si l'architecture change, l'ADR correspondant est créé ou mis à jour avant que la décision ne guide l'implémentation.
6. L'implémentation et ses checks sont suivis dans le changement qui livre le comportement, pas dans le statut du RFC.
7. Une révision incompatible crée un nouveau RFC et relie les deux documents avec l'état `Superseded`.

Aucun délai de revue n'est implicite. Le niveau de preuve attendu augmente avec l'impact, l'irréversibilité et l'exposition des utilisateurs.

## Questions propres aux systèmes agentiques

Lorsqu'un RFC concerne un agent ou un workflow durable, il traite les points applicables suivants :

- autorité accordée et actions explicitement interdites par la conception ;
- schémas d'entrée, de sortie, d'erreur et d'événement ;
- identité, permissions, isolation des workspaces et gestion des secrets ;
- budget, deadline, concurrence, retries et conditions d'arrêt ;
- idempotence, effets externes, résultats ambigus et réconciliation ;
- checkpoints, reprise après incident, annulation et compensation ;
- provenance, artifacts, auditabilité et explication des décisions ;
- intervention humaine avant ou pendant les étapes à fort impact ;
- observabilité sans fuite de secrets ni de données personnelles ;
- comportement dégradé lorsque le modèle, le provider ou l'orchestrateur est indisponible.

Les recommandations volontaires de [RESPONSIBLE_USE.md](../../RESPONSIBLE_USE.md) peuvent aider à identifier ces risques. Les vulnérabilités non publiées suivent [SECURITY.md](../../SECURITY.md), pas un RFC public.

## Forme minimale

Un RFC reste aussi court que le permet la décision. Il contient au minimum :

```markdown
# RFC-NNNN - Titre

- Status: Draft
- Author(s):
- Decision owner:
- Implementation owner: unassigned
- Created: YYYY-MM-DD
- Supersedes: none
- Related ADRs: none

## Summary

## Problem

## Goals and non-goals

## Proposal

## Public contracts and compatibility

## Security, privacy and agent authority

## Data, operations and rollback

## Alternatives

## Risks

## Verification plan

## Open questions

## Decision
```

Une section peut indiquer qu'elle ne s'applique pas avec une justification courte. La décision finale nomme l'issue, la date, les conditions, les objections non résolues et les ADR à produire.
