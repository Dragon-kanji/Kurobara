# Kurobara documentation

The documentation is organized by user outcome, not by implementation ticket.

## Start here

| Reader | Guide | Outcome |
| --- | --- | --- |
| Evaluator | [Getting started](./getting-started.md) | Run the complete synthetic workflow without a provider account |
| B2B operator | [Build B2B lists](./b2b-lists.md) | Find companies, shortlist contacts, enrich selected records, and export |
| Coding agent or automation author | [Agent integration](./agents.md) | Control Kurobara safely through JSON CLI or REST |
| Provider user or adapter author | [Providers](./providers.md) | Configure BYOK routes and understand their limits |
| Contributor | [Architecture](./architecture.md) | Understand the boundaries that new code must preserve |
| Self-host operator | [Operations and privacy](./operations.md) | Handle credentials, backups, contact data, and release artifacts |

## Project references

- [README](../README.md) - product overview and current capabilities
- [Roadmap](../ROADMAP.md) - delivered, next, and explicitly out of scope
- [Contributing](../CONTRIBUTING.md) - development and review workflow
- [Security](../SECURITY.md) - private vulnerability reporting
- [Responsible use](../RESPONSIBLE_USE.md) - provider, privacy, and agent
  responsibilities
- [Support](../SUPPORT.md) - how to report a non-sensitive problem

## Documentation rules

Public documentation must:

- describe current behavior separately from future direction;
- use commands that exist in the tracked manifests;
- use synthetic examples and never include credentials or personal data;
- state when an action can consume provider credits;
- link to one canonical explanation instead of duplicating long runbooks;
- remain in English.

Historical design notes, publication evidence, internal audits, and execution
backlogs are intentionally excluded from the public documentation set.
