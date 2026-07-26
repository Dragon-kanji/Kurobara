# Kit local de conformité des plugins

- Statut : **profil de développement local expérimental**
- Package : `@kurobara/plugin-conformance@0.1.0`, privé et non publié
- Profil : `dev.kurobara.plugin-conformance/local-v1@1.1.0`
- Plateformes exactes : Node `24.14.0` sur `darwin/arm64` et `linux/x64`
- Publication : **aucune**

Cette tranche fournit un rapport machine-readable pour un artifact de plugin
identifié par le harness et exercé par le host sidecar local process-per-call.
Elle permet de relier un résultat au fingerprint déclaré de l'artifact, au
manifest, aux contrats, au SDK, au host, au profil et au runtime réellement
testés. Elle ne crée ni label public de compatibilité, ni runtime tiers de
production. Le rapport est un résultat de self-test, pas une attestation signée.

## Source canonique et matrice exacte

`PluginConformanceReport@1.0.0` appartient au catalogue JSON Schema canonique :

- catalogue `0.12.0`, 119 membres : 22 opérations, 61 schémas, 32 problèmes,
  1 événement et 3 règles de projection ;
- fingerprint du catalogue :
  `sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd` ;
- fingerprint du schéma de rapport :
  `sha256:16c0d9e715287fd820ce1a3d2a665f292cf3d29bcfb0ce312f010598f2da6a50`.

La matrice suivie dans
`packages/plugin-conformance/compatibility-matrix.v1.json` contient deux
combinaisons exactes : Node `24.14.0` sur `darwin/arm64` et `linux/x64`, avec
`@kurobara/contracts`, `@kurobara/plugin-sdk`, `@kurobara/plugin-host` et
`@kurobara/plugin-conformance` en `0.1.0`. Son fingerprint est
`sha256:4f0f6b375201f3b94f1458147b989c1aa9cd5858de63d4ffbd09eeb23e5e2b95`.
Toute autre combinaison échoue la
garantie `compatibility.exact-versions` ; aucune compatibilité implicite n'est
accordée à une autre architecture, plateforme ou version. Le profil exige
aussi que le sidecar utilise le même exécutable Node que le harness ; un autre
runtime enfant n'hérite pas du label Node `24.14.0` du processus parent.

## Rapport déterministe

Le rapport fermé contient :

- le fingerprint d'artifact fourni par le harness et les fingerprints calculés
  du manifest, du catalogue, du schéma de
  rapport, du profil et de sa matrice ;
- les versions exactes du package testé, de Node, des contrats, du SDK, du host,
  du kit et des deux API plugin ;
- une ligne par garantie avec `passed`, `failed` ou `not-applicable`, des reason
  codes fermés et des références de cas expurgées ;
- un résumé dont les compteurs sont recalculés et validés.

La sérialisation trie récursivement les clés, applique la représentation JSON
canonique retenue par le package et termine par un unique LF. Elle exclut les
timestamps, durées, chemins locaux, URLs, PID, stacks, messages bruts et
payloads. À artifact, profil, runtime et comportement identiques, deux passages
produisent les mêmes octets.

## Garanties du profil local

| ID | Observation locale |
| --- | --- |
| `compatibility.exact-versions` | Le tuple runtime parent/enfant, packages, API et catalogue correspond exactement à la matrice ; chaque contrat d'entrée/sortie est un membre exact de ce catalogue. |
| `manifest.schema-and-semantics` | Le manifest attendu est fermé, valide et accepté avant l'exercice fonctionnel. |
| `adapter.exact-surface` | Les appels de la surface fonctionnelle attendue répondent via le host et les contrats publics. |
| `protocol.closed-messages` | Les requêtes et résultats passent les contrats fermés du protocole et du framing. |
| `errors.closed-and-redacted` | `classifyError` retourne seulement la structure et les reason codes admis. |
| `timeouts.call-bound` | `execute` et `lookup` restent dans la borne minimale du manifest et du host local. |
| `execution.declared-delivery-semantics` | Un profil récupérable supporte deux `execute` sans second effet ; un profil one-shot n'est appelé qu'une fois. |
| `lookup.declared-reconciliation-no-effect` | Un lookup récupérable corrèle la même opération sans effet ; un profil one-shot retourne uniquement `outcome-unknown` sans invoquer le lookup de l'adapter. |
| `redaction.canary-absent` | Le canary synthétique injecté par `classifyError` n'apparaît pas dans le rapport ni dans les résultats observés. |

