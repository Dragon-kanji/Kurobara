# Frontières de sécurité de la fondation V1

- Statut : **registre repo-grounded pré-threat-model**
- Date de mise à jour : **2026-07-22**
- Périmètre : **arbre V1 courant, exécution locale et fixtures de qualification**
- Hors preuve : **déploiement public, admission provider de production,
  console, MCP exécutable et production**

Ce document décrit les frontières réellement visibles dans le code courant et
les validations encore nécessaires. Il ne constitue ni un threat model final,
ni une certification, ni une preuve qu'un déploiement public est sûr.

## Périmètre observé

Le graphe exécutable comprend :

| Composant | Responsabilité observable | Source principale |
| --- | --- | --- |
| API Node | Probes locales, authentification bearer, validation des contrats, import, recettes, runs, planification/lecture/annulation des générations company/contact et lecture de leurs candidats matérialisés | `apps/api`, `packages/adapters/http` |
| Worker Node | Exécution Hatchet, dispatch de l'outbox, réconciliation et scheduler paginé de génération sous lease | `apps/worker` |
| Application | Use cases, autorité, policy, idempotence, dispatch et réconciliation sans I/O direct | `packages/application` |
| Kernel | Invariants de workflow, plan, run, état, budget, deadline et ambiguïté | `packages/kernel` |
| PostgreSQL | État métier durable, datasets, générations/pages, lineage provider Contact restreinte, recettes, applications, clés API, snapshots, runs, outbox, leases, tombstones et registre interne d'exports | `packages/adapters/postgres` |
| Hatchet | Mécanisme d'orchestration derrière un port remplaçable | `packages/adapters/orchestration-hatchet` |
| Contrats | JSON Schema canonique et projections générées | `packages/contracts/catalog` |
| SDK plugin | Validation provider-neutral des manifests, messages, frames et outcomes | `packages/plugin-sdk` |
| Host sidecar local | Admission et transport process-per-call du mode développeur non fiable | `packages/plugin-host` |
| Kit de conformité local | Rapport fermé et sonde d'effet éphémère pour un profil exact, sans autorité de production | `packages/plugin-conformance` |
| Adapters providers maintenus par Kurobara | Routes BYOK Tavily et Exa, Hunter Discover/Finder/Verifier, Prospeo Search Person/Enrich Person, Apollo opt-in, candidat PDL Contact hors ligne et fixture Contact déterministe derrière les ports provider-neutral | `packages/adapters/provider-tavily`, `packages/adapters/provider-exa`, `packages/adapters/provider-hunter`, `packages/adapters/provider-prospeo`, `packages/adapters/provider-apollo`, `packages/adapters/provider-pdl`, `packages/adapters/provider-fixture`, `packages/adapters/effect-plugin` |

Aucun site, portail utilisateur, Worker Cloudflare ni serveur MCP exécutable
n'appartient au graphe courant. Tavily et Exa appartiennent au chemin local
d'effets BYOK déjà qualifié. Hunter couvre la recherche d'entreprises et l'email
sélectionné ; seule sa première page de recherche company a aussi été qualifiée
par un probe BYOK live expurgé. Domain Search reste explicitement inadmissible
pour la shortlist.

Prospeo est la route principale de `contacts.discover@1.0.0`,
`contacts.identity.reveal@1.0.0` et
`contacts.work-email.resolve@1.0.0`. Elle est activée par `PROSPEO_API_KEY`,
groupe au plus dix entreprises du snapshot dans une requête par page durable,
puis projette une identité `obfuscated` sans email ni téléphone. Le `person_id`
n'apparaît que dans la lineage PostgreSQL restreinte. Enrich Person relit ce
sujet pour l'identité puis l'email professionnel et force toujours
`enrich_mobile=false`.

