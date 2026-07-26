# Roadmap publique de Kurobara

## Statut

Kurobara est en pré-release. Cette roadmap présente l'ordre logique des résultats recherchés pour une première version open source self-hostable. Elle ne fixe aucune date, ne garantit aucune livraison et ne crée aucun engagement de support.

Les mots employés ici ont un sens précis :

| Niveau | Signification |
| --- | --- |
| **Documenté** | Une décision ou une intention possède une trace publique, mais son comportement peut ne pas exister. |
| **Cible** | Le résultat fait partie du chemin envisagé et doit encore recevoir ses preuves. |
| **Livré** | Le résultat a été vérifié sur une release identifiable avec sa documentation et ses artifacts. |

Tous les milestones ci-dessous sont des **cibles**. Leur ordre exprime des dépendances produit, pas un calendrier. Une case ne devient pas livrée par la seule présence de code, d'un document ou d'une démonstration partielle.

## Définition observable de la V1

La V1 sera atteinte lorsqu'une personne extérieure au projet pourra, depuis un environnement propre et en suivant uniquement la documentation publiée :

1. installer et démarrer le déploiement self-host de référence ;
2. importer un dataset JSONL/CSV ou générer un dataset d'entreprises depuis des
   filtres structurés et des limites explicites ;
3. dériver une shortlist de contacts professionnels bornée sans révéler
   implicitement email personnel ou téléphone ;
4. sélectionner des contacts exacts puis révéler leur identité professionnelle
   complète ;
5. résoudre et vérifier uniquement leur email professionnel ;
6. appliquer une recette versionnée à un champ sans imposer de LLM ;
7. créer son contexte local d'accès et enregistrer les providers BYOK requis ;
8. préparer un plan, connaître son incertitude économique et lancer un run idempotent borné ;
9. observer une décision de routage puis un fallback dont les raisons sont persistées ;
10. reprendre le run sans recalculer les cellules déjà valides et annuler proprement un second run ;
11. exporter valeurs, statuts, provenance, fraîcheur, confiance et coût ;
12. retrouver les mêmes identifiants, états et erreurs via API et CLI non interactives ;
13. piloter ce parcours depuis un coding agent au moyen des mêmes surfaces REST,
    SDK TypeScript et CLI, sans parsing d'interface ;
14. sauvegarder puis restaurer les données nécessaires à la lecture des runs ;
15. réaliser ce parcours sans UI, compte ou service Kurobara obligatoire.

Cette définition est une cible de validation. Elle ne constitue pas un quickstart et ne décrit pas des fonctionnalités actuellement disponibles.

