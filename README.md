# Kurobara

Kurobara est un moteur open source headless pour produire ou enrichir des listes
B2B depuis des critères structurés ou un dataset, via CLI ou API. Un agent doit
pouvoir rechercher des entreprises et contacts, appliquer des recettes
versionnées par champ, suivre une exécution durable et récupérer un export où
chaque résultat conserve sa provenance, sa fraîcheur, sa confiance et son coût.

## Quickstart

La preuve locale complète ne consomme aucun crédit provider :

```sh
npm ci
npm run self-host:smoke
```

Elle construit la distribution, démarre la stack persistante, importe un
dataset synthétique, exécute une recette déterministe et vérifie son résultat
après redémarrage de PostgreSQL puis après un dump/restore réel. Le
[guide self-host](./docs/development/self-host-quickstart.md) couvre le
démarrage manuel, la CLI, le backup/restore et la construction d'un candidat
installable. Node.js `24.14.0`, npm `10.9.4` et Docker Compose v2 sont requis.

## Statut du projet

Kurobara est publié en **source preview V1 OSS headless** sous le tag
[`v0.1.0-rc.4`](https://github.com/Dragon-kanji/Kurobara/releases/tag/v0.1.0-rc.4).
Cette preview permet un clone anonyme et fournit des artifacts vérifiables ;
elle ne constitue ni une release stable, ni une publication npm ou OCI, ni un
service managé. Sur la révision courante, le
parcours dataset -> recette -> exécution durable -> export est pilotable sans UI
ni LLM par API, SDK TypeScript et CLI. Le worker peut composer Tavily et Exa,
sur ordre explicite de l'opérateur, derrière
`organizations.website.resolve@1.0.0`, Hunter Discover pour
`organizations.discover@1.0.0` et Prospeo Search Person pour
`contacts.discover@1.0.0`, uniquement lorsque les gates BYOK décrites ci-dessous
sont satisfaites. Prospeo Enrich Person compose ensuite
`contacts.identity.reveal@1.0.0` puis
`contacts.work-email.resolve@1.0.0` ; Hunter reste disponible pour la
vérification explicite et comme route alternative de résolution email. L'ordre
provider par défaut est `prospeo,hunter` ; Tavily, Exa et Apollo sont opt-in.
Exa exige en plus
`KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true`, uniquement après obtention de termes
écrits couvrant l'usage. Ce booléen est un contrôle fail-closed, pas une preuve
de droits. La présence d'un adapter
ou d'une clé ne constitue ni une admission contractuelle, ni un droit sur les
données ou marques du provider. La
[policy BYOK](./docs/policies/byok-provider-terms.md) fixe les décisions datées
et les conditions opérateur applicables. Hunter Finder n'est pas un waterfall
déclenché par un `NO_MATCH` ou `not_found` Prospeo : il est choisi comme route
initiale via un ordre provider explicite. Les générations Contact
actuelles autorisent une seule tentative provider et n'effectuent donc aucun
failover automatique, même après une indisponibilité retryable ; cette policy
reste un ticket séparé. Une issue ambiguë bloque toute nouvelle dépense.

Le [gate V1](./docs/development/v1-gate.md) sépare une preuve fixture sans réseau
et une qualification live explicitement autorisée. Le profil live relit dans
PostgreSQL les deux tentatives Tavily -> Exa, leur `operation_key` commune, leur
provenance de routage et leur règlement exact avant d'accepter le résultat et
son export déterministe après redémarrage. La commande d'annulation locale est
également disponible sur REST, SDK et CLI : un run en file converge
atomiquement vers `cancelled` et son replay exact retourne le même snapshot. Un
run actif passe d'abord à `cancelling`, puis le scheduler applique
`SettleCancellation` uniquement lorsque chaque effet et réservation possède une
preuve durable fermée ; la cellule liée converge alors atomiquement vers
`skipped`. Les effets préparés, réclamés, en vol ou ambigus maintiennent
l'annulation ouverte.

Les contrats restent `local-development-only` : catalogue `0.12.0` de 119
membres — 22 opérations, 61 schémas, 32 problèmes, 1 événement et 3 règles de
projection — fingerprint
`sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd`,
profil de conformité plugin `1.1.0` et matrice
`sha256:4f0f6b375201f3b94f1458147b989c1aa9cd5858de63d4ffbd09eeb23e5e2b95`.
Une [fondation exécutable](./docs/development/v1-foundation.md) documente
les preuves rejouables et leurs limites.

Le milestone V1 de sourcing sans CSV possède désormais un runtime de génération
paginée durable. Il checkpoint les pages, déduplique les records entre pages,
fige le provider après le premier commit, réapplique budgets, deadline et caps
avant chaque effet, puis converge vers `ready`, un échec terminal ou
`ambiguous`. PostgreSQL conserve les leases du scheduler, les compteurs, la
lineage, l'usage et les coûts ; un restart reprend depuis le dernier checkpoint
certain. Les mêmes opérations de recherche d'entreprises et de suivi de
génération sont projetées sur REST, le SDK TypeScript et la CLI non interactive.
Une génération `ready` expose désormais ses `CompanyCandidate` provider-neutral
par `GET /v1/dataset-generations/{generation_id}/company-candidates`,
`organizations.listCandidates()` et `company results`, avec pagination bornée
et permission `datasets:read`.

Un adapter Hunter Discover est composé uniquement lorsqu'une clé BYOK est
présente. Ses mappings, sa pagination et ses réponses hostiles sont testés hors
ligne. Le 22 juillet 2026, un appel live expurgé a qualifié sa première page :
la requête provider utilise la taille 100 et Kurobara applique ensuite le cap
local, y compris un succès à un seul candidat. La clé n'a jamais été journalisée
et aucun payload brut n'a été conservé. Cette preuve owner-only ne qualifie pas
la pagination Premium au-delà de la première page et ne confère aucun droit de
redistribution. Une matérialisation Contact `ready` est lisible sans rappeler le
provider via REST, `contacts.listCandidates()` et `contact results`. L'API et le
worker composent désormais `contact search` avec Prospeo lorsque
`PROSPEO_API_KEY` est présente. Chaque page durable groupe au plus dix
entreprises du snapshot dans une seule requête Search Person, respecte les caps
de deux contacts par entreprise et douze au total, expose une identité
explicitement `obfuscated` et ne projette ni email ni téléphone. Le `person_id`
Prospeo reste dans la lineage PostgreSQL restreinte, jamais dans le record
public. `enrich_mobile` est toujours forcé à `false`.

Les tests offline, la composition durable et une verticale live locale bornée
sont qualifiés. Le 22 juillet 2026, le harness de dogfood a traversé réellement
CLI -> API -> PostgreSQL -> Hatchet -> Hunter Discover -> Prospeo Search Person
-> Prospeo Enrich Person -> export CSV privé. Il a matérialisé 3 entreprises,
2 contacts masqués et 1 email professionnel `found-and-valid`, avec un maximum
de 4 requêtes provider, puis a supprimé l'export, les données personnelles
temporaires et l'infrastructure éphémère. Aucun secret, identifiant ou contact
n'est présent dans son rapport machine-readable. Prospeo Search demande
explicitement la disponibilité d'un email vérifié selon ses
[filtres documentés](https://prospeo.io/api-docs/filters-documentation) ; toute
ligne brute qui contient malgré cela une coordonnée révélée est mise en
quarantaine et abandonnée avant normalisation ou persistance. Cette preuve ne
garantit ni les crédits futurs ni des droits de redistribution provider. Le
probe Apollo `403` reste historique et Apollo est opt-in, hors du chemin par
défaut.

La verticale métier locale matérialise maintenant des datasets dérivés pour une
sélection exacte de contacts : révélation d'identité professionnelle puis
résolution d'email professionnel vérifié par Prospeo Enrich Person, et
vérification explicite par Hunter. Hunter Finder existe comme route de recovery
bornée, pas comme deuxième appel automatique après une absence de résultat
Prospeo. La verticale est exposée par REST, SDK TypeScript et CLI via
`contact reveal-identity`, `contact enrich-email` et `contact verify-email`.
L'opérateur ou l'agent lit `work_email_verification` après la résolution et
décide s'il lance la vérification ; le serveur ne la déclenche ni ne la saute
automatiquement. L'export générique `dataset export` restitue le dataset final en
CSV ou JSONL déterministe et exige `datasets:export` ainsi que `contacts:export`
pour un dataset Contact. La décision de conception et ses invariants sont fixés
par [RFC-0011](./docs/rfcs/0011-selected-contact-derived-datasets.md). La
révision locale qualifie pour les datasets Contact générés un registre v2, un
TTL, un reçu, une lecture/révocation owner-only et une restriction sujet
atomique selon
[RFC-0012](./docs/rfcs/0012-contact-export-delivery-lifecycle.md). Cette tranche
reste locale : elle n'est ni une release ni une preuve de droits provider.

Ces routes sélectionnées ne sont composées que lorsque la clé du provider et un
secret stable d'au moins 32 octets sont présents. La révision locale accepte
soit un keyring HMAC JSON multi-version, soit les variables legacy
`KUROBARA_CONTACT_PRIVACY_HMAC_SECRET` et sa version ; ces modes ne se combinent
pas. La révélation d'identité Prospeo peut recevoir un email incident dans la
réponse provider : l'adapter le supprime à cette frontière. Cet appel peut
néanmoins consommer le crédit email du provider. Prospeo documente un
ré-enrichissement gratuit de la même personne pendant 90 jours ; Kurobara ne le
garantit pas et son ledger réserve actuellement des `requests`, pas un devis de
crédits Prospeo exact. Les tombstones Contact sont contrôlés en preflight puis
juste avant l'effet provider ; l'export refait les contrôles avant et pendant le
stream. Le registre v2, les transports, le keyring multi-version et un
dump/restore avec readback sont qualifiés localement. Le retrait d'une ancienne
clé et toute future lecture Contact restent à qualifier avant exposition. Le gate
fixture `npm run test:v1-business-gate` exerce directement les adapters Hunter
et Prospeo ainsi que les codecs CSV/JSONL avec des données synthétiques, sans
réseau. Il ne traverse pas à lui seul l'application, PostgreSQL, le worker,
HTTP, le SDK ou la CLI. Le test séparé
[`test/integration/http-sdk-dataset-export.test.ts`](./test/integration/http-sdk-dataset-export.test.ts)
fait consommer le vrai handler HTTP d'export chunké par le SDK ; les autres
couches restent qualifiées par leurs suites ciblées. La preuve live complète
est reproductible séparément, avec confirmation explicite des appels
facturables :

```bash
npm run b2b:dogfood:preflight
npm run b2b:dogfood -- run --confirm-provider-calls
```

Le preflight n'appelle aucun provider. Le run reste borné à 3 entreprises,
3 contacts et 4 requêtes provider, puis nettoie son CSV privé et son runtime
éphémère. Cette preuve provider est distincte des tests du registre durable
ajouté ensuite ; aucune des deux ne constitue une publication ou une garantie
de production.

Ce statut ne constitue pas une release publique. Le dépôt construit des
bundles, un tarball CLI, des SBOMs et des images locales de qualification, mais
aucun package, image, endpoint hébergé ou déploiement de production n'est
publié. Le
[runbook sourcing](./docs/development/company-sourcing-api-cli.md) distingue les
preuves fixture, le démarrage local et le probe provider live explicitement
autorisé. La compatibilité Claude Code reste optionnelle et non qualifiée ;
provenance de release, licences et conditions de distribution des providers
restent des gates séparées.

Le [premier vertical dataset-first](./docs/development/headless-enrichment-slice.md)
fixe les primitives locales et le parcours de référence domaine vers site
officiel. Les codecs, use cases d'import/export et leur stockage PostgreSQL sont
présents localement, bornés et isolés par l'identité workspace d'une clé API
vérifiée. La révision locale persiste aussi les recettes et applications
exactes, crée un `Run` canonique par cellule à calculer, fait converger son
`CellResult`, réutilise uniquement les succès explicitement frais et projette
l'application exacte dans l'export. L'import initial et une passe agrégée
d'application de recette sont maintenant exposés localement par les mêmes
opérations expérimentales via API, SDK TypeScript et CLI. `recipe apply`
enregistre l'intention, valide et quote l'input exact puis crée les runs de
cellule de façon reprenable ; il ne les exécute pas dans la requête. Une lecture
durable de l'application est également disponible par API et SDK ; `recipe
watch` la poll avec un timeout client explicite et reprend après redémarrage à
partir de PostgreSQL. Un [export direct d'application](./docs/development/recipe-application-export.md)
projette maintenant ses résultats exacts en CSV ou JSONL via API, SDK et CLI,
avec prévalidation de la taille et du hash puis streaming. Il ne crée ni
artifact ni identité d'export durable. SSE, lifecycle durable des exports
génériques ou de recette, stockage géré de secrets et sandbox de plugins non
fiables restent à livrer ; aucun package ou endpoint n'est publié.

Le graphe suivi ne contient plus l'application historique. L'API, le worker V1,
les couches métier, les contrats et leurs adapters restent exécutables ; le SDK
et la CLI couvrent import, apply, watch, export direct, annulation de run,
recherche d'entreprises et de contacts, observation d'une génération, lecture
paginée de ses candidats prêts, révélation d'identité sélectionnée, résolution
et vérification d'email professionnel, puis export du dataset dérivé. Console et
serveur MCP restent différés ; ces surfaces opérateur locales ne constituent ni
une publication de packages ni un service hébergé.

## Vision V1

La V1 recherchée doit permettre à un opérateur ou un coding agent de contrôler
depuis son propre environnement le parcours dataset → recette → run → export :
import JSONL/CSV, configuration de providers BYOK, estimation, lancement,
observation, reprise, annulation et récupération des résultats.

Cette cible repose sur les engagements de conception suivants :

- **Open source utile** : le moteur, les contrats, les extensions et les interfaces nécessaires au self-host appartiennent au produit public.
- **Self-host sans compte imposé** : aucune connexion à un service Kurobara ne doit être nécessaire pour exécuter le cœur de la V1.
- **Contrats communs** : l'API HTTP, le SDK TypeScript et la CLI projettent les mêmes commandes, états et erreurs ; MCP en dérive lorsqu'il est livré.
- **Providers remplaçables** : les intégrations BYOK doivent rester derrière des ports et annoncer leurs capacités, contraintes et modèles de coût.
- **Exécution durable** : budgets, idempotence, retries, résultats ambigus, annulation et réconciliation doivent être représentés dans le modèle métier.
- **Décisions explicables** : un choix de provider ou un fallback doit laisser une trace versionnée et interprétable.
- **Provenance observable** : un résultat doit pouvoir être relié à ses entrées, ses étapes, ses artifacts et ses dépenses.

Pour les providers de recherche d'entreprises et de contacts, BYOK signifie que
chaque opérateur fournit son compte, sa clé, son plan et ses quotas. Le dépôt
open source fournit les adapters et les garde-fous techniques ; chaque
utilisateur reste responsable de l'usage de ses données et de son provider.
Hunter est la route locale de recherche d'entreprises. Prospeo est la route
BYOK principale de shortlist, de révélation d'identité et de résolution d'email
professionnel ; Hunter reste le verifier et une route email alternative sur
choix d'ordre explicite, jamais un basculement automatique après indisponibilité
ou sur le seul `not_found` Prospeo. Ces capacités sont composées localement
seulement avec leurs clés BYOK et le secret privacy HMAC. Hunter Discover et le
parcours Prospeo shortlist -> identité -> email sont qualifiés dans la verticale
live locale bornée décrite ci-dessus. Hunter Finder et Verifier ne sont pas
nécessaires au chemin métier de base et ne sont pas qualifiés live. Apollo
reste opt-in et hors ordre par défaut après son `403` ; PDL reste un candidat
offline non composé. Hunter Domain Search n'est pas utilisé pour la shortlist
car il révèle déjà des emails.

Ces points restent les engagements de conception. Le statut démontré du
candidat local et ses limites sont décrits séparément ci-dessus.

## Agentique, avec une autorité bornée

Kurobara est conçu pour servir des humains, des applications et des agents sans donner à un modèle un accès direct et illimité au système.

Dans la cible :

- un modèle peut proposer une intention ou un plan, mais les schémas, permissions, policies et budgets décident de ce qui est autorisé ;
- chaque outil et chaque effet externe possède une entrée validée, une identité et une limite d'exécution ;
- une future extension HITL pourra imposer un signal humain typé aux actions sensibles ;
- l'arrêt, l'expiration et l'annulation font partie du cycle de vie ;
- les secrets et données sensibles ne doivent pas devenir de la télémétrie par défaut.

Le multi-agent est envisagé comme un graphe de rôles et de sous-runs, pas comme une conversation autonome sans limite. Une délégation doit réduire les permissions disponibles, réserver une part du budget parent, borner profondeur et fan-out, puis retourner un résultat conforme à un contrat explicite. Cette capacité reste soumise aux mêmes preuves de sécurité, de reprise et de coût que tout autre workflow.

## Direction d'architecture

La conception sépare le domaine, les use cases et l'infrastructure :

```text
contrats
   ↑
application et policies
   ↑
kernel et compilation de workflows
   ↑
ports
   ↑
adapters de stockage, orchestration, providers, HTTP et clients
```

Le kernel cible ne dépend d'aucun framework, runtime d'orchestration, fournisseur ou base de données. PostgreSQL doit conserver l'état métier durable tandis que l'orchestrateur reste un détail d'exécution derrière un port. Les contrats publics doivent partir d'une source canonique et générer leurs projections au lieu d'être recopiés entre interfaces.

Un éventuel service managé est un consommateur du produit public. Il ne doit pas devenir une dépendance du kernel, du self-host ou des contrats ouverts.

La description complète se trouve dans [l'architecture V1 OSS agentique](./docs/architecture/v1-oss-agentic.md).

## Décisions et feuille de route

- [Index de la documentation](./docs/README.md)
- [Roadmap publique V1](./ROADMAP.md)
- [Architecture V1 OSS agentique](./docs/architecture/v1-oss-agentic.md)
- [Modèle d’autorité agentique](./docs/architecture/agent-authority.md)
- [Frontières et hypothèses de sécurité](./docs/architecture/security-boundaries.md)
- [ADR-0001 : frontière entre cœur public et service managé](./docs/adr/0001-open-source-product-boundary.md)
- [ADR-0002 : socle d'exécution durable](./docs/adr/0002-durable-agentic-runtime.md)
- [ADR-0003 : contrats et protocoles agentiques](./docs/adr/0003-contracts-and-agent-protocols.md)
- [ADR-0005 : gate V1 dataset-first et headless](./docs/adr/0005-dataset-first-headless-v1.md)
- [Direction d'expérience et d'interface](./docs/plan-marque-ui.md)

Une décision de conception n'est pas une preuve de livraison. L'état pré-release ne change que lorsque les critères concernés sont exécutés sur une révision et des artifacts identifiables.

## Participer

Le [guide de contribution](./CONTRIBUTING.md) décrit le périmètre, la provenance, les checks et le sign-off DCO attendus. Les changements structurants passent par la [gouvernance](./GOVERNANCE.md) et le [processus RFC](./docs/rfcs/README.md). Les échanges communautaires suivent le [code de conduite](./CODE_OF_CONDUCT.md).

Pour préparer une demande non sensible, consultez [l'assistance communautaire](./SUPPORT.md). Une vulnérabilité ou une information exploitable doit suivre exclusivement la [politique de sécurité](./SECURITY.md) et ne doit pas être publiée dans une discussion générale.

Les [repères d'usage responsable](./RESPONSIBLE_USE.md) proposent des pratiques volontaires pour les workflows et agents. Ils n'ajoutent aucune restriction à la licence du logiciel.

## Licence

Le code et la documentation du projet sont destinés à être distribués sous [Apache License 2.0](./LICENSE), sous réserve des droits, notices et attributions applicables à chaque élément incorporé. Les contributions suivent le [Developer Certificate of Origin 1.1](./DCO) tel que décrit dans le guide de contribution.

Ce README ne constitue ni un avis juridique, ni une certification, ni une déclaration de conformité.
