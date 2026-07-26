# Contributing to Kurobara

Thank you for helping improve Kurobara. Keep changes focused, verifiable, and
safe for a headless system that can spend provider credits and process contact
data.

## Before you start

Use a normal pull request for a local fix, documentation improvement, test, or
refactor that preserves public behavior.

Open a design proposal first when a change:

- creates or breaks a public contract;
- crosses several subsystems;
- changes a security, privacy, compatibility, or durability guarantee;
- moves a kernel, application, adapter, or hosted-service boundary;
- changes governance, licensing, or contribution policy;
- is expensive to reverse.

Use the
[feature request form](https://github.com/Dragon-kanji/Kurobara/issues/new?template=feature_request.yml)
with a `[Design]` title. Describe the outcome, affected boundary, compatibility
and migration impact, rollback, security and privacy consequences, and the
evidence that would validate the decision. In this preview, that issue is the
public decision record; link it from the pull request.

Never disclose a vulnerability in an issue or pull request. Follow
[SECURITY.md](./SECURITY.md).

## Development setup

Requirements:

- Node.js `24.14.0`
- npm `10.9.4`
- Docker with Compose v2 for integration and self-host checks

```sh
npm ci
npm run check
npm run typecheck
npm run build
```

Run the smallest relevant tests in addition to these baseline checks. Use
`npm test` for a broad change.

## Development loop

| Change | Fast feedback |
| --- | --- |
| One workspace | `npm test -w <workspace-name>` |
| Public contracts | `npm run generate:contracts` then `npm run generate:check -w @kurobara/contracts` |
| PostgreSQL behavior | `npm run integration:test:postgres` with `KUROBARA_TEST_POSTGRES_URL` pointing to a disposable admin database |
| Architecture imports | `npm run architecture:drift` |
| Full runtime | `npm run self-host:smoke` |

The deterministic self-host stack in
[Getting started](./docs/getting-started.md) is the supported end-to-end
development path. Direct `npm run start:api` and `npm run start:worker` commands
require explicit PostgreSQL and Hatchet configuration.

Contract schemas and operations under `packages/contracts/catalog` are
canonical. Regenerate tracked outputs; never edit generated JSON or TypeScript
to hide drift.

PostgreSQL migrations are append-only files under
`packages/adapters/postgres/migrations`. Add the next numbered migration and
exercise both a fresh database and roll-forward behavior. Never modify a
migration that may already have been applied: checksums are persisted.

## Change quality

- State the intended outcome and non-goals.
- Keep unrelated formatting and refactors out of the diff.
- Validate external data at the receiving boundary.
- Add tests proportional to business and failure risk.
- Update English documentation when behavior, configuration, or limits change.
- Use synthetic fixtures with no secrets or plausible personal identities.
- Review the complete diff for generated drift, debug code, and accidental
  files.

## Provenance

You must have the right to submit every code, text, asset, fixture, and generated
artifact in the contribution. Preserve required licenses and notices. Do not
copy provider output, proprietary examples, or employer-owned work without
authorization.

## DCO sign-off

Every commit must certify the
[Developer Certificate of Origin 1.1](./DCO):

```sh
git commit --signoff
```

The `Signed-off-by` trailer certifies provenance. It is not a cryptographic
signature, copyright assignment, or replacement for license review. Kurobara
does not use a Contributor License Agreement in V1.

## Pull request description

Include:

- problem and outcome;
- scope and non-goals;
- public contract or behavior changes;
- security, privacy, compatibility, migration, and operational risks;
- provenance of new third-party material;
- checks run and their results;
- unverified areas;
- documentation changes.

Maintainers may ask for a smaller scope, more evidence, or a design proposal.
Approval does not guarantee a release or support commitment.

Contributions are intended for distribution under
[Apache-2.0](./LICENSE), subject to the DCO and applicable third-party
obligations.
