# Contribuer à Kurobara

Ce guide décrit comment préparer une contribution vérifiable au projet. Il complète la [gouvernance](./GOVERNANCE.md), le [processus RFC](./docs/rfcs/README.md) et le [code de conduite](./CODE_OF_CONDUCT.md).

## Choisir le bon périmètre

Une contribution ordinaire doit poursuivre un résultat précis et rester aussi petite que possible. Évitez d'y mêler un renommage général, un reformatage ou un refactoring sans rapport.

Commencez par un RFC lorsque la proposition :

- crée ou casse un contrat public ;
- traverse plusieurs sous-systèmes ;
- modifie une garantie de sécurité, de données ou de compatibilité ;
- déplace une frontière entre kernel, adapters, applications ou service hébergé ;
- change la gouvernance, la licence ou le modèle de contribution ;
- introduit une décision difficile à annuler.

Une correction locale, une clarification ou un refactoring qui préserve les interfaces peut suivre directement ce guide. L'acceptation d'un RFC ne remplace pas l'implémentation, ses tests ou sa documentation.

Une vulnérabilité ou un rapport sensible ne doit pas être exposé dans une proposition publique. Suivez uniquement [SECURITY.md](./SECURITY.md).

## Préparer le changement

Travaillez depuis un checkout à jour sur une branche dédiée. Avant de proposer le changement :

1. définissez le comportement attendu et les éléments hors périmètre ;
2. identifiez les contrats, migrations, données et surfaces de sécurité affectés ;
3. ajoutez ou adaptez les tests proportionnellement au risque ;
4. mettez à jour la documentation lorsque le comportement, la configuration, les erreurs ou les limites changent ;
5. relisez le diff complet et retirez les fichiers accidentels, données sensibles et traces de debug ;
6. vérifiez que chaque commit reste compréhensible et cohérent avec son message.

Ne soumettez jamais de secret, credential, donnée personnelle inutile, dump, log non expurgé ou fixture dont l'usage n'est pas autorisé.

## Provenance

Vous devez pouvoir expliquer l'origine de tout code, texte, schéma, asset, fixture ou donnée ajouté au dépôt.

- Identifiez les auteurs et les sources externes utilisées.
- Conservez les mentions, licences et notices exigées par les éléments tiers.
- Ne copiez pas un exemple, un design ou une implémentation dont les droits de réutilisation ne sont pas établis.
- Signalez le contenu généré ou assisté par un outil lorsque cette information est nécessaire pour comprendre sa provenance.
- Pour un fichier régénéré, indiquez la source canonique et le mécanisme de génération.
- Si un employeur ou un contrat peut détenir les droits, obtenez l'autorisation nécessaire avant la soumission.

La présence d'une dépendance, d'une citation ou d'un lien ne prouve pas à elle seule le droit de redistribuer son contenu.

## Checks disponibles

Le manifest racine expose actuellement les checks suivants :

```bash
npm run check
npm run typecheck
npm run build
```

Exécutez ceux qui s'appliquent à votre changement et reportez la commande, son résultat et l'environnement utile. Si un check ne peut pas être exécuté, expliquez pourquoi et quelle zone reste non vérifiée.

Lorsqu'un package possède un check plus précis dans son propre manifest, utilisez-le également et reportez-le. N'affirmez pas qu'un test, une image, un déploiement ou une intégration fonctionne sans l'avoir vérifié sur la surface concernée.

## Commits et sign-off DCO

Kurobara utilise le [Developer Certificate of Origin 1.1](./DCO). Chaque commit proposé doit porter un trailer `Signed-off-by` correspondant à la personne qui effectue la certification. Utilisez l'option Git `-s` ou `--signoff` lors de la création du commit.

Avant de signer, lisez le DCO et assurez-vous de pouvoir certifier personnellement la provenance et le droit de soumettre la contribution sous la licence indiquée dans le dépôt. N'ajoutez pas le sign-off d'une autre personne sans chaîne de certification valide.

Le sign-off DCO :

- est une certification attachée au commit ;
- ne transfère pas automatiquement les droits d'auteur au projet ;
- n'est pas une signature cryptographique ;
- ne remplace pas la revue des licences et de la provenance.

Kurobara n'utilise pas de Contributor License Agreement en V1.

## Décrire la proposition

Une proposition doit permettre une revue sans deviner son intention. Décrivez :

- le problème et le résultat obtenu ;
- le périmètre et les non-objectifs ;
- les changements de comportement ou de contrat ;
- les risques de sécurité, confidentialité, compatibilité, migration et exploitation ;
- la provenance des éléments nouveaux ou repris ;
- les tests et checks exécutés, avec leurs résultats ;
- les vérifications non réalisées et les incertitudes restantes ;
- les mises à jour de documentation ;
- les RFC, ADR ou sujets reliés lorsque cela s'applique.

Les commits doivent rester focalisés, porter un message descriptif et inclure leur sign-off. Une pull request peut contenir plusieurs commits lorsque leur ordre aide la revue, mais chacun doit rester justifiable et vérifiable.

Ce document ne suppose pas l'existence d'un template de pull request, d'un bot DCO, d'un ruleset ou d'un autre contrôle hébergé. Les preuves demandées restent nécessaires même lorsqu'aucune automatisation ne les vérifie.

## Revue et décision

Les reviewers évaluent le comportement, les contrats, les risques, les preuves et la provenance. Ils peuvent demander une réduction de périmètre, des tests supplémentaires, une mise à jour documentaire ou un RFC.

Les mainteneurs prennent les décisions selon [GOVERNANCE.md](./GOVERNANCE.md). Une revue favorable ne promet ni intégration, ni release, ni support. Aucun délai de première réponse, de décision ou de publication n'est garanti.

Sauf disposition explicitement acceptée avant intégration, les contributions au produit sont destinées à être distribuées sous la [licence Apache 2.0](./LICENSE), conformément à la certification DCO applicable.
