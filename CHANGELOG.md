# Changelog

Notable Kurobara changes are recorded here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and will adopt SemVer
from its first stable release.

## [Unreleased]

### Added

- Added the static `kurobara.systems` project website with responsive,
  agent-focused product framing and a hardened unprivileged container image.

### Changed

- Replaced the public documentation with a smaller English guide organized for
  evaluators, B2B operators, coding agents, provider users, contributors, and
  self-host operators.
- Updated `@biomejs/biome` from `2.4.5` to `2.4.16`.

## [0.1.0-rc.7] - 2026-07-26

### Fixed

- Run every public-gate container with Docker's minimal init process so orphaned
  children are reaped and a zombie cannot be mistaken for a live service.
- Record the init-reaper guarantee in the machine-readable isolation contract
  and launcher test without adding a capability or host mount.

## [0.1.0-rc.6] - 2026-07-26

### Changed

- Updated `@hono/node-server` to `2.0.12`, Hono to `4.12.32`, Postgres.js to
  `3.4.9`, and the Hatchet TypeScript SDK to `1.28.0`.
- Grouped future Dependabot minor and patch updates by dependency type and
  deferred TypeScript 7 until the pinned architecture toolchain supports it.

### Fixed

- Accept Dependabot's standard DCO trailer only for the exact bot identity,
  repository branch, and trusted base workflow.
- Override vulnerable transitive dependencies and make the full development
  dependency audit blocking.
- Replace four CodeQL findings with separated process arguments, structured
  JSONL validation, and complete PURL encoding.
- Add a bounded fixture reason code to public-gate failures without exposing
  logs, paths, or internal data.

## [0.1.0-rc.5] - 2026-07-26

### Fixed

- Keep the dogfood process-group closeout bounded for five seconds after
  `SIGKILL`, covering reaping latency under `linux/amd64` emulation.

## [0.1.0-rc.4] - 2026-07-26

### Fixed

- Recreate the dedicated candidate home after dependency installation so prior
  emulation metadata cannot contaminate the V1 fixture.

## [0.1.0-rc.3] - 2026-07-26

### Fixed

- Isolate the preview gate's Corepack npm wrapper in a root-owned anonymous
  volume and keep the audited candidate temp filesystem executable.
- Pin the container platform to the qualified `linux/amd64` profile.
- Allow the external-adapter template enough time to run under emulation.

## [0.1.0-rc.2] - 2026-07-26

### Fixed

- Accept signed query strings added by HTTPS artifact redirects while still
  rejecting credentials, fragments, non-HTTPS protocols, and query strings in
  initial public URLs.

## [0.1.0-rc.1] - 2026-07-26

### Added

- Headless CLI, REST, and TypeScript SDK flows for dataset import/export,
  recipes, company and contact discovery, selective enrichment, and durable
  cancellation.
- PostgreSQL and Hatchet runtime with restart safety, idempotency, budgets,
  ambiguous outcomes, lineage, contact privacy, and explicit BYOK providers.
- Commit-bound preview distribution with source archive, runtime bundles, CLI
  tarball, CycloneDX SBOMs, SHA-256 checksums, and release manifest.
- Loopback-only persistent Docker Compose profile with bootstrap, healthchecks,
  deterministic smoke test, and atomic PostgreSQL backup/restore.
- CODEOWNERS, DCO, Dependabot, CodeQL, dependency review, and pinned supply
  chain workflows.

### Security

- Updated `fast-uri` to `3.1.4` and `@hono/node-server` to `2.0.11`.
- Added a blocking production lockfile audit to CI.

This source preview does not publish an npm package, OCI image, hosted endpoint,
or support commitment.
