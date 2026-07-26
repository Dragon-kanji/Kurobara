# Stratégie des dépôts

- Statut : **décision V1 acceptée**
- Date : **2026-07-17**
- Mise en œuvre : **cible à vérifier ; ce document ne prouve ni publication ni livraison**

Cette stratégie applique l'[ADR sur la frontière du produit](./adr/0001-open-source-product-boundary.md) à l'[architecture V1](./architecture/v1-oss-agentic.md). Elle décrit les responsabilités et dépendances attendues sans documenter d'infrastructure ou de dépôt interne.

## Deux périmètres physiques

Le produit open source doit vivre dans un monorepo public distribué sous [Apache-2.0](../LICENSE). Ce monorepo doit suffire pour installer, configurer, exécuter, observer, administrer et étendre le parcours self-host documenté.

Un éventuel service managé doit résider dans un dépôt privé physiquement séparé. Il pourrait ajouter des adapters et des opérations propres à une offre hébergée, mais resterait un consommateur du produit public. Son existence ou sa disponibilité ne sont pas présumées par ce document.

La séparation physique interdit les dépendances implicites qu'un dossier privé ou un build conditionnel pourrait masquer dans le monorepo public.

## Contenu du monorepo public

Le périmètre public doit comprendre au minimum les éléments nécessaires au produit self-host :

- les contrats canoniques, leurs projections et leurs règles de compatibilité ;
- le kernel, la couche application, le compilateur de workflows et les policies ;
- les ports publics et les adapters du déploiement de référence ;
- la persistence, les migrations, l'orchestration et le stockage d'artifacts ;
- l'API, les workers et la console opérateur minimale ;
- le SDK TypeScript, la CLI et le serveur MCP ;
- l'observabilité, les outils d'administration et les chemins de récupération ;
- la documentation, les tests, les exemples et la composition self-host.

Un clone public doit pouvoir construire et vérifier ce périmètre sans package, schéma, endpoint, secret, registre ou identité provenant du dépôt privé.

## Règle anti-open-core

Une capacité reste publique lorsque son absence empêche le parcours self-host annoncé ou rend son exploitation, son administration, sa sécurité ou son extension volontairement incomplète.

Le dépôt privé peut fournir une commodité opérée, une intégration spécifique ou un adapter d'exploitation. Il ne peut pas retenir une entité métier, une policy indispensable, un contrôle d'accès, une garantie d'isolation, un moteur d'exécution, une migration ou une interface nécessaire au produit public.

Toute exception exige un nouvel ADR qui nomme la capacité, explique la séparation et décrit l'alternative self-host disponible.

## Direction des dépendances

La dépendance autorisée va du dépôt privé vers les releases publiques :

```text
service managé privé  ──consomme──▶  contrats et packages publics
monorepo public       ────────X────▶  code, contrats ou services privés
```

Les règles suivantes s'appliquent :

- les packages métier ne dépendent pas des applications ;
- le kernel n'importe ni framework, ni adapter, ni SDK fournisseur ;
- les applications composent des packages et des adapters publics ;
- le dépôt privé consomme des interfaces publiées, jamais des chemins internes non versionnés ;
- aucun check ou artifact public ne requiert l'accès au dépôt privé ;
- un contrat partagé possède une seule source publique et n'est pas recopié dans le dépôt privé.

## Ports et adapters

Le monorepo public doit définir les ports nécessaires aux frontières externes : persistence, orchestration, secrets, objets, télémétrie, identité, entitlements, metering et providers. Les interfaces restent formulées en termes de capacités du produit, pas d'une offre hébergée particulière.

Chaque fonction indispensable au self-host doit disposer d'une composition publique. Un adapter privé peut implémenter le même port pour un contexte opéré, sans obtenir d'accès privilégié au kernel ni contourner les policies publiques.

Tout adapter privé futur qui revendiquerait une capacité publique devrait respecter les mêmes contrats et la même suite de conformité publiable. Une extension propre à un service managé ne doit pas modifier silencieusement les entités ou événements du cœur.

## Tests de frontière

La séparation devra être vérifiée par des preuves reproductibles :

1. construction et démarrage depuis un clone public neuf ;
2. parcours self-host complet sans identité ou service managé ;
3. contrôle statique interdisant les imports publics vers des modules privés ;
4. scan des manifests, artifacts et configurations contre les coordonnées privées ;
5. tests de conformité des ports, adapters et contrats ;
6. tests de drift entre schémas canoniques et projections générées ;
7. revue documentaire distinguant comportement livré et cible de conception.

La présence de fichiers dans des dépôts distincts ne suffit pas à démontrer la frontière. Les tests doivent couvrir le graphe de build, les appels runtime et les artifacts distribués.

## Releases et compatibilité

Le monorepo public doit posséder son propre cycle de release. Une release publique doit être construite, testée et documentée à partir d'une révision publique identifiable, sans étape privée obligatoire.

Les versions du produit, des contrats, des schémas, de l'API plugin, des packages et des images doivent rester explicites. Une matrice de compatibilité doit indiquer les combinaisons supportées et distinguer changement additif, dépréciation et rupture.

Le dépôt d'un éventuel service managé doit épingler une release publique ou une plage de versions documentée. Il doit s'adapter à une évolution publique au même titre qu'un autre consommateur ; il ne peut pas imposer au monorepo une dépendance sur un commit privé ou une projection non publiée.

Une rupture d'interface publique exige une décision documentée, une nouvelle version appropriée et un chemin de migration. La compatibilité d'un consommateur privé ne remplace pas les checks de release du produit OSS.

## Risques et contre-mesures

- **Drift des contrats** : génération depuis une source publique unique et tests de fingerprint.
- **Dépendance privée indirecte** : analyse du graphe, scans d'artifacts et clone-vers-run.
- **Port conçu pour un seul opérateur** : implémentation self-host et suite de conformité publique.
- **Documentation en avance sur le code** : statut de livraison explicite et vérification rendue.
- **Rupture entre releases** : versions épinglées, matrice de compatibilité et migrations documentées.

## Évolution de la stratégie

Un nouvel ADR est requis avant de fusionner les périmètres, d'extraire un package public vers un autre dépôt, de rendre un service privé obligatoire ou de changer la direction de dépendance.

Cette stratégie décrit une organisation technique et de publication. Elle ne constitue pas un avis juridique ; les droits de distribution sont définis par les fichiers de licence applicables aux éléments concernés.