Le [RFC-0003](./docs/rfcs/0003-dataset-first-headless-v1.md) et
[l'ADR-0005](./docs/adr/0005-dataset-first-headless-v1.md) enregistrent ce pivot
de gate sans présenter les tranches encore ouvertes comme livrées.

## Milestone 1 - Fondation de publication

**Outcome recherché :** le projet peut recevoir des contributions et produire un candidat public sans exposer de contenu non autorisé ni créer une frontière open source ambiguë.

Le milestone couvre :

- licence, gouvernance, contribution, conduite, sécurité et assistance cohérentes ;
- provenance et droits documentés pour les sources, textes, assets et outputs retenus ;
- séparation testable entre le produit self-host et un éventuel service managé ;
- contrôles de contribution et de supply chain reproductibles ;
- inventaire des éléments distribués et de leurs obligations ;
- procédure de release fondée sur des artifacts identifiables et vérifiables.

**Preuve de sortie :** un candidat exact peut être relu, construit et inspecté sans donnée sensible, dépendance cachée à un service Kurobara ou élément dont le droit de publication reste indéterminé.

## Milestone 2 - Kernel, domaine et contrats

**Outcome recherché :** le sens métier de Kurobara existe indépendamment du stockage, de l'orchestrateur et des providers.

Le milestone couvre :

- kernel pur avec transitions et erreurs métier testables en mémoire ;
- couche application portant les use cases et les policies ;
- modèle versionné pour workflows, plans, runs, étapes, signaux, artifacts et événements ;
- contrats publics issus d'une source canonique et projections reproductibles ;
- isolation des workspaces, autorisation locale et port de secrets ;
- stockage PostgreSQL avec migrations et outbox transactionnelle.

**Preuve de sortie :** les règles du domaine se testent sans infrastructure, les projections ne divergent pas de leur source et les frontières d'import empêchent l'infrastructure d'entrer dans le kernel.

Les choix structurants sont décrits dans [l'architecture V1](./docs/architecture/v1-oss-agentic.md) et dans les [ADR](./docs/adr/).

## Milestone 3 - Runtime durable et coûts maîtrisés

**Outcome recherché :** un run long survit aux pannes et ne répète pas silencieusement un effet externe ou une dépense.

Le milestone couvre :

- orchestration derrière un port remplaçable ;
- reprise après arrêt de l'API, du dispatcher ou d'un worker ;
- idempotence métier, réservations de coût et ledger de règlement ;
- état explicite pour les réponses externes ambiguës ;
- échéances, demande d'arrêt durable et annulation coopérative ;
- stockage objet avec intégrité, isolation, rétention et réconciliation ;
- sauvegarde, restauration, upgrade et rollback qualifiés.

**Preuve de sortie :** les scénarios de crash, redelivery, annulation et réponse inconnue conservent un état lisible sans double autorisation métier.

Le partage des responsabilités entre le registre métier et l'orchestration est fixé par [ADR-0002](./docs/adr/0002-durable-agentic-runtime.md).

## Milestone 4 - Plugins, providers et routage

**Outcome recherché :** une capacité peut être fournie par plusieurs intégrations BYOK sans modifier le kernel ni les interfaces publiques.

Le milestone couvre :

- SDK de plugin et manifest versionné pour capacités, auth, schémas, permissions et économie ;
- harness de conformité pour erreurs, timeouts, idempotence, redaction et compatibilité ;
- premier parcours provider de bout en bout, puis second adapter pour la même capacité ;
- policy engine déterministe sur des faits versionnés ;
- décision de routage immuable avec candidats, exclusions, raisons et fallbacks ;
- revalidation lorsque les capacités, la santé ou les estimations changent.

**Preuve de sortie :** deux adapters passent les mêmes tests, un choix peut être rejoué à partir de son snapshot et un fallback réel conserve un résultat canonique indépendant du provider.

## Milestone 5 - Parcours headless API et CLI

**Outcome recherché :** humains, applications et coding agents pilotent le même service applicatif sans interface graphique.

Le milestone couvre :

- API HTTP pour découverte, planification, runs, événements, annulation, résultats et exports ;
- SDK TypeScript partagé par la CLI et disponible comme projection cliente ;
- CLI avec sorties structurées et codes de sortie documentés ;
- génération bornée d'entreprises sans CSV, shortlist de contacts séparée de la
  révélation et enrichissement des seuls records sélectionnés ;
- problèmes, autorisations, idempotence et identifiants cohérents entre surfaces ;
- scénarios de parité API/CLI exécutés contre la même instance et le même run.

**Preuve de sortie :** un même parcours produit les mêmes états, résultats et erreurs via API et CLI, sans logique métier réimplémentée dans le client. MCP reste une projection P1 dérivée des mêmes contrats après cette preuve.

La relation entre contrats et projections est définie par [ADR-0003](./docs/adr/0003-contracts-and-agent-protocols.md).

## Milestone 6 - Expérience self-host et release vérifiable

**Outcome recherché :** une personne peut déployer, observer, sécuriser et mettre à jour Kurobara sans connaissance interne du projet.

Le milestone couvre :

- déploiement de référence avec versions épinglées, migrations et healthchecks utiles ;
- commandes et API locales pour configurer les providers et inspecter runs, coûts et décisions ;
- traces, métriques et logs corrélés avec redaction par défaut ;
- modèle de menace, isolation, contrôles d'egress et tests de sécurité ;
- guides d'installation, configuration, sauvegarde, restauration et dépannage fondés sur des vérifications ;
- tests de bout en bout, pannes injectées et contrôle de la parité ;
- packages, images et archives accompagnés de leurs inventaires, empreintes et attestations applicables.

**Preuve de sortie :** la définition observable de la V1 est rejouée depuis un environnement propre, puis les artifacts produits donnent le même résultat après vérification et restauration.

## Axe transversal agentic-ready

L'agentique n'est pas un milestone isolé ajouté après le runtime. Chaque étape de la roadmap doit préserver les contraintes suivantes :

Le [modèle d’autorité agentique](./docs/architecture/agent-authority.md) détaille les règles de délégation multi-agent. Les [frontières et hypothèses de sécurité](./docs/architecture/security-boundaries.md) consignent séparément la réalité observable, la cible et les validations encore requises avant un modèle de menace final.

- **Autorité bornée** : un agent ne reçoit que les capacités, données, permissions et durées nécessaires.
- **Plan validé** : une sortie de modèle reste une entrée non fiable jusqu'à validation des schémas et policies.
- **Budget partagé** : une délégation consomme une réservation du run parent au lieu de créer une dépense hors ledger.
- **Multi-agent explicite** : les rôles, sous-runs, profondeur, fan-out et contrats de retour sont persistés.
- **HITL compatible** : une future demande humaine restera typée, autorisée, dédupliquée et compatible avec une reprise après incident, sans bloquer la V1 headless.
- **Décision observable** : routage, fallback et refus portent une version et des reason codes.
- **Provenance de bout en bout** : entrées, transformations, providers, artifacts, décisions et coûts restent reliables au run.
- **Arrêt sûr** : deadline, annulation et résultat ambigu empêchent une autonomie sans limite.

Un planner assisté par modèle peut améliorer la préparation d'un workflow, mais le moteur déterministe et les interfaces ne doivent pas dépendre de sa disponibilité.

## Hors scope de cette roadmap V1

Cette roadmap ne couvre pas l'exploitation d'un service managé, ses opérations commerciales, ses fonctions enterprise ou son infrastructure multi-région. Ces sujets ne doivent ni réduire le produit self-host ni introduire une dépendance du cœur public vers un service privé.

Sont également différés jusqu'à l'existence d'un besoin mesurable et d'une décision d'architecture :

- un agent général capable d'acquérir lui-même de nouveaux droits ;
- une marketplace exécutant du code communautaire arbitraire en production ;
- un broker ou un moteur de recherche ajouté avant observation d'une limite réelle ;
- un transport MCP distant sans profil de sécurité complet ;
- A2A, AG-UI ou un autre protocole agentique adopté par anticipation.

La frontière entre produit public et service managé est documentée dans [ADR-0001](./docs/adr/0001-open-source-product-boundary.md).

## Contribuer à la roadmap

Une proposition peut clarifier un outcome, apporter une preuve ou remettre en cause un ordre de dépendance. Suivez le [guide de contribution](./CONTRIBUTING.md) pour préparer un changement vérifiable.

Une modification structurante de la portée, des contrats, des garanties ou des frontières passe par le [processus RFC](./docs/rfcs/README.md). Cette page ne suppose l'existence d'aucun issue tracker, forum, canal de discussion ou délai de réponse.

Le [README](./README.md) présente la vision générale et l'[index documentaire](./docs/README.md) rassemble les décisions publiques utiles pour comprendre le projet.