Une réponse d'identité peut contenir un email incident. L'adapter le supprime
avant la projection, mais cette minimisation n'annule pas nécessairement le
crédit facturé par Prospeo. Le ré-enrichissement gratuit pendant 90 jours est
une propriété documentée du provider, pas une garantie de replay Kurobara. Les
réservations internes restent en `requests`, sans prétendre refléter un devis ou
un reçu Prospeo exact.

L'implémentation est qualifiée hors ligne. Un probe live expurgé borné à un
sujet a confirmé Search Person sans coordonnées, sa répétition gratuite, puis
Enrich Person avec identité complète, email professionnel vérifié et aucun
mobile. Aucun secret, identifiant ou contact n'a été conservé. Hunter fournit la
recherche company et la vérification. Sa route Finder pour une lineage Prospeo
est une route initiale alternative choisie par ordre explicite. Le plan Contact
actuel n'autorise qu'une tentative : aucune indisponibilité ni
`NO_MATCH`/`not_found` Prospeo ne déclenche un basculement.
Apollo reste opt-in hors de l'ordre par défaut après son probe `403`. PDL reste
un candidat Contact offline,
absent des routes actives. Le SDK HTTP et la CLI couvrent les opérations Contact
sans accès direct à PostgreSQL.

## Frontières de confiance

### Client vers API locale

L'API écoute sur loopback par défaut. Une écoute non-loopback exige une option
explicite. Les routes métier exigent un bearer API key ; les probes de santé
restent publiques.

À la frontière HTTP :

- le header d'autorisation et le corps ont des limites explicites ;
- le media type JSON est imposé pour les opérations concernées ;
- les entrées et sorties sont validées contre les schémas canoniques ;
- les erreurs publiques utilisent le registre RFC 9457 généré ;
- les erreurs internes sont expurgées avant la réponse ;
- l'acteur, le workspace et les permissions proviennent de l'authentification,
  pas du corps de la requête.

Le bind loopback n'apporte ni TLS, ni protection réseau, ni authentification
forte lorsqu'un opérateur choisit volontairement une exposition distante. Cette
exposition reste hors qualification.

### API et worker vers PostgreSQL

PostgreSQL est la source de vérité durable. Les opérations critiques regroupent
dans une transaction les écritures qui ne doivent pas diverger : plan et
provenance, run et événement initial, consommation du plan et outbox, ou
règlement terminal et dead-letter.

Les lectures et règlements métier sont portés par un workspace explicite. Les
claims système peuvent sélectionner globalement du travail, mais leur résultat
doit être réglé dans le workspace exact du claim avec une lease fenced.

Les risques encore ouverts concernent notamment la topologie de déploiement,
les rôles PostgreSQL, TLS, sauvegarde/restauration, rotation des credentials,
rétention et validation d'un upgrade/rollback réel.

### Worker vers Hatchet

Hatchet est un adapter, pas une autorité métier. Le domaine et les contrats
publics ne transportent aucun type ou identifiant Hatchet.

Avant un start externe, Kurobara persiste une identité stable et l'état
`starting`. Un timeout ou un résultat inconnu déclenche uniquement un lookup
exact puis une réconciliation ; il ne permet pas un second start aveugle. Les
lookups possèdent une borne de temps applicative et une borne de transport.

La fixture locale Hatchet est loopback et auth-disabled. Elle prouve le candidat
d'intégration et un redémarrage propre dans le TTL, pas la sécurité d'une
topologie de référence, d'un crash non propre ou d'une production.

### Contrats générés vers surfaces publiques

Le catalogue JSON Schema est la source canonique. OpenAPI, TypeScript, MCP,
manifestes et fingerprints sont des outputs générés et contrôlés contre le
drift. La racine du package de contrats n'expose plus de contrat historique.

Les identifiants utilisent encore un namespace `.invalid` local. Aucun
artifact ne doit être annoncé comme contrat public stable avant contrôle du
namespace, qualification du dialecte, règles de compatibilité et gate de
publication.

### Host local vers processus sidecar

