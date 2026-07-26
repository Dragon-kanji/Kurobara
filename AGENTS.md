# Kurobara repository instructions

## Start from the requested outcome

Inspect the relevant files, repository state, and real behavior before changing
anything. Treat scope restrictions as boundaries:

- `docs-only` changes no code, configuration, or generated artifact;
- `no-code` changes only explicitly allowed non-executable files;
- read-only work creates no local or external mutation;
- no publication means no push, release, or deployment.

Do not expand a task to fix unrelated problems. Report them separately.

## Separate current behavior from direction

Use this evidence order:

1. tracked code and manifests;
2. checks that were actually run;
3. observed runtime behavior;
4. built artifact contents;
5. documentation for decisions and stated limits.

Never announce a documented route, package, plan, or diagram as implemented
without runtime or test evidence. Use `planned`, `unverified`, or `unavailable`
when that is the honest state.

## Preserve architecture boundaries

- The kernel performs no I/O and imports no framework, provider, or adapter.
- Use cases and policies live in the application layer.
- PostgreSQL owns durable business state; Hatchet is an execution mechanism.
- External effects model idempotency, cost, ambiguity, and reconciliation.
- Public contracts come from one canonical, versioned source.
- REST, SDK, and CLI project the same logic.
- Adapters implement ports and do not leak provider semantics into the domain.
- Agent authority is bounded by permission, budget, deadline, and stop rules.
- A managed service may consume the public core; the public core never depends
  on it.

Open a design proposal before changing a public contract, security guarantee,
layer boundary, persistence model, provider admission rule, or another
expensive-to-reverse decision.

## Write focused changes

- Prefer explicit types and `unknown` over unsafe assertions or `any`.
- Validate external and generated data at the receiving boundary.
- Keep side effects visible and errors descriptive.
- Do not hand-edit generated output to hide contract drift.
- Remove debug code and temporary bypasses before review.
- Add tests proportional to business, compatibility, and failure risk.

## Write verifiable documentation

- Keep public documentation in English.
- Separate current behavior, design direction, and release conditions.
- Publish only commands present in tracked manifests.
- Use synthetic examples without secrets or plausible personal identities.
- State when a command can spend provider credits.
- Verify every modified local link.
- Do not invent support channels, SLAs, hosted services, or compatibility
  guarantees.

## Protect existing work

Inspect `git status` before editing. Existing changes belong to the user unless
their origin is known.

- Do not restore, delete, or reformat out-of-scope files.
- Do not hide a dirty worktree.
- Re-read overlapping diffs and stop when concurrent intent is incompatible.
- Prefer reversible operations and explicit paths.

## Security and provenance

- Never commit secrets, real `.env` files, dumps, sensitive logs, or personal
  data.
- Redact diagnostics before placing them in documentation or issues.
- DCO sign-off does not replace license or provenance review.
- Verify dependency, asset, fixture, and generated-content obligations.
- Follow [SECURITY.md](./SECURITY.md) for non-public vulnerabilities.

## Commands

The root manifest pins npm `10.9.4` and Node.js `24.14.0`.

| Need | Command |
| --- | --- |
| Install | `npm ci` |
| Production dependency audit | `npm run security:audit` |
| Full dependency audit | `npm run security:audit:all` |
| Lint and architecture checks | `npm run check` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Test | `npm test` |
| Plugin packaging | `npm run test:plugin-packaging` |
| Regenerate contracts | `npm run generate:contracts` |
| Build or verify clean-room output | `npm run clean-room -- <command>` |
| Run deterministic self-host smoke | `npm run self-host:smoke` |

Choose the smallest set that covers the change. Documentation-only work must at
least verify local links, forbidden content, `git diff --check`, and the final
clean-room candidate when publication is in scope.

## Git closeout

Before handoff:

1. inspect the branch, status, and complete diff;
2. run `git diff --check`;
3. remove only task-created disposable artifacts;
4. check for secrets, debug code, generated drift, and unrelated files;
5. report checks, results, and unverified areas.

Commit only intended files when repository policy permits. A local commit does
not authorize a push, release, or deployment.
