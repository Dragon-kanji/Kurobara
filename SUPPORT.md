# Assistance communautaire

Ce document explique comment préparer une demande utile concernant Kurobara. Il ne désigne pas de canal de contact, n'annonce pas de version supportée et ne promet aucun service. Utilisez uniquement un moyen de contact effectivement indiqué et accessible dans le dépôt au moment de votre demande ; ne déduisez pas l'existence d'un issue tracker, d'une adresse électronique ou d'un espace de discussion à partir de cette page.

## Choisir le bon type de demande

### Question non sensible

Une question non sensible peut porter sur la documentation, une décision d'architecture, le processus de contribution ou le sens d'un comportement décrit. Indiquez le document ou le passage concerné et formulez l'ambiguïté précisément. Une décision, un backlog ou un exemple ne prouve pas qu'une fonctionnalité est disponible.

Une proposition qui modifie une politique, une interface publique, plusieurs sous-systèmes ou une décision difficile à inverser relève de la [gouvernance](./GOVERNANCE.md) et peut nécessiter un [RFC](./docs/rfcs/README.md), plutôt que d'être traitée comme une simple demande d'assistance.

### Demande d'aide reproductible

Une demande d'aide technique doit décrire un problème que quelqu'un d'autre peut raisonnablement tenter de reproduire. Réduisez le cas à la plus petite configuration sûre qui conserve l'échec. Distinguez les faits observés de vos hypothèses et précisez les changements locaux susceptibles d'influencer le résultat.

Une demande incomplète peut recevoir une demande d'informations supplémentaires. Les participants ne sont pas tenus d'exécuter du code non fiable, d'accéder à une infrastructure privée ou de reproduire un incident sur des données réelles.

### Vulnérabilité ou information sensible

Une faiblesse de sécurité suspectée, un secret exposé, un moyen de contourner une autorisation ou tout rapport contenant des détails exploitables doit suivre exclusivement [SECURITY.md](./SECURITY.md). Ne publiez pas ces éléments dans un canal général, une contribution, un log partagé ou une demande d'aide ordinaire.

Si aucun canal privé vérifié n'est disponible, suivez les instructions de `SECURITY.md` pour demander un moyen de communication sûr sans révéler la vulnérabilité. La présence d'une politique de sécurité ne prouve pas qu'un mécanisme hébergé particulier est actif.

## Informations minimales à fournir

Pour une question ou une demande d'aide non sensible, fournissez autant que possible :

- l'objectif recherché et la catégorie de la demande ;
- le chemin et la section de documentation concernés, le cas échéant ;
- la révision Git exacte utilisée et les modifications locales pertinentes ;
- le système d'exploitation, l'architecture, le mode d'exécution et les versions des outils impliqués ;
- les étapes minimales, dans l'ordre, avec les commandes déjà expurgées ;
- le résultat attendu, le résultat observé et le message d'erreur exact utile ;
- un exemple minimal fondé sur des données synthétiques ou dont le partage est autorisé ;
- les vérifications déjà effectuées et leurs résultats ;
- les limites de la reproduction, notamment ce qui n'a pas pu être testé.

Quand une configuration est nécessaire, indiquez les noms des options et les valeurs non sensibles qui influencent le problème. Remplacez toute valeur confidentielle par un marqueur explicite et cohérent afin que la structure reste compréhensible.

## Expurger avant de partager

Relisez le texte, les commandes, journaux, captures, archives et métadonnées avant tout partage. Retirez notamment :

- mots de passe, tokens, clés d'API, cookies, en-têtes d'autorisation et credentials fournisseur ;
- données personnelles, identifiants de comptes ou d'espaces de travail et contenus confidentiels ;
- prompts, résultats de fournisseur ou artefacts que vous n'êtes pas autorisé à redistribuer ;
- URLs signées, paramètres de requête sensibles, chemins personnels et variables d'environnement privées ;
- dumps, sauvegardes ou extraits de production non minimisés.

Une donnée masquée doit le rester dans toutes les représentations du même rapport. Vérifiez aussi les noms de fichiers, les propriétés d'une capture et les pièces jointes, pas seulement le texte visible. Les pratiques de minimisation, d'autorité bornée et de provenance proposées dans [RESPONSIBLE_USE.md](./RESPONSIBLE_USE.md) s'appliquent également à la préparation d'une reproduction.

## Limites du support communautaire

L'assistance communautaire dépend de la disponibilité et de l'intérêt volontaires des participants. Elle ne garantit ni réponse, ni délai, ni diagnostic, ni correctif, ni intégration d'une contribution. Une réponse communautaire ne crée pas une branche supportée, une promesse de compatibilité ou un engagement de maintenance.

La personne qui exploite Kurobara reste responsable de ses sauvegardes, autorisations, secrets, dépendances, coûts et procédures de reprise. N'utilisez pas une demande d'assistance comme autorisation pour tester un système, consulter des données ou effectuer une action hors de votre périmètre légitime.

Le logiciel open source et un éventuel service exploité par un tiers ont des responsabilités distinctes. Cette page ne décrit aucun support commercial ou managé et ne crée aucune obligation pour un fournisseur, un hébergeur, un mainteneur ou un contributeur.

Les échanges communautaires restent soumis au [code de conduite](./CODE_OF_CONDUCT.md). Les décisions de projet et l'autorité des rôles suivent [GOVERNANCE.md](./GOVERNANCE.md) ; une réponse d'assistance ne remplace pas une décision enregistrée selon ce processus.
