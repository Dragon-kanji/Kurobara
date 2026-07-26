# ADR-0003 — Contrats canoniques et protocoles d’intégration

- Statut : **Accepté**
- Date : **2026-07-17**
- Décideurs : projet Kurobara
- Précisé par : [RFC-0001](../rfcs/0001-v1-module-contract-domain-baseline.md) et [ADR-0004](./0004-v1-module-contract-domain-baseline.md)

## Portée de la décision

Cet ADR définit l’architecture contractuelle cible de Kurobara. Il ne signifie pas que les interfaces, générateurs ou protocoles cités sont déjà implémentés, publiés ou supportés. Une surface ne peut être annoncée comme supportée qu’après publication de ses contrats versionnés et réussite de sa suite de conformité.

## Contexte

Kurobara doit pouvoir présenter les mêmes capacités à des applications HTTP, des bibliothèques clientes, des opérateurs en ligne de commande et des agents. Si chaque interface définit ses propres types, erreurs ou transitions d’état, des comportements apparemment équivalents divergent avec le temps. À l’inverse, adopter un protocole externe comme modèle de domaine rendrait le produit dépendant du cycle de vie de ce protocole.

La décision doit donc distinguer :

- le sens durable des commandes, résultats, problèmes, événements et artefacts ;
- leur projection vers une interface ou un transport ;
- les garanties de sécurité propres à chaque frontière ;
- les preuves nécessaires avant de déclarer une interface conforme.

## Décision

### 1. Source canonique

[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) est l’unique format canonique des données contractuelles publiques. Les schémas couvrent les commandes, résultats, problèmes, événements et références d’artefacts sans reprendre les concepts propres à un fournisseur ou à un transport.

Chaque schéma public doit avoir un identifiant absolu et stable, déclarer explicitement son dialecte, posséder un propriétaire et être inclus dans un catalogue versionné. Les références entre schémas doivent être résolubles à partir de ce catalogue. Un type manuscrit, un validateur local ou un document de protocole ne peut pas devenir une seconde source de vérité.

Les identifiants publics suivent
`https://schemas.kurobara.dev/schemas/<family>/<name>/<semver>` et sont résolus
localement sans accès réseau implicite. Ils sont immuables, sans fragment, query,
extension ni alias flottant. Leur première publication est interdite tant que le
contrôle durable de `kurobara.dev` n'est pas prouvé ; à défaut, un autre domaine
contrôlé est décidé avant tout `$id` public.

Les contraintes qui ne peuvent pas être exprimées par JSON Schema restent décrites comme invariants de domaine, puis vérifiées par des tests de conformité communs à toutes les interfaces.

### 2. Projections HTTP et événementielles

