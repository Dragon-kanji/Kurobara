# Documentation de Kurobara

Cet index rassemble les documents destinés à expliquer le projet open source, ses décisions et ses règles de participation. Une architecture, un ADR ou un RFC décrit une intention ou une décision ; sa présence ne prouve pas qu'un comportement est implémenté, publié ou disponible dans une version donnée.

Pour essayer la révision courante sans provider, commencez par le
[quickstart self-host local](./development/self-host-quickstart.md). Il décrit
la stack Compose, la preuve déterministe, le bootstrap, la CLI, le
backup/restore et la construction des artifacts locaux.
Le [gate de preview publique](./development/public-preview-gate.md) documente
séparément les deux clones anonymes et la vérification des artifacts du tag
`v0.1.0-rc.3`. Son outil ne publie rien et ses reçus restent des preuves
opérateur distinctes du code.

## Comprendre la cible

Commencez par les documents qui définissent les frontières et les invariants du système envisagé :

1. [Premier vertical headless](./development/headless-enrichment-slice.md) — primitives locales et parcours dataset-first de référence.
2. [Application de recette par API, SDK et CLI](./development/recipe-apply-api-cli.md) — dispatch local reprenable et atomique par cellule.
3. [Suivi d'une application de recette](./development/recipe-watch-api-cli.md) — snapshot PostgreSQL et polling client borné.
4. [Export direct d'une application de recette](./development/recipe-application-export.md) — CSV/JSONL prévalidé et streamé, sans artifact durable.
5. [Kit local de conformité des plugins](./development/plugin-conformance.md) — rapport machine-readable, profil exact et sonde d'effet éphémère, sans provider ni qualification de production.
6. [Architecture OSS et agentique](./architecture/v1-oss-agentic.md) — vue d'ensemble de la cible et de ses limites.
7. [Roadmap publique V1](../ROADMAP.md) — ordre logique des outcomes recherchés, sans calendrier ni claim de livraison.
8. [ADR-0001 — frontière du produit open source](./adr/0001-open-source-product-boundary.md) — séparation entre le logiciel public et un éventuel service distinct.
9. [ADR-0002 — exécution durable](./adr/0002-durable-agentic-runtime.md) — responsabilités du domaine, de la persistance et de l'orchestration.
10. [ADR-0003 — contrats et protocoles](./adr/0003-contracts-and-agent-protocols.md) — source canonique des contrats, projections et critères d'adoption des protocoles.
11. [ADR-0004 — baseline modules, contrats et domaine](./adr/0004-v1-module-contract-domain-baseline.md) — décisions détaillées qui rendent les trois premières fondations implémentables.
12. [ADR-0005 — gate V1 dataset-first et headless](./adr/0005-dataset-first-headless-v1.md) — priorité donnée au parcours dataset par API/CLI.
13. [ADR-0006 — frontière staged des plugins et providers](./adr/0006-plugin-provider-boundary.md) — décision provider-neutral désormais matérialisée par un host sidecar local, sans provider ou runtime tiers de production.
14. [ADR-0007 — génération provider-neutral de datasets](./adr/0007-provider-neutral-dataset-generation.md) — origine et readiness communes, pagination durable et provider lock sans faux import.
15. [Planification durable d'une génération](./development/dataset-generation-planning.md) — fondation interne, immuable et idempotente qui prépare une génération sans appeler de provider ni créer de dataset.
16. [Matérialisation durable d'une génération](./development/dataset-generation-materialization.md) — instanciation interne d'un dataset `building` depuis son plan et readiness commune avec les imports, sans page ni effet provider.
17. [Première page durable d'une génération](./development/dataset-generation-first-page.md) — bridge interne vers le runtime `Run`, checkpoint PostgreSQL, reprise sans double effet et arrêt sur ambiguïté avec fixture déterministe.
18. [Recherche d'entreprises et de contacts par API et CLI](./development/company-sourcing-api-cli.md) — verticale multi-page sans CSV, Hunter Discover pour les entreprises puis Prospeo pour la shortlist et l'enrichissement sélectionné.
19. [RFC-0011 — datasets dérivés pour les contacts sélectionnés](./rfcs/0011-selected-contact-derived-datasets.md) — révélation d'identité, email professionnel et export final sans muter la shortlist source.
20. [RFC-0012 — cycle de vie des exports Contact](./rfcs/0012-contact-export-delivery-lifecycle.md) — registre v2, TTL et révocation des livraisons de datasets Contact générés.
21. [Policy BYOK et conditions providers](./policies/byok-provider-terms.md) — séparation entre adapter, compte utilisateur, droits contractuels, outputs et marques.

Les ADR enregistrent les décisions structurantes. Le document d'architecture les assemble en une vue cohérente, sans transformer leurs objectifs en fonctionnalités annoncées.

[RFC-0003](./rfcs/0003-dataset-first-headless-v1.md) conserve l'analyse du
pivot dataset-first et les capacités volontairement sorties de la gate initiale.
[RFC-0002](./rfcs/0002-plugin-sidecar-and-run-input.md) fixe la frontière
provider-neutral staged et ses gates différées. Une tranche locale implémente
maintenant ses contrats fonctionnels, le SDK privé, un host sidecar
process-per-call, une preuve d'installation offline réellement externe et un
rapport de conformité déterministe pour le profil exact
`dev.kurobara.plugin-conformance/local-v1`. Aucun package n'est publié. Le
worker local peut composer les adapters Tavily et Exa maintenus par Kurobara,
sur ordre explicite et, pour Exa, avec l'attestation opérateur fail-closed, via
le bridge d'effet plugin ; « maintenu » ne signifie ni approuvé par le provider
ni contractuellement admis. L'API ne charge pas de provider et aucun runtime de
production n'est annoncé. La sandbox de plugins
tiers, la conformité réseau et la politique complète de compatibilité restent
ouvertes.

[RFC-0008](./rfcs/0008-provider-neutral-dataset-generation.md) accepte la
génération paginée distincte de l'import, matérialisée par des Runs de page et
consommable via une readiness commune. Les trois fondations internes sont
maintenant prolongées par la pagination multi-page, les leases du scheduler,
les compteurs/ledger, la terminaison `ready` et les surfaces publiques company.
La verticale Contact crée maintenant une matérialisation depuis une génération
Entreprises `ready` via REST, SDK TypeScript et `contact search`, puis la lit par
`contact results`. Prospeo Search Person est la route BYOK principale : les
entreprises sont regroupées par page durable, aucune coordonnée n'est projetée
publiquement et l'identité provider reste dans la lineage restreinte. La
requête demande la disponibilité d'un email vérifié selon les
[filtres Prospeo](https://prospeo.io/api-docs/filters-documentation). Une ligne
brute qui contient néanmoins un email ou un téléphone révélé est mise en
quarantaine et abandonnée avant normalisation ou persistance.
La [planification durable](./development/dataset-generation-planning.md), la
[matérialisation initiale](./development/dataset-generation-materialization.md)
et la [première page durable](./development/dataset-generation-first-page.md)
restent les explications de ces frontières. Hunter Discover est testé hors
ligne et qualifié live. La révision locale prolonge désormais la shortlist par
des datasets dérivés sélectionnés : identité professionnelle puis email
professionnel via Prospeo Enrich Person, vérification Hunter explicite si
demandée, puis export CSV ou JSONL. REST, le SDK TypeScript et la CLI exposent
les mêmes opérations. Le gate métier fixture les exerce sans réseau. Une preuve
live locale bornée a aussi traversé CLI -> API -> PostgreSQL -> Hatchet ->
Hunter Discover -> Prospeo Search Person -> Prospeo Enrich Person -> CSV privé :
3 entreprises, 2 contacts masqués et 1 email `found-and-valid`, avec au plus
4 requêtes provider et nettoyage final effectué. Apollo reste opt-in après son
`403` historique ; PDL demeure un candidat offline secondaire. Hunter Finder
et Verifier ne sont pas nécessaires au chemin de base et ne sont pas qualifiés
live.

### Baseline détaillée acceptée

[RFC-0001](./rfcs/0001-v1-module-contract-domain-baseline.md) accepte une baseline cohérente pour les [frontières du monolithe modulaire](./architecture/module-boundaries.md), le [système de contrats canoniques](./architecture/contract-system.md) et le [domaine avec ses cycles de vie](./architecture/domain-lifecycle.md). [ADR-0004](./adr/0004-v1-module-contract-domain-baseline.md) en conserve la décision durable. Cette acceptation fixe la conception ; elle ne vaut pas implémentation des tickets `ARCH-001`, `CONTRACT-001` ou `DOMAIN-001`.

Une fondation d'implémentation est maintenant qualifiée localement. Son [état vérifié et ses limites](./development/v1-foundation.md) séparent les preuves réelles — packages purs, contrats, lifecycle, PostgreSQL, outbox, processus bornés et gates — des compositions serveur, adapters et contrôles de release encore ouverts. La [spécification des frontières](./architecture/module-boundaries.md) conserve les obligations de la cible.

Les premières surfaces opérables sont documentées séparément :
[import dataset local](./development/dataset-import-api-cli.md) et
[application de recette](./development/recipe-apply-api-cli.md) par API, SDK et
CLI, puis [suivi durable de l'application](./development/recipe-watch-api-cli.md)
par snapshot PostgreSQL et polling client, et enfin
[export direct de l'application](./development/recipe-application-export.md)
en CSV ou JSONL. Elles restent expérimentales et ne constituent ni une release,
ni une API hébergée.

## Autorité et sécurité

- Le [modèle d’autorité agentique](./architecture/agent-authority.md) définit l’enveloppe, la réduction monotone des droits, les budgets, les gates humains et les invariants attendus pour la délégation multi-agent. Il s’agit d’une cible normative, pas d’un contrat ou d’un runtime livré.
- Les [frontières et hypothèses de sécurité](./architecture/security-boundaries.md) décrivent le graphe V1 réellement présent, ses contrôles démontrés et les inconnues à valider. Ce registre prépare le futur modèle de menace sans se présenter comme une analyse de risques finale.
- `npm run security:audit` contrôle le graphe de production du lockfile dans la
  CI. Ce contrôle ponctuel ne qualifie ni les futurs artifacts ni un
  déploiement.
- La [politique opératoire des données de contact](./policies/contact-data-handling.md) documente classification, décisions fail-closed, rétention et runbook cible. La shortlist Contact reste sans email ni téléphone et conserve sa lineage provider en zone restreinte. Les tombstones sont contrôlés avant et juste avant chaque effet sélectionné, puis avant et pendant l'export ; celui-ci exige `datasets:export` et `contacts:export`. Le registre v2, le TTL dérivé côté serveur, la propagation atomique, le keyring HMAC multi-version, REST/SDK/CLI et un dump/restore sont qualifiés localement. Le retrait d'une ancienne clé, toute future lecture Contact, les droits provider et la publication restent ouverts.
- Le [preflight de budget et de cardinalité du sourcing](./policies/sourcing-budget-preflight.md) définit les caps explicites et le refus des coûts inconnus. Il est composé dans le runtime paginé avec compteurs, ledger et surfaces publiques company/Contact. Une preuve provider live locale bornée couvre Hunter Discover et le parcours Prospeo principal ; le lifecycle complet de livraison et les gates de release restent séparés et ouverts.

## Concevoir l'expérience

La [direction d'expérience et d'interface](./plan-marque-ui.md) traduit les états métier, l'autorité agentique, les budgets, la provenance et la réconciliation en principes d'interface adaptative. Elle ne choisit aucune stack, marque ou asset et ne prouve pas qu'une UI existe.

## Contribuer

Avant de proposer une modification, consultez :

- le [guide de contribution](../CONTRIBUTING.md) et le [Developer Certificate of Origin](../DCO) ;
- la [gouvernance](../GOVERNANCE.md) et les [responsabilités de maintenance](../MAINTAINERS.md) ;
- le [processus RFC](./rfcs/README.md) pour les changements structurants ;
- le [code de conduite](../CODE_OF_CONDUCT.md) pour les interactions communautaires ;
- la [licence Apache 2.0](../LICENSE) et l'[avis non approuvé sur les marques](../TRADEMARKS.md) pour distinguer les droits sur le code et les marques ;
- la [policy BYOK](./policies/byok-provider-terms.md) pour distinguer l'adapter
  open source des conditions du service et des outputs tiers.

L'acceptation d'une proposition de conception n'est pas une preuve de livraison. Les tests, la documentation du comportement réel et les vérifications applicables appartiennent au changement qui implémente la décision.

## Opérer les comportements vérifiés

Les guides opératoires décrivent `datasets.import`, `recipes.apply`, la lecture
`recipe-applications.get` consommée par `recipe watch`, le téléchargement direct
`recipe-applications.export`, `runs.cancel`, la verticale company et la création
puis lecture d'une shortlist Contact sur la révision courante. Ils couvrent aussi
`contacts.identity.reveal`, `contacts.work-email.resolve`,
`contacts.work-email.verify` et `datasets.export` via REST, SDK TypeScript et
CLI. La vérification reste une décision explicite de l'opérateur ou de l'agent
après lecture de `work_email_verification` ; le serveur ne décide pas de la
sauter. Le profil local compose Hunter et Prospeo par défaut ; Tavily, Exa et
Apollo exigent un ordre explicite, et Exa exige aussi
`KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true`. La
[policy BYOK](./policies/byok-provider-terms.md) distingue ce mécanisme
technique des droits du titulaire de compte. Chaque route dépend aussi de ses
capabilities, credentials BYOK et, pour les effets Contact sélectionnés, un
secret stable d'au moins 32 octets, fourni par le keyring JSON multi-version ou
par les variables HMAC legacy. Ces deux modes ne se combinent pas. Apollo reste
opt-in avec son `403` historique et Hunter Finder/Verifier ne sont pas qualifiés
live. Le dogfood borné se
prépare et se lance explicitement avec :

```bash
npm run b2b:dogfood:preflight
npm run b2b:dogfood -- run --confirm-provider-calls
```

Le preflight n'effectue aucun appel provider ; le run confirmé est limité à
3 entreprises, 3 contacts et 4 requêtes provider, puis nettoie ses données et
son infrastructure éphémères. Cette preuve provider est distincte des suites
locales qui qualifient le registre d'export, le keyring et son restore drill ;
elle ne leur confère aucun droit de redistribution. Elle ne livre pas non plus
de waterfall automatique, téléphone, MCP ou ledger d'autorité global, et ne prouve aucun
droit de redistribution provider, publication OSS ou hébergement. Le guide de
conformité plugin décrit séparément le harness local générique. SSE, la
sandbox tierce, le serveur MCP et la publication restent des cibles. Une
personne ne doit pas déduire
une compatibilité publique, une garantie de production ou un support à partir
des seuls documents d'architecture.

Chaque futur guide devra identifier le comportement vérifié auquel il
s'applique, ses dépendances et ses limites connues, sans promettre de version ou
de niveau de service absent des politiques du projet.

## Sécurité, assistance et usage responsable

- [Politique de sécurité](../SECURITY.md) — traitement des vulnérabilités et des informations sensibles.
- [Assistance communautaire](../SUPPORT.md) — préparation d'une question non sensible ou d'une reproduction expurgée.
- [Repères d'usage responsable](../RESPONSIBLE_USE.md) — recommandations volontaires sur l'autorité, les données et les workflows agentiques.

N'utilisez pas une demande d'assistance ou une proposition publique pour transmettre un secret, une donnée personnelle ou un détail de vulnérabilité exploitable. Suivez la politique de sécurité sans supposer qu'un canal, un délai de réponse ou une version supportée existe au-delà de ce qu'elle indique explicitement.

## Documents non indexés comme documentation produit

Le backlog d'exécution, les audits de préparation, les registres de provenance, les matrices de curation et les runbooks de publication sont des dossiers de travail ou des preuves opérateur. Ils ne décrivent pas une interface produit disponible et ne sont pas liés depuis cet index public.

Les plans historiques ou exploratoires peuvent rester nécessaires à la conservation du contexte dans l'environnement de travail. Ils ne guident pas une installation, une intégration ou une exploitation et ne doivent pas être présentés comme documentation publique du comportement courant.

## Maintenir cet index

- Ajouter uniquement un document destiné aux lecteurs du projet open source.
- Décrire une cible comme une cible et un comportement vérifié comme un comportement vérifié.
- Ne pas publier ici de preuve sensible, d'audit interne ou de procédure de publication.
- Retirer ou corriger un lien lorsque son document devient historique, interne ou trompeur.
- Faire évoluer un ADR ou le superséder lorsqu'une décision structurante change ; ne pas masquer cette évolution dans un guide opérationnel.
