# Direction d'expérience et d'interface

## Statut

Ce document décrit une direction prospective pour les interfaces publiques et self-host de Kurobara. Il ne prouve pas qu'une interface, un composant, un thème ou un parcours existe. Aucun framework, kit de composants, système d'authentification ou moteur documentaire n'est imposé ici.

L'[architecture cible](./architecture/v1-oss-agentic.md) définit les états et responsabilités métier. Cette direction traduit ces contraintes en principes d'expérience sans modifier le périmètre du produit.

## Intention d'expérience

L'interface recherchée doit être calme, technique et premium sans bullshit. La qualité doit venir de la hiérarchie, de la précision, de la lisibilité, de la vitesse perçue et du contrôle donné à l'opérateur, pas de superlatifs ou d'un décor qui simule la sophistication.

Principes directeurs :

- montrer l'état réel avant de proposer une action ;
- rendre visibles autorité, coût, incertitude et provenance ;
- distinguer une intention, une estimation, une action demandée et son résultat confirmé ;
- conserver l'historique utile plutôt que réécrire le passé pour simplifier l'écran ;
- présenter les décisions automatiques comme des décisions explicables, jamais comme de la magie ;
- réduire le bruit sans cacher les limites, refus ou résultats ambigus ;
- garder les mêmes règles métier sur écran large, mobile et navigation clavier.

## Architecture UI par états métier

La navigation cible s'organise autour des objets et états du domaine, pas autour des détails d'un orchestrateur ou d'un fournisseur. Les composants doivent recevoir un état métier explicite et rendre les actions autorisées pour cet état.

### Du plan au résultat

Le parcours doit séparer visuellement :

1. l'intention ou le workflow en préparation ;
2. le plan validé et ses contraintes ;
3. l'estimation avec sa validité et ses hypothèses ;
4. le run créé avec son identité immuable ;
5. l'exécution, ses étapes et décisions ;
6. les interventions ou réconciliations attendues ;
7. le règlement final, les résultats, coûts et preuves.

Une action mutable ne doit pas apparaître comme accomplie avant confirmation. Un état en attente, en annulation ou ambigu ne doit pas être aplati en succès ou échec générique.

### États à rendre distincts

Les représentations devront au minimum différencier les états prévus par le modèle : estimation expirée, en file, en cours, attente humaine, annulation en cours, annulé, terminé, échoué et ambigu. Chaque état associe :

- une dénomination stable et non euphorique ;
- les faits qui l'ont déclenché ;
- les actions encore permises ;
- les effets et coûts déjà engagés ;
- la prochaine transition attendue ou l'absence de transition automatique.

Les états d'interface comme chargement, données périmées, reconnexion, absence de résultat et accès refusé restent distincts des états métier du run.

## Surfaces self-host envisagées

Les surfaces ci-dessous sont des responsabilités d'expérience, pas une liste de pages livrées :

- **mise en route locale** : prérequis, état de la configuration et diagnostics sans exposer de secret ;
- **capabilities et adapters** : disponibilité déclarée, contraintes, permissions et état de qualification ;
- **workflows et plans** : structure, validation, budget, échéance et points d'intervention avant exécution ;
- **runs** : recherche, statut, graphe, tentatives, événements, dépenses et actions autorisées ;
- **interventions humaines** : demandes en attente, contexte nécessaire, impact et décision enregistrée ;
- **résultats et artefacts** : aperçu sûr, provenance, intégrité, rétention et export lorsque ces capacités existent ;
- **diagnostics opérateur** : santé, files d'attente, erreurs bornées et signaux de réconciliation, sans reproduire une console d'infrastructure ;
- **documentation embarquée** : explications liées au contexte et aux limites du comportement vérifié.

Une surface self-host ne doit pas devenir un prétexte pour introduire inscription commerciale, tarification, vente de crédits ou dépendance obligatoire à un service externe.

## Vues agentiques

Une interface agentic-ready doit rendre l'autorité aussi lisible que l'activité.

### Graphe du run

Le graphe présente les étapes, dépendances, sous-runs et rôles délégués. Chaque nœud expose son état, ses entrées et sorties référencées, ses tentatives et la raison de sa transition. Une vue linéaire ou tabulaire équivalente reste disponible lorsque le graphe est trop dense ou inaccessible.

### Autorité et permissions

