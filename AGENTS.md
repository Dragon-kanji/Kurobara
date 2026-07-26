# Règles de travail du dépôt Kurobara

## Partir du résultat demandé

Chaque intervention commence par le résultat du ticket, son périmètre et ses contraintes. Inspectez les fichiers concernés et l'état réel du dépôt avant de proposer ou d'appliquer un changement.

Une instruction restrictive est une frontière, pas une préférence :

- un ticket `docs-only` ne modifie ni code, ni configuration, ni artifact généré ;
- un ticket `no-code` peut modifier uniquement les fichiers non exécutables explicitement autorisés ;
- une revue en lecture seule ne produit aucune écriture locale ou externe ;
- une liste de fichiers autorisés est exhaustive ;
- une demande sans publication n'autorise ni push, ni release, ni déploiement.

N'élargissez pas le ticket pour corriger un problème voisin. Signalez-le séparément avec son impact et sa preuve.

## Distinguer cible et réalité

Les ADR et [l'architecture V1](./docs/architecture/v1-oss-agentic.md) définissent la direction du produit. Ils sont normatifs pour les nouvelles décisions, mais ne prouvent pas que leur contenu est déjà implémenté.

Pour établir la réalité actuelle, utilisez dans cet ordre les surfaces pertinentes :

1. le code et les manifests suivis ;
2. les tests et commandes réellement exécutés ;
3. le comportement observé dans le runtime ou l'interface ;
4. les artifacts construits et leur contenu ;
5. la documentation, uniquement pour les décisions et limites qu'elle décrit explicitement.

Ne transformez jamais une route documentée, un package nommé, une cible de backlog ou un diagramme en fonctionnalité annoncée. Lorsque la preuve manque, écrivez `cible`, `prévu`, `non vérifié` ou `indisponible`, selon le cas.

## Respecter les frontières d'architecture

Tout nouveau code doit rester compatible avec les décisions d'architecture applicables :

- le kernel ne réalise pas d'I/O et n'importe aucun framework, provider ou adapter ;
- les use cases et policies résident dans la couche application, pas dans les clients ;
- PostgreSQL porte l'état métier durable ; l'orchestrateur reste un mécanisme interne ;
- les effets externes prévoient idempotence, résultat ambigu, réconciliation et coût ;
- les contrats publics sont versionnés à partir d'une source canonique ;
- REST, SDK TypeScript, CLI et MCP exposent la même logique au lieu de la dupliquer ;
- les adapters implémentent des ports et ne contaminent pas le domaine ;
- l'autorité d'un agent est bornée par permissions, budget, deadline et conditions d'arrêt ;
- le service managé peut consommer le cœur public, jamais l'inverse.

Une proposition qui change une frontière, un contrat public, une garantie de compatibilité ou une décision coûteuse à inverser suit le [processus RFC](./docs/rfcs/README.md).

## Produire des changements focalisés

- Préférez des types explicites aux assertions risquées et `unknown` à `any` lorsque la donnée n'est pas qualifiée.
- Validez les entrées à la frontière qui les reçoit ; ne faites pas confiance à un payload externe ou généré.
- Gardez les fonctions courtes, les erreurs descriptives et les effets de bord visibles.
- Utilisez les composants et éléments HTML adaptés à leur fonction, avec clavier, labels et états accessibles.
- Évitez les exports globaux par barrel lorsque des imports précis suffisent.
- Retirez logs de debug, valeurs temporaires et chemins de contournement avant le handoff.
- Ajoutez des tests proportionnés au risque métier, à la compatibilité et aux scénarios d'échec.

Une génération de contrats doit partir de la source approuvée. Ne corrigez pas manuellement un output généré pour masquer un drift.

## Écrire une documentation vérifiable

La documentation décrit séparément :

- ce qui fonctionne sur la révision actuelle ;
- ce qui constitue une décision de conception ;
- ce qui reste une condition de release ou une question ouverte.

Les commandes publiées doivent avoir été lues dans les manifests et, lorsque le ticket le permet, exécutées. Un exemple utilise des données synthétiques et ne contient ni identité plausible, ni secret, ni endpoint privé. Vérifiez chaque lien local modifié.

Ne créez pas par le texte un canal de support, un SLA, une équipe, un bot, une protection de branche, une version supportée ou une politique hébergée. Ces éléments ne deviennent documentables qu'après un readback de leur état réel.

## Protéger le travail existant

Inspectez `git status` avant toute modification. Les changements déjà présents appartiennent à l'utilisateur ou à un autre travail tant que leur origine n'est pas établie.

- Ne supprimez, ne restaurez et ne reformatez pas un fichier hors périmètre.
- Ne masquez pas un worktree sale pour obtenir un diff artificiellement propre.
- En cas de modification concurrente d'un fichier autorisé, relisez le diff et intégrez sans écraser l'autre travail ; arrêtez-vous si les intentions sont incompatibles.
- Utilisez des opérations réversibles et des chemins explicites.

## Sécurité, secrets et provenance

- Ne committez jamais de secret, token, credential, fichier `.env` réel, dump, log sensible ou donnée personnelle.
- Les exemples de configuration utilisent des valeurs manifestement factices.
- Redactez les sorties de diagnostic avant de les placer dans un document ou un ticket.
- Un sign-off DCO ne remplace pas la preuve de provenance, de licence ou de droit de publication.
- Vérifiez les obligations des dépendances, assets, fixtures et contenus générés destinés à une distribution.
- Une vulnérabilité non publique suit [SECURITY.md](./SECURITY.md) et ne doit pas être détaillée dans une surface publique.

## Commandes disponibles

Le manifest racine épingle `npm@10.9.4` et déclare les commandes suivantes. Leur présence ne signifie pas que la baseline est verte ; consignez le code de sortie et les diagnostics pertinents.

| Besoin | Commande | Remarque |
| --- | --- | --- |
| Installer le graphe verrouillé | `npm ci` | Utiliser le lockfile suivi ; peut modifier `node_modules`, jamais les sources. |
| Auditer les dépendances de production | `npm run security:audit` | Interroge la base d'advisories npm depuis le lockfile et échoue dès le niveau `info` ; ne masque aucun finding. |
| Lint et format check | `npm run check` | Lance Ultracite en lecture de diagnostic. |
| Typecheck des workspaces | `npm run typecheck` | Exécute les scripts disponibles avec `--if-present`. |
| Build des workspaces | `npm run build` | Exécute les builds disponibles avec `--if-present`. |
| Qualifier le packaging et la conformité plugin | `npm run test:plugin-packaging` | Construit les tarballs locales, installe leur fermeture offline, exerce un plugin externe via le host local et vérifie le rapport machine-readable du template. |
| Régénérer les contrats | `npm run generate:contracts` | Seulement lorsque la source canonique et le ticket l'exigent. |
| Construire ou vérifier un export clean-room | `npm run clean-room -- <commande>` | Outil source/opérateur : il refuse l'écrasement, exige une destination absolue et ne pousse rien. |
| Corriger avec Ultracite | `npm run fix` | Commande mutante ; limiter son effet aux fichiers autorisés puis relire le diff. |
| Démarrer l'API locale V1 | `npm run start:api` | Exige une configuration PostgreSQL explicite ; écoute loopback par défaut. |
| Importer un dataset par la CLI locale | `npm run kurobara -- dataset import --metadata <fichier> --source <fichier-ou-tiret>` | Exige l'API locale, `KUROBARA_API_KEY` ou `--api-key-file` et une metadata conforme. |
| Suivre une application de recette | `npm run kurobara -- recipe watch --application-id <id> --timeout-ms <ms>` | Polling HTTP borné ; `0` effectue une lecture ponctuelle, sans accès direct à PostgreSQL. |
| Démarrer le worker V1 | `npm run start:worker` | Exige PostgreSQL et Hatchet explicitement configurés. |

Choisissez le plus petit ensemble de checks qui couvre le changement. Pour un lot documentaire, vérifiez au minimum les liens locaux, le contenu interdit et `git diff --check`. Pour du code, ajoutez typecheck, tests, build ou smoke test selon la surface touchée.

Si un check échoue hors périmètre ou sur une dette préexistante, ne la corrigez pas silencieusement. Rapportez la commande, le résultat et la séparation entre régression du ticket et état antérieur.

## Clôture Git

Avant le handoff :

1. relisez le diff complet des fichiers autorisés ;
2. lancez `git diff --check` ;
3. confirmez que le statut ne contient aucun artifact accidentel, secret ou fichier hors scope créé par le ticket ;
4. indiquez les checks exécutés, leurs résultats et toute zone non vérifiée ;
5. distinguez vos changements des modifications concurrentes laissées intactes.

Stagez ou committez uniquement lorsque le ticket l'autorise. Un commit local n'autorise pas un push. Aucun push, changement GitHub, publication, release ou déploiement ne doit être effectué sans demande explicite.
