# Changelog

Les changements notables de Kurobara sont consignés ici. Le projet suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et adoptera SemVer à
partir de sa première publication.

## [Unreleased]

## [0.1.0-rc.6] - 2026-07-26

### Changed

- Met à jour `@hono/node-server` vers `2.0.12`, Hono vers `4.12.32`,
  Postgres.js vers `3.4.9` et le SDK TypeScript Hatchet vers `1.28.0`.
- Regroupe les futures mises à jour Dependabot mineures et correctives par
  type de dépendance, et reporte TypeScript 7 tant que la chaîne
  d'architecture épinglée ne le prend pas en charge.

### Fixed

- Accepte le trailer DCO standard de Dependabot uniquement pour l'identité bot
  exacte, une branche Dependabot du dépôt et le workflow de base approuvé.
- Verrouille `brace-expansion` sur `5.0.8` et remplace le `node-gyp` transitif
  de la génération SBOM par sa branche 12 compatible, puis étend la CI à
  l'audit du graphe complet, dépendances de développement incluses.
- Remplace les quatre motifs signalés par CodeQL par des arguments de processus
  séparés, une validation JSONL structurée et un encodage de PURL complet.
- Ajoute au reçu d'échec du gate public le code de raison borné du fixture,
  sans publier ses logs, chemins ou autres données internes.

## [0.1.0-rc.5] - 2026-07-26

### Fixed

- Le test dogfood de fermeture d'un groupe de processus conserve une borne de
  cinq secondes après `SIGKILL`. Cette marge couvre le délai de récollection
  observé sous émulation `linux/amd64` sans modifier les délais du runtime
  produit.

## [0.1.0-rc.4] - 2026-07-26

### Fixed

- Le gate recrée son `HOME` candidat dédié après `npm ci --ignore-scripts`.
  Les caches npm et Corepack restent isolés séparément, tandis que les
  métadonnées d'émulation antérieures ne contaminent plus le fixture V1. Seul
  le cache `.cache/rosetta` recréé au démarrage du processus qualifié est
  admis sous émulation ; le `HOME` reste vide sur un hôte natif.

## [0.1.0-rc.3] - 2026-07-26

### Fixed

- Le gate de preview place son wrapper `corepack npm` dans un volume anonyme
  root-owned et rend explicitement exécutable le `tmpfs` candidat requis par
  les shims audités de `node_modules/.bin`, tout en conservant `nosuid`,
  `nodev`, `no-new-privileges` et la suppression des capabilities.
- La plateforme du conteneur est fixée à `linux/amd64`, seule cible Linux du
  profil de conformité V1, au lieu de dépendre de l'architecture de l'hôte.
- Le template d'adapter externe laisse vingt secondes aux appels de
  qualification locaux afin que leur contrat reste portable sur un hôte ARM
  exécutant le profil `linux/amd64` épinglé.

## [0.1.0-rc.2] - 2026-07-26

### Fixed

- Le gate de preview accepte les query strings signées ajoutées par une
  redirection HTTPS d'artifact, tout en continuant à refuser credentials,
  fragments, protocoles non HTTPS et queries dans les URLs publiques initiales.

## [0.1.0-rc.1] - 2026-07-26

### Added

- Verticale headless CLI/API/SDK : import et export de datasets, application,
  suivi et export de recettes, recherche d'entreprises et de contacts,
  enrichissement sélectif et annulation durable.
- Runtime PostgreSQL + Hatchet avec reprise, idempotence, budgets, résultats
  ambigus, lineage, confidentialité Contact et providers BYOK explicites.
- Distribution preview liée au commit exact : source matérialisée dans un
  espace isolé, dépendances réinstallées depuis le lockfile, bundles
  API/worker/CLI, tarball CLI autonome, SBOMs CycloneDX, checksums SHA-256 et
  archive source.
- Stack Docker Compose loopback persistante avec bootstrap, healthchecks,
  smoke déterministe, backup et restore PostgreSQL atomique qui laisse les
  services arrêtés en cas d'échec.
- Configurations locales de contribution et supply chain : CODEOWNERS, DCO,
  Dependabot, CodeQL, dependency review et actions épinglées par SHA. Leur
  activation hébergée reste soumise au gate GitHub.

### Security

- Mise à jour de `fast-uri` vers `3.1.4` et `@hono/node-server` vers `2.0.11`.
- Audit du lockfile de production bloquant dans la CI.

Cette source preview est publiée sous le tag `v0.1.0-rc.1`. Elle ne publie aucun
package npm ou image OCI et n'annonce aucun engagement de support.
