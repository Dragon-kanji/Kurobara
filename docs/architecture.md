# Architecture

Kurobara is a modular, provider-neutral runtime built around durable business
state and shared public contracts.

## Layers

```text
canonical contracts
        |
application use cases and policies
        |
pure domain kernel and workflow compilation
        |
ports
        |
PostgreSQL, Hatchet, provider, HTTP, SDK, and CLI adapters
```

## Non-negotiable boundaries

- The domain kernel performs no I/O and imports no framework or provider.
- Application policies own authorization, budgets, deadlines, and routing
  decisions.
- PostgreSQL owns durable business state.
- Hatchet schedules work but is not the business source of truth.
- External effects model idempotency, cost, ambiguity, and reconciliation.
- REST, the TypeScript SDK, and the CLI project the same versioned operations.
- Provider adapters implement ports and never define domain semantics.
- A hosted service may consume the public core; the public core never depends
  on a hosted service.

## Durable execution

A run is not a transient queue message. Kurobara persists:

- the accepted intent and contract version;
- authority, permission, deadline, and budget snapshots;
- provider route decisions;
- attempts and idempotency keys;
- checkpoints, usage, cost, and provenance;
- terminal, cancelled, partial, or ambiguous outcomes.

The worker can restart and continue from the latest certain state. An ambiguous
external outcome blocks a blind retry.

## Provider boundary

Provider-specific payloads are validated and normalized inside adapters. The
domain sees capabilities, normalized records, cost units, provenance, and
bounded outcomes.

The runtime selects only routes admitted by configuration and planning
snapshots. A configured key alone does not admit a route.

## Agent boundary

Agents use typed operations. They can propose or launch work only inside an
authority envelope containing:

- actor and workspace identity;
- permissions;
- budget;
- deadline;
- allowed capabilities;
- stop conditions.

Delegation must reduce authority. The current preview exposes this model through
CLI, REST, SDK, and an optional local stdio MCP projection. Native multi-agent
orchestration remains outside the Kurobara runtime; external agents coordinate
through the same generated contracts.

## Repository map

```text
apps/api                  HTTP composition and bootstrap
apps/worker               durable scheduling and effects
packages/kernel           pure domain logic
packages/application      use cases and policies
packages/contracts        canonical public contracts
packages/adapters         infrastructure implementations
packages/adapters/provider-* in-tree provider adapters
packages/plugin-*         external plugin SDK, host, and conformance
packages/cli              human and machine-readable CLI
packages/sdk-ts           TypeScript client
deploy/self-host          local deterministic Compose profile
test                      release, business, and architecture gates
```

The generated dependency graph is available at
[architecture/generated/module-dependencies.mmd](./architecture/generated/module-dependencies.mmd).

## Where to make a change

| Concern | Start here |
| --- | --- |
| Operation or schema | `packages/contracts/catalog` |
| Use case or policy | `packages/application`, `packages/policy-engine` |
| Pure domain or workflow rule | `packages/kernel`, `packages/workflow-engine` |
| HTTP projection | `packages/adapters/http`, `apps/api` |
| Public project website | [`Dragon-kanji/kurobara.systems`](https://github.com/Dragon-kanji/kurobara.systems) |
| Provider behavior | `packages/adapters/provider-*` |
| CLI or TypeScript client | `packages/cli`, `packages/sdk-ts` |
| Durable storage | `packages/adapters/postgres` |

## Changing architecture

Open a focused proposal before changing a public contract, security guarantee,
layer boundary, persistence model, provider admission rule, or decision that is
expensive to reverse. Include migration, compatibility, rollback, security,
privacy, and verification consequences.

Use the
[feature request form](https://github.com/Dragon-kanji/Kurobara/issues/new?template=feature_request.yml)
with a `[Design]` title and link the accepted proposal from the implementation
pull request.

Small internal refactors that preserve these boundaries can use the normal pull
request workflow.