Une vue dédiée distingue les capacités accordées, refusées et héritées, leur portée, leur expiration et l'identité qui les a autorisées. Une délégation doit montrer la réduction de droits par rapport au parent. La description d'un outil ou d'un agent ne tient jamais lieu d'autorisation.

### Budget et échéance

Le budget affiche séparément estimation, montant réservé, dépense confirmée, dépense incertaine et reste disponible. Les unités et hypothèses sont visibles. Une limite atteinte ou inconnue ne doit pas être représentée comme une simple alerte décorative.

### Trace de décision

La trace explique les candidats considérés, les contraintes appliquées, les motifs d'admission ou de rejet, le choix effectué et les fallbacks prévus. Elle sépare les faits observés, les scores, les règles et les inférences afin d'éviter une explication rétrospective trompeuse.

### Intervention humaine

Une demande HITL indique l'action suspendue, son auteur, les données nécessaires, les effets possibles, le délai éventuel et les choix réellement autorisés. Approuver, rejeter ou fournir une donnée produit une confirmation durable ; fermer une fenêtre ne constitue pas une décision.

### Provenance

Le résultat doit pouvoir être parcouru depuis ses sources jusqu'aux transformations, décisions et artefacts associés. La vue signale les éléments manquants, estimés ou non vérifiés. Elle permet une inspection progressive sans afficher par défaut les contenus sensibles.

### Ambiguïté et réconciliation

L'état ambigu bénéficie d'un traitement de premier rang. L'interface explique quel effet externe reste inconnu, pourquoi une relance pourrait le dupliquer, quelles preuves sont disponibles et quelle réconciliation est attendue. L'action principale ne doit jamais être un retry aveugle.

## Adaptation aux tailles et contextes

Le responsive ne consiste pas à masquer les informations critiques. La composition doit s'adapter à l'espace disponible tout en conservant l'identité du run, son état, son budget, son autorité et les actions risquées.

- Sur un écran large, les relations peuvent être présentées en panneaux coordonnés sans multiplier les modales.
- Sur une largeur intermédiaire, le détail secondaire peut devenir un panneau repliable avec un retour clair au contexte.
- Sur un petit écran, le parcours devient séquentiel ; graphes et tableaux obtiennent une représentation structurée alternative.
- Les comparaisons denses conservent leurs libellés et unités plutôt que dépendre d'un défilement horizontal sans repère.
- Les actions destructives ou coûteuses restent séparées des actions de navigation, quelle que soit la taille.

L'adaptation peut tenir compte des préférences d'affichage et du rôle autorisé, mais ne doit pas révéler une donnée qu'une autre vue protège.

## Clavier et accessibilité

Tous les parcours essentiels doivent être réalisables au clavier avec un ordre de focus logique, un focus visible et un moyen de quitter chaque panneau ou dialogue. Les raccourcis sont découvrables, remappables lorsqu'ils risquent un conflit et désactivés dans les champs de saisie quand nécessaire.

Les interfaces utilisent une structure sémantique, des noms accessibles et des messages annoncés au moment utile. La couleur, la position ou le mouvement ne sont jamais le seul vecteur d'état. Graphes, chronologies et visualisations possèdent une alternative textuelle ou tabulaire offrant les mêmes décisions et informations essentielles.

Les contrastes, tailles de cible, zoom, reflow, lecteurs d'écran et préférences de réduction du mouvement doivent être vérifiés sur le rendu réel, pas déduits du composant source.

## Densité progressive

La première lecture répond à quatre questions : que se passe-t-il, pourquoi, quel est l'impact et que puis-je faire ? Les détails techniques s'ouvrent ensuite par niveaux cohérents :

1. résumé et état ;
2. facteurs de décision et chronologie ;
3. événements, contrats et métadonnées ;
4. contenu brut autorisé et exportable.

Une préférence de densité peut modifier la présentation, jamais les données ou règles métier. Les informations importantes restent adressables et partageables sans obliger un novice à parcourir la totalité d'une trace.

## Mouvement et feedback

Le mouvement sert à préserver le contexte, montrer une relation ou confirmer une transition. Il reste court, interruptible et indépendant du succès d'une opération. Une animation en cours ne bloque pas l'accès au nouvel état.

Avec `prefers-reduced-motion`, les déplacements spatiaux et effets non indispensables sont supprimés ou remplacés par un changement immédiat. Les flux continus, pulsations et animations décoratives ne doivent pas détourner l'attention d'une intervention ou d'un état critique.

