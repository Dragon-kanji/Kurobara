# Politique de sécurité

## Statut de pré-release

Kurobara est en pré-release. Aucune version, branche, image, archive ou distribution n'est déclarée comme bénéficiant d'un support de sécurité. La présence d'un fichier dans le dépôt ou d'une décision dans la documentation ne constitue pas une garantie de maintenance, de correction ou de compatibilité.

Cette politique explique comment reconnaître et préparer un signalement. Elle ne désigne actuellement aucun canal privé vérifié et ne promet aucun délai de réponse, d'analyse, de correction ou de publication.

## Périmètre des signalements

Un signalement peut concerner un défaut de sécurité observable dans une révision identifiable du code, de la configuration, de la chaîne de build, des dépendances ou des contrats de Kurobara. Les sujets pertinents comprennent notamment :

- un contournement d'authentification, d'autorisation ou d'isolation ;
- une exposition de secret, de donnée personnelle ou de contenu confidentiel ;
- une exécution de code, une injection, une requête sortante ou un accès fichier non prévu ;
- une faiblesse de chaîne d'approvisionnement ou une dépendance exploitable dans son usage par Kurobara ;
- une action agentique qui dépasse l'autorité, le budget ou le consentement accordés ;
- une altération de l'intégrité, de la provenance ou de la séparation entre espaces de travail.

Indiquez le commit et le composant concernés. Une hypothèse portant uniquement sur une architecture future n'est pas une vulnérabilité démontrée. Un défaut propre à un fournisseur, un fork, un hébergeur ou un système tiers doit être adressé à son responsable, sauf si l'intégration de Kurobara crée ou aggrave directement l'exposition.

Les erreurs non sensibles et les questions de fonctionnement relèvent de [l'assistance communautaire](./SUPPORT.md). Ne déplacez jamais un rapport de sécurité vers une discussion générale pour obtenir une réponse plus rapide.

## État du canal privé

[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) est le mécanisme envisagé pour un futur dépôt public. Il n'est pas présenté comme activé, accessible ou vérifié par cette politique. La présence de `SECURITY.md`, d'une page Security ou d'une interface GitHub ne suffit pas à prouver qu'un rapport privé atteindra une personne autorisée.

Tant que cette section ne nomme pas un canal ayant réussi un test complet côté reporter, ne transmettez aucun détail sensible au projet. Ne publiez pas une vulnérabilité dans une issue, une discussion, une pull request, un commit, un commentaire, un réseau social ou une demande d'assistance. Conservez les éléments en lieu sûr et consultez de nouveau cette politique lorsqu'un mécanisme vérifié aura été annoncé.

Si un canal communautaire général devient disponible, il peut servir uniquement à demander une méthode de communication privée. Cette demande ne doit révéler ni composant affecté, ni scénario, ni impact, ni preuve de concept.

## Préparer un rapport privé

Avant toute transmission par un futur canal vérifié, préparez les éléments applicables suivants :

- le commit exact, le composant et le mode d'exécution concernés ;
- les préconditions, les étapes minimales et le résultat observé ;
- l'impact plausible, les limites de votre analyse et ce qui demeure incertain ;
- une reproduction minimale utilisant des comptes et données de test autorisés ;
- les journaux, captures ou preuves strictement nécessaires, après expurgation ;
- l'existence éventuelle d'une exploitation active ou d'une divulgation antérieure ;
- votre préférence concernant le crédit public, y compris l'absence de crédit.

N'incluez pas de credential réel, de secret tiers, de donnée personnelle inutile, de dump complet ou de contenu obtenu hors de votre autorisation. Remplacez les valeurs sensibles par des marqueurs cohérents et expliquez uniquement leur rôle. Un lien signé, une métadonnée de fichier, une capture ou un nom d'archive peut également révéler une information confidentielle.

## Recherche et tests sûrs

Testez uniquement des systèmes, comptes et données que vous possédez ou pour lesquels vous avez une autorisation explicite. Utilisez l'environnement le moins exposé et l'accès minimal nécessaires pour confirmer le défaut.

Évitez notamment :

- la dégradation de service, la destruction ou modification de données et les coûts non autorisés ;
- la persistance, l'élévation d'accès au-delà de la preuve minimale et l'exfiltration ;
- l'ingénierie sociale, l'atteinte à la vie privée et l'accès à des comptes tiers ;
- le scan massif ou automatisé d'infrastructures sans accord ;
- l'exploitation d'un défaut après avoir obtenu une preuve suffisante.

Arrêtez le test si vous rencontrez des données réelles inattendues, si l'impact s'étend au-delà du périmètre autorisé ou si vous ne pouvez plus garantir la réversibilité. Les principes d'autorité bornée, de minimisation et de traçabilité de [RESPONSIBLE_USE.md](./RESPONSIBLE_USE.md) fournissent des repères complémentaires ; ils ne remplacent pas l'autorisation du propriétaire du système.

## Traitement attendu, sans engagement de service

Lorsqu'un canal privé aura été vérifié et qu'un rapport y sera effectivement reçu, le projet pourra tenter de :

1. limiter l'accès aux informations nécessaires à l'analyse ;
2. confirmer le périmètre et demander une reproduction plus sûre ou plus précise ;
3. évaluer l'impact sur une révision ou un artefact identifiable ;
4. préparer une correction, une mesure compensatoire ou une documentation de limite ;
5. coordonner les informations publiables avec la personne ayant signalé le défaut.

Cette séquence décrit une méthode souhaitée, pas un SLA. Elle ne garantit ni accusé de réception, ni qualification, ni correctif, ni release, ni embargo, ni attribution. La disponibilité des personnes capables d'analyser un rapport peut varier, particulièrement avant toute distribution publique.

## Divulgation coordonnée

Une divulgation publique doit éviter d'exposer inutilement des utilisateurs, secrets ou systèmes. Lorsqu'une communication privée est établie, les parties peuvent convenir du contenu publiable, des mesures de réduction du risque et du moment approprié. Aucun délai ou embargo n'est implicite sans accord explicite.

Une correction n'autorise pas automatiquement la publication de données obtenues pendant la recherche. Les preuves publiques doivent être minimisées et expurgées. Une exploitation active, une obligation légale ou un risque immédiat peut modifier l'approche ; ces circonstances doivent être signalées sans être amplifiées dans un canal public.

## Condition avant une ouverture publique

Avant d'annoncer une ouverture publique, le projet doit disposer d'un moyen privé de signalement qui a été testé depuis le point de vue d'un reporter. La vérification doit confirmer la soumission, la réception, les notifications, les permissions minimales, la continuité d'accès et une réponse de test sans donnée sensible.

Cette politique doit alors être mise à jour avec le mécanisme réellement vérifié, son périmètre et les limites applicables. Une simple configuration administrative, un bouton visible ou l'intention d'utiliser GitHub private vulnerability reporting ne suffit pas.