Ces garanties décrivent seulement les observations du profil exact. En
particulier, `execution.declared-delivery-semantics` ne promet pas une exécution
exactement une fois sur une API externe. Il vérifie la variante réellement
déclarée par le manifest, sans attribuer une garantie de redelivery au profil
one-shot.

## Sonde d'effet et template

Le harness possède une sonde d'effet temporaire, distincte du résultat retourné
par l'adapter. Le sidecar de template journalise l'`operationKey` dans un fichier
éphémère fourni par le harness. Le kit lit ce journal avant l'appel, après le
premier `execute`, après la redelivery lorsqu'elle est déclarée, et après chaque
`lookup`. Pour le profil one-shot `none/none`, il confirme un seul appel
`execute`, un seul effet, un résultat de lookup `outcome-unknown` et zéro appel
à l'implémentation `lookup` de l'adapter. Pour les profils récupérables,
l'idempotence est établie par un compteur d'effet externe à chaque processus
sidecar, pas par l'égalité de deux outputs. Lorsque `authoritativeNotFound` est déclaré,
un second `lookup` utilise un identifiant dérivé distinct et doit retourner une
absence autoritative sans modifier la sonde ; un adapter `always-found` échoue.

`templates/plugin-adapter` fournit un adapter synthétique compilable, son
sidecar et le wrapper `conformance.mjs`. Le wrapper exige un fingerprint
d'artifact SHA-256, un chemin de journal et un mode explicite. Il écrit un seul
rapport JSON sur stdout et réserve stderr aux erreurs d'invocation expurgées :

- code `0` : rapport valide avec résumé `passed` ;
- code `1` : rapport valide avec résumé `failed` ;
- code `2` : invocation invalide ou impossibilité de produire un rapport.

La preuve de packaging de référence se rejoue depuis la racine :

```sh
npm run test:plugin-packaging
```

Le test construit les packages, crée des tarballs locales, installe leur
fermeture en mode offline dans des répertoires temporaires, compile et package
le template comme projet extérieur, calcule lui-même le SHA-256 de cette
tarball, puis exécute son wrapper. Les chemins et journaux temporaires sont
supprimés à la fin.

## Limites et prochaines gates

Cette preuve est strictement `local-development-only` :

- aucun package n'est publié sur un registre et aucun label de compatibilité
  public n'est disponible ;
- aucun provider, credential, endpoint ou réseau réel n'est utilisé ;
- le host refuse un manifest demandant de l'egress, mais ne bloque pas
  techniquement l'accès réseau du processus ;
- aucune sandbox, isolation système, composition API/worker ou runtime tiers de
  production n'est qualifié ;
- aucune compatibilité hors `darwin/arm64` et `linux/x64` n'est annoncée ;
- l'API du runner valide la forme du fingerprint d'artifact mais ne recalcule
  pas seule les octets désignés : hors du test de packaging de référence, sa
  provenance reste une assertion du harness appelant ;
- le fingerprint du profil lie sa version et ses IDs de garantie, pas le code
  ni les vecteurs fournis par un harness tiers. Seul le test de packaging suivi
  dans ce dépôt prouve l'ensemble de vecteurs de référence de cette tranche ;
- la matrice d'adapters volontairement défectueux par classe, les tests egress
  et redirects, les blackholes/resets, le bridge durable et un smoke provider
  live expurgé restent à livrer.

`PLUGIN-002` reste donc **En cours**. Cette tranche qualifie le contrat de
rapport, le profil local, la matrice exacte, la sonde d'effet et le packaging du
template ; elle ne ferme pas la politique de compatibilité complète.