[OpenAPI 3.1](https://spec.openapis.org/oas/) est la projection de référence pour HTTP. La révision 3.1.x exacte et les versions des générateurs sont épinglées dans chaque publication du catalogue. Le document OpenAPI est généré ou vérifié depuis les schémas canoniques ; une correction manuelle de la projection doit être reportée dans la source canonique ou dans une règle de projection explicite.

Les réponses d'erreur HTTP suivent [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html). Chaque famille de problème possède un URI de type stable dans le namespace contractuel et une signification indépendante du transport. Les extensions structurées portent uniquement des informations sûres et documentées ; les traces, secrets, données personnelles et détails internes ne doivent jamais apparaître dans une réponse publique.

[CloudEvents 1.0](https://github.com/cloudevents/spec/tree/v1.0.2) est autorisé uniquement lorsqu’un événement traverse une frontière asynchrone et que son enveloppe améliore réellement l’interopérabilité. Le schéma du contenu reste canonique dans JSON Schema. CloudEvents ne remplace ni le modèle de domaine ni le journal interne, et n’est pas imposé aux événements qui ne quittent pas leur composant. Lorsqu’il est utilisé, la révision 1.0.x exacte est épinglée et l’unicité de la paire `source`/`id` fait partie du contrat de déduplication.

### 3. Parité REST, SDK, CLI et MCP

Les interfaces sont des adaptateurs d’un même service applicatif. Elles peuvent différer dans leur ergonomie ou leur mécanisme de transport, mais pas dans les règles métier, les transitions d’état, les identifiants, l’idempotence, l’autorisation ni la signification des problèmes.

| Surface | Responsabilité contractuelle | Interdiction |
| --- | --- | --- |
| REST | Exposer la projection OpenAPI et les problèmes RFC 9457 | Ajouter une règle métier propre à HTTP |
| SDK | Fournir des types et appels validés à partir du catalogue | Réimplémenter silencieusement validation ou orchestration |
| CLI | Mapper les mêmes commandes et résultats, avec un mode structuré et des codes de sortie documentés | Parser des messages humains pour déterminer le succès |
| MCP | Présenter des capacités métier de haut niveau avec entrées et sorties structurées | Exposer directement un fournisseur ou contourner les politiques du service |

Les erreurs non HTTP conservent le même URI de type et le même code stable que leur problème HTTP, puis ajoutent la représentation native de leur interface : exception typée du SDK, code de sortie du CLI ou erreur structurée MCP. Les messages destinés aux humains peuvent évoluer sans devenir une API.

Toute capacité publique doit figurer dans une matrice de parité. Une exception temporaire doit être explicite, versionnée et testée ; elle ne peut pas être présentée comme une équivalence complète.

### 4. Profil de sécurité MCP

MCP reste un adaptateur, pas une frontière de confiance. Chaque publication qui le supporte doit épingler une révision de la [spécification MCP](https://modelcontextprotocol.io/specification/2025-11-25) et documenter les écarts éventuels. Les schémas d’entrée et de sortie sont issus du catalogue et validés aux limites du serveur. Les descriptions et annotations d’outils aident le client, mais ne constituent jamais un contrôle d’autorisation.

Un transport local par processus hérite des droits de l’utilisateur qui le lance. Il doit limiter les processus enfants et les chemins configurables, ne pas transmettre l’environnement complet par défaut et ne jamais écrire d’identifiants ou de contenu sensible dans les journaux.

Tout transport MCP réseau doit suivre le modèle d’[autorisation MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) et les [pratiques de sécurité MCP](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices). Il exige au minimum :

- TLS, validation de l’origine lorsque le transport l’emploie et limites de taille, durée et débit ;
- pour HTTP, OAuth 2.1, découverte par Protected Resource Metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)) et Resource Indicators ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)), avec scopes minimaux, liaison du jeton à son audience et autorisation par opération ;
- interdiction du token passthrough et absence de secret dans les URI, résultats ou journaux ;
- consentement explicite pour les actions sensibles ou mutantes, avec une politique serveur qui prévaut sur les indications du client ;
- isolation des locataires, protection contre les redirections et requêtes sortantes non sûres, et journal d’audit expurgé ;
- traitement des noms, descriptions, résultats et contenus externes comme données non fiables afin de réduire les risques d’injection et de confusion d’autorité.

Un mode d’authentification spécifique à une installation auto-hébergée doit être nommé comme extension locale et ne doit pas être présenté comme conforme au profil réseau standard.

### 5. Versionnement et empreintes

Le catalogue de contrats possède une version [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) distincte de la version du produit :

- `MAJOR` change lorsqu’un consommateur conforme peut casser ;
- `MINOR` change pour une extension rétrocompatible ou une dépréciation ;
- `PATCH` change pour une correction qui ne modifie pas le comportement contractuel attendu.

Un artefact publié est immuable. Une rupture reçoit un nouvel identifiant ou espace de version majeur. Les ajouts de propriétés, les changements d’énumérations et le passage d’un objet ouvert à un objet fermé sont classés d’après leur effet réel sur producteurs et consommateurs, pas seulement d’après la forme du diff.

Chaque schéma reçoit une empreinte SHA-256 de sa représentation canonique produite selon [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html). L’empreinte du catalogue est calculée sur un manifeste déterministe et ordonné contenant les identifiants, versions et empreintes de ses membres. Elle prouve l’identité exacte d’un artefact, pas l’équivalence sémantique de deux schémas.

Les projections et clients générés doivent embarquer la version et l’empreinte du catalogue source. Une publication conserve aussi la version exacte des standards, générateurs et règles de projection afin de rendre la génération reproductible.

### 6. Conformité et prévention du drift

La validation d’une publication doit couvrir au minimum :

- la validité des schémas, leurs identifiants, dialectes et références ;
- des exemples positifs et des cas négatifs aux frontières importantes ;
- la validation de la projection OpenAPI et la résolution complète de ses références ;
- la reproductibilité des projections, clients et empreintes ;
- un contrôle de compatibilité avec la dernière version publiée ;
- des scénarios communs vérifiant le même résultat, état et problème sur REST, SDK, CLI et MCP lorsqu’ils sont déclarés supportés ;
- les entrées, sorties, autorisations et refus MCP, y compris audience incorrecte, scope insuffisant et action sans consentement ;
- l’enveloppe CloudEvents et son contenu canonique pour chaque frontière qui l’adopte.

