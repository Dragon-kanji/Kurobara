# Repères d'usage responsable

## Statut de ce document

Cette page rassemble des pratiques volontaires pour concevoir et opérer des workflows Kurobara avec discernement. Elle ne constitue ni une condition d'utilisation, ni une politique contractuelle, ni une restriction de licence.

Kurobara est distribué sous la [licence Apache 2.0](./LICENSE). Les recommandations ci-dessous ne réduisent aucun droit accordé par cette licence et ne créent aucune interdiction par secteur, finalité ou catégorie d'utilisateur. Ne pas suivre une recommandation de cette page n'annule pas les droits Apache 2.0.

Les lois, autorisations et contrats applicables existent indépendamment de ce guide. Les conditions d'un service hébergé ou d'un fournisseur tiers, lorsqu'elles existent, ne deviennent pas des conditions du logiciel open source par renvoi à cette page.

## Autorité et intention

- Définissez l'objectif du workflow, son propriétaire et les systèmes qu'il peut toucher.
- N'utilisez que des comptes, données et services pour lesquels vous disposez d'une autorisation adaptée.
- Limitez chaque identifiant aux permissions et à la durée nécessaires.
- Séparez une démonstration, un environnement de test et une exécution sur des données réelles.
- Conservez une trace des choix importants afin qu'une autre personne puisse comprendre ce qui a été demandé et exécuté.

## Données et provenance

- Réduisez les données collectées à ce qui sert directement le résultat attendu.
- Fixez avant traitement les règles d'accès, de conservation, d'export et de suppression.
- Retirez secrets et données personnelles des logs, exemples, traces et rapports partagés.
- Associez les résultats à leur source, leur date, leur méthode d'obtention et leur niveau de confiance quand ces éléments influencent une décision.
- Ne transformez pas une inférence, une correspondance probabiliste ou une sortie de modèle en fait certain sans vérification proportionnée au risque.

## Workflows agentiques

Un agent doit recevoir une autorité bornée. Les limites utiles comprennent les capacités permises, les données accessibles, le budget, la concurrence, la date limite, le nombre de tentatives et les conditions d'arrêt.

Avant une action coûteuse, destructive, irréversible ou susceptible d'affecter une personne :

1. exposez l'action proposée et ses effets attendus ;
2. rendez l'incertitude et les données manquantes visibles ;
3. demandez une validation humaine lorsque le contexte l'exige ;
4. prévoyez une annulation, une compensation ou une procédure de reprise ;
5. enregistrez le résultat réel plutôt que de déduire le succès de la seule demande.

Les retries et reprises après incident peuvent répéter un effet externe. Utilisez des clés d'idempotence lorsque le fournisseur les prend en charge, détectez les résultats ambigus et évitez une relance automatique tant que l'état ne peut pas être réconcilié.

## Sécurité et exploitation

- Protégez et faites tourner les credentials selon leur sensibilité.
- Testez les erreurs, timeouts, annulations, limites de débit et épuisements de budget avant une utilisation importante.
- Prévoyez un moyen de suspendre le workflow sans perdre la preuve de ce qui a déjà été exécuté.
- Surveillez coûts, qualité, biais, erreurs répétitives et effets inattendus.
- Signalez une vulnérabilité selon [SECURITY.md](./SECURITY.md) sans publier de détail exploitable ou de donnée sensible.

## Personnes et décisions à fort impact

Pour une décision pouvant influencer l'accès à un emploi, un logement, un crédit, des soins, un droit, une éducation ou un service essentiel, augmentez le niveau de vérification et de supervision humaine. Donnez aux personnes concernées une explication exploitable et un moyen de demander une correction lorsque cela est pertinent.

Évaluez les erreurs asymétriques : un faux positif et un faux négatif n'ont souvent pas les mêmes conséquences. Mesurez la qualité sur des cas représentatifs et documentez les populations ou contextes qui restent mal couverts.

## Communauté

Cette guidance peut orienter les exemples, les choix par défaut et les revues de conception. Elle ne sert pas à retirer les droits accordés par la licence.

Les interactions entre participants relèvent du [code de conduite](./CODE_OF_CONDUCT.md). Une proposition qui voudrait imposer une nouvelle obligation au logiciel doit suivre la [gouvernance](./GOVERNANCE.md) et le [processus RFC](./docs/rfcs/README.md), avec une analyse explicite de sa compatibilité avec Apache 2.0.