Le host `development-untrusted` reçoit un exécutable et un répertoire absolus
ainsi qu'un manifest attendu fourni par une configuration de confiance. Il
valide ce manifest avant spawn, refuse tout mode d'authentification autre que
`none` et toute liste d'egress non vide, puis compare le `describe` renvoyé par
un premier processus. Chaque appel
suivant démarre un nouveau processus avec `shell: false`, un environnement vide
et un seul échange JSON-RPC 2.0 sur `stdio`. Taille, UTF-8, LF, identifiant,
méthode, délai et arrêt direct sont bornés ; `stderr` est drainé sans être rendu
au client. Une rupture d'`execute` ou de `lookup` après dispatch converge vers
`outcome-unknown` via le SDK.

Cette admission ne sandboxe pas le binaire. En particulier, refuser un manifest
demandant de l'egress ne bloque pas techniquement le réseau, le filesystem, le
CPU, la mémoire ou les descendants du processus. Le host n'est composé ni dans
l'API ni dans le worker et ne qualifie aucune exécution tierce en production.

### Kit de conformité vers sidecar local

Le profil `dev.kurobara.plugin-conformance/local-v1` exerce le host avec des
fixtures synthétiques et observe l'effet dans un journal temporaire distinct du
résultat de l'adapter. Son rapport canonique ne conserve ni payload, message
brut, chemin local, PID, stack, timestamp ou durée. Un canary synthétique doit
rester absent des résultats observés et du rapport.

Cette sonde ne constitue ni une sandbox, ni un contrôle réseau, ni une preuve
d'exactly-once sur une API externe. La matrice exacte couvre Node `24.14.0` sur
`darwin/arm64` et `linux/x64`, avec le même exécutable pour harness et sidecar ;
le kit n'est composé dans aucun runtime. Le fingerprint d'artifact est une
assertion du harness : seule la preuve de packaging suivie le calcule directement
sur la tarball de référence. Le rapport n'est ni signé, ni une attestation de
provenance autonome.

### Worker vers providers BYOK via les adapters maintenus

L'API compose uniquement les routes et capabilities annoncées ; le worker
compose Tavily/Exa, Hunter et Prospeo derrière leurs ports provider-neutral.
Apollo n'est composé que lorsqu'il est explicitement demandé dans l'ordre des
providers. Exa reste fermé sans l'ordre explicite, sa clé et
`KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true` ; cette attestation opérateur ne
prouve pas l'accord écrit qu'elle déclare. Les credentials viennent de la
configuration du processus, ne sont
ni placés dans
le plan, ni persistés dans les records ou artifacts, et ne doivent jamais être
rendus par une erreur. Délai, taille, nombre d'appels et parsing des réponses
sont bornés à la frontière de chaque adapter. Pour Prospeo, caps entreprises,
contacts, pages, appels et budget sont revalidés avant effet ; l'employeur
courant doit correspondre exactement, les coordonnées de Search Person ne sont
pas projetées et `enrich_mobile=false` est imposé sur chaque enrichissement.

Les routes de recherche externes ne fournissent pas d'idempotence ou de lookup
provider autoritatif pour un timeout de page. Une coupure après envoi reste donc
`outcome-unknown` et interdit retry ou fallback aveugle. Cette intégration locale
prouve le lifecycle Kurobara ;
elle ne prouve ni egress forcé par sandbox, ni DPA, rétention, résidence,
suppression, droits de redistribution ou admission de production.

## Actifs à protéger

- credentials API et PostgreSQL ;
- token et endpoints Hatchet ;
- identité de l'acteur, workspace et enveloppe d'autorité ;
- workflows, policies, pricing et plans immuables ;
- runs, événements, commandes, outbox et bindings d'orchestration ;
- budget, coût réservé ou dépensé et provenance ;
- payloads providers, résultats et artifacts ;
- curseurs, identifiants externes, receipts et lineage restreinte des
  générations de datasets, dont les sujets Prospeo ou Apollo jamais projetés
  publiquement ;
- logs, erreurs et diagnostics susceptibles de contenir des identifiants.