Le pipeline doit échouer en cas de projection modifiée sans changement canonique, d’artefact généré obsolète, d’empreinte inattendue ou de rupture non accompagnée d’une version majeure. Les preuves de conformité et la matrice de compatibilité font partie des éléments de publication.

### 6.1 Note d'implémentation initiale

Un compilateur TypeScript interne orchestre initialement Hyperjump pour la
conformité Draft 2020-12 et les références, AJV standalone pour les validateurs,
json-schema-to-typescript pour un profil borné, canonicalize pour JCS et Redocly
pour OpenAPI 3.1.1. Ces moteurs sont remplaçables si les mêmes inputs, outputs,
annotations, fingerprints et gates restent prouvés.

Le compilateur produit chaque projection depuis le manifest canonique. Un
mot-clé que la projection TypeScript ne sait pas représenter bloque la génération
au lieu d'être ignoré. Les annotations d'autorité, classification, redaction et
extensibilité sont validées par vocabulaire et suivies dans un index de projection.

### 7. A2A et AG-UI restent optionnels

[A2A](https://a2a-protocol.org/latest/specification/) n’est justifié que si Kurobara doit accepter ou déléguer des tâches à des agents indépendants à travers une frontière de confiance. Le simple fait d’exposer des outils à un agent relève de MCP et ne suffit pas.

[AG-UI](https://docs.ag-ui.com/) n’est justifié que si une interface agent-utilisateur a besoin d’un flux bidirectionnel interopérable pour les messages, l’état, les événements ou les interactions. Une interface Web classique ou un flux d’événements unidirectionnel ne suffit pas.

L’adoption de l’un de ces protocoles exige un ADR séparé, un cas d’usage mesurable, un modèle de menace, une correspondance avec les contrats canoniques, une suite de conformité et une politique de versionnement. Aucun des deux ne peut créer une nouvelle source de vérité métier.

## Conséquences

### Bénéfices

- les consommateurs partagent un vocabulaire et des erreurs stables ;
- les interfaces restent remplaçables sans redéfinir le domaine ;
- les empreintes rendent le drift et les artefacts périmés observables ;
- les claims de support reposent sur des preuves reproductibles ;
- les protocoles agents restent soumis aux mêmes politiques de sécurité et d’autorisation que les autres interfaces.

### Coûts et risques

- le catalogue, les règles de projection et les tests de compatibilité deviennent des composants de release à maintenir ;
- certaines contraintes métier nécessitent des tests au-delà de JSON Schema ;
- la rétrocompatibilité des objets ouverts, énumérations et extensions demande une revue humaine ;
- JCS impose les contraintes I-JSON pour les documents empreintés et doit être appliqué de manière identique dans tous les outils ;
- une interface distante, particulièrement MCP, augmente la surface d’attaque et ne peut pas être activée sans son profil de sécurité complet.

## Options rejetées

### OpenAPI comme source canonique

Rejeté car OpenAPI décrit une API HTTP. Il ne doit pas imposer ses choix de transport au CLI, à MCP ou aux événements.

### Types et validateurs écrits séparément

Rejeté car la duplication rend les divergences difficiles à détecter et impossible à prouver par une empreinte commune.

### CloudEvents pour tous les événements internes

Rejeté car l’enveloppe n’apporte pas d’interopérabilité à une frontière qui n’existe pas et alourdit le modèle interne.

### MCP comme modèle de domaine

Rejeté car les outils, transports et cycles de vie MCP peuvent évoluer indépendamment de Kurobara. MCP reste une projection de capacités métier.

### A2A ou AG-UI par anticipation

Rejeté faute de besoin démontré. L’ajout préventif d’un protocole augmente la surface de sécurité, de compatibilité et de test sans valeur utilisateur prouvée.

## Critères de révision

Un nouvel ADR est requis avant de :

- remplacer JSON Schema Draft 2020-12 comme source canonique ;
- modifier la méthode de versionnement, de canonicalisation ou d’empreinte ;
- introduire une règle métier propre à une interface ;
- annoncer une surface MCP réseau sans le profil d’autorisation et de conformité défini ici ;
- adopter A2A, AG-UI ou un autre protocole public qui ajoute un cycle de vie ou une frontière de confiance ;
- transformer CloudEvents ou OpenAPI en nouvelle source de vérité.
