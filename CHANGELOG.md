# Changelog

Les changements notables de Kurobara sont consignés ici. Le projet suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et adoptera SemVer à
partir de sa première publication.

## [Unreleased]

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