## Contenu, confirmations et erreurs

Le ton est direct, calme et précis. Les textes nomment les objets du domaine et évitent les métaphores magiques, le jargon marketing et les messages qui attribuent une intention humaine au système.

Une confirmation indique l'action réellement enregistrée, son objet et son état résultant. Une erreur utile précise :

- ce qui n'a pas abouti ;
- ce qui reste vrai malgré l'échec ;
- si une nouvelle tentative est sûre, interdite ou soumise à réconciliation ;
- l'action possible pour la personne ;
- un identifiant de corrélation expurgé lorsque celui-ci peut aider le diagnostic.

Les messages publics ne contiennent ni secret, ni donnée personnelle inutile, ni payload fournisseur brut. Les recommandations de minimisation et de supervision de [RESPONSIBLE_USE.md](../RESPONSIBLE_USE.md) s'appliquent aussi aux exemples, fixtures et captures.

## Design tokens comme contrat futur

Si un système de design est retenu, ses tokens devront former un contrat sémantique entre documentation, console et composants partagés. Ce document ne fixe aucune valeur de couleur, famille typographique, rayon, ombre ou durée.

Le futur contrat devra couvrir au moins :

- rôles de contenu, surface, bordure, focus et statut ;
- typographie par fonction et non par nom de police ;
- espacements, dimensions de cible et niveaux de densité ;
- élévation, superposition et comportement des panneaux ;
- mouvement, durée sémantique et variante réduite ;
- données de graphe et séries, avec alternatives non colorimétriques ;
- états interactifs, métier, d'accès et de fraîcheur des données.

Le contrat devra être versionné, documenté et testé dans tous les thèmes effectivement retenus. Un nom de token devra décrire son rôle, pas une couleur, une technologie ou une marque. Le changement d'un token ne devra pas modifier silencieusement la signification d'un état.

## Marque, typographie et assets

Aucun logo, couleur, caractère typographique, illustration, icône ou autre asset visuel n'est déclaré officiel, approuvé ou clearé par ce document. Les maquettes utilisent des placeholders neutres ou des éléments dont la provenance et les droits sont documentés.

Le choix futur d'une police doit considérer licence, redistribution, confidentialité, performance, couverture linguistique et rendu de secours. Une ressource distante ne doit pas être chargée par défaut sans décision explicite.

Tout futur logo ou signe distinctif reste bloqué jusqu'à une décision séparée documentant sa provenance, les droits de publication et, lorsque nécessaire, la clearance du nom ou du signe. L'[avis non approuvé sur les marques](../TRADEMARKS.md) ne vaut ni preuve de propriété ou d'enregistrement, ni autorisation d'usage.

Une direction graphique ne doit pas suggérer certification, partenariat, niveau de service ou approbation d'un fournisseur. Les captures et données de démonstration restent synthétiques ou autorisées et expurgées.

## Preuves visuelles requises

Une interface n'est pas considérée comme réussie sur la seule base d'une maquette ou d'un composant isolé. La preuve attendue comprend, selon le périmètre :

- readback du rendu réel aux largeurs étroite, intermédiaire et large ;
- parcours clavier complet et inspection du focus ;
- lecture avec technologies d'assistance des états et actions critiques ;
- vérification du contraste, du zoom, du reflow et de la réduction du mouvement ;
- états vide, chargement, données périmées, accès refusé, erreur, attente humaine et ambiguïté ;
- graphes profonds, libellés longs, montants extrêmes et contenu partiellement disponible ;
- confirmation que les secrets et données sensibles restent absents des écrans, captures et traces de test ;
- comparaison entre la décision enregistrée et ce que l'interface affirme avoir accompli.

Les écarts découverts pendant cette vérification sont corrigés ou documentés comme limites. Aucun succès visuel, responsive, accessible ou opérationnel ne doit être revendiqué sans cette lecture du comportement rendu.

## Évolution de cette direction

Une modification éditoriale peut clarifier ces principes. Un changement qui altère une règle métier, l'autorité d'un agent, un contrat public ou la frontière self-host doit d'abord suivre les décisions d'architecture applicables. L'[index public](./README.md) reste le point d'entrée vers les documents effectivement destinés aux utilisateurs et contributeurs.