Les exemples suivis utilisent des valeurs synthétiques. Aucun secret réel,
payload provider ou donnée personnelle ne doit entrer dans Git, les fixtures ou
la documentation.

## Contrôles démontrés

- configuration obligatoire et validée pour PostgreSQL et Hatchet ;
- refus par défaut d'une écoute API non-loopback ;
- authentication API key liée à l'acteur, au workspace et aux permissions ;
- non-divulgation d'une ressource située dans un autre workspace ;
- lecture d'application de recette protégée par `recipes:read`, avec le même
  `recipe-application-not-found` pour une identité absente ou étrangère ;
- autorité bornée par permissions, capabilities, budget, deadline et expiration ;
- idempotence de création des runs et preuve durable de redelivery ;
- outbox avec leases fenced, retries bornés et dead-letter ;
- réconciliation sans redémarrage aveugle après résultat ambigu ;
- validation contractuelle des entrées, sorties et erreurs publiques ;
- arrêt borné et cleanup des processus après panne tardive.

Ces contrôles sont couverts par des tests locaux. Ils ne prouvent pas leur
configuration correcte dans un environnement encore inexistant.

## Gates de sécurité ouvertes

| Gate | État restant |
| --- | --- |
| Threat model | Classer scénarios, vraisemblance et impact ; affecter owners et mitigations. |
| Auth distante | Définir TLS, proxy de confiance, rotation/révocation et lifecycle self-service des clés. |
| Isolation | Qualifier rôles DB, contraintes, backup/restore et tests adversariaux multi-workspace. |
| Hatchet | Qualifier auth, crash non propre, redémarrage PostgreSQL, TTL, upgrade et rollback. |
| Providers | Qualifier chaque nouvelle capability et toute admission tierce ou de production : conformité réseau, secrets, egress réellement appliqué, DPA, rétention, suppression, redistribution et readback de facturation. |
| Observabilité | Prouver redaction, cardinalité, rétention et absence de secrets ou payloads bruts. |
| Supply chain | Résoudre les advisories applicables, produire SBOMs et inspecter les artifacts exacts. |
| Publication | Rejouer scans, provenance, licence et contrôles GitHub sur le candidat exact. |

## Scénarios prioritaires à tester

1. clé absente, invalide, expirée ou révoquée sans révélation d'identité ;
2. acteur valide visant un autre workspace ou une autre autorité ;
3. requête trop grande, JSON hostile ou sortie interne hors contrat ;
4. crash entre commit PostgreSQL et appel Hatchet ;
5. start Hatchet accepté mais réponse perdue ;
6. expiration de lease pendant un lookup ou un règlement ;
7. arrêt du worker avec dispatch ou réconciliation en vol ;
8. restauration PostgreSQL suivie d'une reprise sans double effet ;
9. configuration non-loopback sans opt-in explicite ;
10. erreur interne contenant un secret synthétique, vérifiée expurgée à chaque
    frontière publique et observable.

## Chemins de revue

- `apps/api/src/config.ts`, `service.ts` et `process.ts`
- `apps/worker/src/config.ts`, `service.ts` et les services de polling
- `packages/adapters/http/src/index.ts`
- `packages/adapters/postgres/src` et `migrations`
- `packages/adapters/orchestration-hatchet/src`
- `packages/application/src`
- `packages/kernel/src`
- `packages/contracts/catalog`
- `packages/plugin-sdk`
- `packages/plugin-host`
- `packages/plugin-conformance`
- `test/plugin-packaging`
- `test/plugin-conformance-packaging`
- `infra/hatchet`

## Références

- [Architecture V1 OSS agentique](./v1-oss-agentic.md)
- [Frontières du monolithe modulaire](./module-boundaries.md)
- [Modèle d'autorité agentique](./agent-authority.md)
- [ADR-0002 — runtime durable](../adr/0002-durable-agentic-runtime.md)
- [Politique de sécurité](../../SECURITY.md)
