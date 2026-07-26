# Kurobara governance

This document governs the open-source Kurobara repository: code,
documentation, public contracts, releases, and community policies.

Software rights come from [Apache-2.0](./LICENSE). Participation is also subject
to [CONTRIBUTING.md](./CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Principles

- Important decisions retain their context, alternatives, and consequences.
- Evidence and responsibility matter more than employer, funding, or tenure.
- Hard-to-reverse changes receive more review than local changes.
- An accepted design is not proof of implementation.
- Relevant personal, professional, and commercial conflicts are disclosed.
- The public core remains usable without a mandatory managed service.

## Roles

- **Participant** - takes part in project spaces and follows community policy.
- **Contributor** - submits code, documentation, tests, review, or analysis and
  remains responsible for provenance.
- **Reviewer** - evaluates behavior, evidence, risk, and public interfaces.
- **Maintainer** - owns a declared project area and may make decisions or merge
  changes within that scope.
- **Decision owner** - organizes a structural proposal and records its outcome.

Maintainers and scopes are listed in [MAINTAINERS.md](./MAINTAINERS.md).

## Decisions

Local, reversible changes use normal pull request review. Structural changes
need a written proposal that covers contracts, migration, rollback, security,
privacy, compatibility, and verification.

The project prefers documented consensus. Consensus does not require
unanimity, but blocking objections must receive an explicit answer.

If eligible maintainers cannot agree:

1. each non-recused maintainer records a position;
2. a simple majority decides;
3. a tie preserves current behavior;
4. a sole eligible maintainer may decide after recording objections and
   accepted risks.

Private security work follows [SECURITY.md](./SECURITY.md).

## Conflicts and access

People disclose interests that could reasonably affect a decision and recuse
when impartial judgment is not possible.

Repository administration, secrets, signing keys, and publication permissions
use least privilege. A governance role does not automatically grant technical
access, and technical access does not automatically grant decision authority.

## Releases

A release must identify its source revision, checks, artifacts, limits, and
migrations. This governance does not promise a cadence, supported branch, or
response time.

## Changing governance

Editorial changes may use normal review. Changes to decision rights,
maintainer roles, licensing, contribution terms, or the public-core boundary
require a structural proposal and applicable rights analysis.
