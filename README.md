# Kurobara

Kurobara is an open-source, headless engine for building and enriching B2B
lists from the command line or an API. It is designed for humans, scripts, and
coding agents that need durable runs, explicit budgets, provider provenance,
and machine-readable outputs.

[![CI](https://github.com/Dragon-kanji/Kurobara/actions/workflows/ci.yml/badge.svg)](https://github.com/Dragon-kanji/Kurobara/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Dragon-kanji/Kurobara/actions/workflows/codeql.yml/badge.svg)](https://github.com/Dragon-kanji/Kurobara/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Dragon-kanji/Kurobara?include_prereleases)](https://github.com/Dragon-kanji/Kurobara/releases)

## What it does today

- Imports CSV or JSONL datasets.
- Uses imported organization domains directly as the source of a contact
  shortlist, with explicit field mapping and deterministic diagnostics.
- Finds companies from country, industry, keyword, and employee-count filters.
- Builds an obfuscated contact shortlist from selected companies.
- Reveals professional identities and resolves work emails for an explicit
  selection.
- Verifies work emails as a separate, explicit action.
- Applies versioned enrichment recipes to existing datasets.
- Persists runs, checkpoints, costs, provenance, retries, cancellations, and
  ambiguous outcomes in PostgreSQL.
- Exposes the same product logic through REST, a TypeScript SDK, and a
  non-interactive CLI.
- Exports deterministic CSV or JSONL with privacy-aware delivery receipts for
  contact data.

Kurobara does not require an LLM. Codex, Claude Code, or another agent can drive
the CLI directly and parse its JSON output.

## Pick your path

| You want to... | Start here |
| --- | --- |
| Evaluate Kurobara without provider credits | [Quickstart](./docs/getting-started.md) |
| Build a company and contact list | [B2B list workflow](./docs/b2b-lists.md) |
| Drive Kurobara from Codex, Claude, or a script | [Agent integration](./docs/agents.md) |
| Configure BYOK providers | [Provider guide](./docs/providers.md) |
| Understand the system boundaries | [Architecture](./docs/architecture.md) |
| Run backups or handle contact data | [Operations and privacy](./docs/operations.md) |
| Contribute code or documentation | [Contributing](./CONTRIBUTING.md) |
| See the project website | [kurobara.systems](https://kurobara.systems) |

The complete, intentionally small documentation index is in
[docs/README.md](./docs/README.md). The public website source is maintained
separately in
[`Dragon-kanji/kurobara.systems`](https://github.com/Dragon-kanji/kurobara.systems).

## First run

Requirements: Git, Docker with Compose v2, Node.js `24.14.0`, and npm `10.9.4`.

```sh
git clone https://github.com/Dragon-kanji/Kurobara.git
cd Kurobara
npm ci
npm run install:cli -- --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"

kurobara setup
kurobara first-run --offline --json
```

`setup` is a short human TTY flow. Coding agents use the same engine through
`setup inspect`, `setup plan`, and `setup apply --non-interactive --json`.

The offline first run builds the local distribution, starts PostgreSQL,
Hatchet, the API, and the worker, then exercises import, recipe execution,
restart, backup/restore, export, and cleanup with synthetic data. It makes no
provider call and consumes no provider credit.

This is a source-preview installation tied to the checkout; no npm package is
published. See the [quickstart](./docs/getting-started.md) for agent setup,
credentials, upgrades, and uninstall.

## Provider-backed B2B workflow

The currently qualified default path is:

```text
Hunter Discover
  -> company candidates
  -> Prospeo Search Person
  -> obfuscated contact shortlist
  -> Prospeo Enrich Person
  -> professional identity and work email
  -> optional Hunter verification
  -> CSV or JSONL
```

Every provider is BYOK. You supply the account, key, plan, and quota, and you
remain responsible for the provider terms and the data you export. Kurobara
keeps adapters behind a provider-neutral boundary and refuses unbounded or
unknown-cost work.

The bounded live harness is the fastest way to test your own Hunter and Prospeo
keys:

```sh
npm run b2b:dogfood:preflight
npm run b2b:dogfood -- run --confirm-provider-calls
```

Read the [B2B list workflow](./docs/b2b-lists.md) before confirming calls.

## Designed for agents

Agent-controlled work is constrained by:

- a versioned operation contract;
- permissions and an authority envelope;
- an absolute deadline;
- explicit call, page, row, and budget caps;
- idempotency keys;
- durable checkpoints and cost records;
- fail-closed handling of ambiguous provider outcomes.

CLI success output is JSON. Errors use a bounded Problem Details shape and a
non-zero exit code. A caller can dry-run a plan, inspect it, and start the same
intent without giving the agent direct access to PostgreSQL or provider
internals.

The repository ships a companion
[`kurobara-cli` skill](./.codex/skills/kurobara-cli/SKILL.md) for coding agents.

There is no MCP server in this preview. Agents use the CLI or REST API today.

## Preview status

The latest published preview is
[`v0.1.0-rc.7`](https://github.com/Dragon-kanji/Kurobara/releases/tag/v0.1.0-rc.7).
It is a source preview, not a stable release. The repository does not currently
publish an npm package, an OCI image, a hosted API, a product UI, or a managed
service. The separately maintained public project website is a static
introduction to the OSS project.

The preview has passed:

- the deterministic self-host and V1 business gates;
- architecture, type, build, and supply-chain checks;
- a live bounded Hunter and Prospeo workflow;
- two anonymous clean-container release qualifications.

Current limitations are tracked in [ROADMAP.md](./ROADMAP.md).

## Project

- [Website](https://kurobara.systems)
- [Website source](https://github.com/Dragon-kanji/kurobara.systems)
- [Documentation](./docs/README.md)
- [Roadmap](./ROADMAP.md)
- [Security policy](./SECURITY.md)
- [Responsible use](./RESPONSIBLE_USE.md)
- [Support](./SUPPORT.md)
- [Governance](./GOVERNANCE.md)
- [Code of conduct](./CODE_OF_CONDUCT.md)

Kurobara is licensed under [Apache-2.0](./LICENSE). The license covers the
project code, not third-party provider data, trademarks, accounts, or terms.
