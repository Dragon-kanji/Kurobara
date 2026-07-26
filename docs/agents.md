# Agent integration

Kurobara is designed to be controlled by Codex, Claude Code, scripts, or other
tool-using agents without embedding an LLM in the runtime.

## Best interface today

Use the CLI when the agent can execute local commands. Use REST when Kurobara
runs as a separate loopback or private service. The TypeScript SDK projects the
same operations.

There is no MCP server in the current preview.

## Machine contract

- Successful CLI output is JSON on stdout.
- Errors use a bounded Problem Details JSON shape and a non-zero exit code.
- The default API endpoint is `http://127.0.0.1:3000`.
- Override it with `KUROBARA_API_URL` or `--endpoint`.
- Authenticate with `KUROBARA_API_KEY` or `--api-key-file`, never both.
- Prefer `--api-key-file` so the credential does not appear in prompts,
  command arguments, or copied shell history.

Do not let an agent read PostgreSQL directly. IDs, status, provenance, cost,
and results are available through the supported interfaces.

## Safe execution pattern

For any provider-backed action:

1. generate stable operation, dataset, and discovery IDs;
2. set an absolute deadline;
3. set explicit budget, call, page, and row caps;
4. run `dry-run`;
5. parse and review the quote;
6. start the same intent without changing its IDs or bounds;
7. poll with a finite timeout;
8. inspect terminal state and cost before the next action;
9. export only the selected final dataset.

Never retry an ambiguous effect with a new idempotency key. Stop and
reconcile it first.

## Command catalog

| Intent | CLI |
| --- | --- |
| Import CSV or JSONL | `dataset import` |
| Apply a recipe | `recipe apply` |
| Watch or export a recipe application | `recipe watch`, `recipe export` |
| Discover companies | `company search` |
| Watch or read a generation | `company watch`, `company results` |
| Cancel a generation | `company cancel` |
| Discover and read contacts | `contact search`, `contact results` |
| Reveal selected identities | `contact reveal-identity` |
| Resolve selected work emails | `contact enrich-email` |
| Verify selected work emails | `contact verify-email` |
| Export a dataset | `dataset export` |
| Read or revoke a contact delivery | `dataset export-status`, `dataset export-revoke` |
| Restrict a contact subject | `contact restrict` |
| Cancel a run | `run cancel` |

The CLI intentionally rejects free-form prompts. An agent must translate user
intent into the typed fields required by the command.

## Authority model

A provider-backed request is accepted only when the server can match it to:

- a workspace and actor;
- an authority envelope;
- the required permission;
- an admitted capability and route;
- a valid pricing snapshot;
- an unexpired deadline;
- a bounded budget.

Sub-agents should receive a stricter subset of the parent authority. Do not
share a broad operator key with every process.

## Idempotency

Use deterministic IDs derived from the task, workspace, and intended input.
Persist them outside the model conversation if a workflow may resume.

The same ID plus the same input is replay-safe. The same ID plus different
input is rejected. A fresh ID is a new business intent and can spend again.

## Polling and cancellation

Use finite timeouts:

```sh
npm run kurobara -- company watch \
  --api-key-file .local/api-key \
  --generation-id "<generation-id>" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000
```

A timeout is not proof that the server stopped. Read the generation again.
Cancel with an idempotency key when the user, deadline, or budget requires it:

```sh
npm run kurobara -- company cancel \
  --api-key-file .local/api-key \
  --generation-id "<generation-id>" \
  --idempotency-key "<stable-cancel-id>"
```

## Suggested agent policy

```text
Allowed:
- dry-run bounded searches
- read capabilities and run state
- start only after a quote is within the user budget
- enrich only explicitly selected contacts
- export only to an approved private path

Stop when:
- the deadline is reached
- the quote exceeds budget
- an effect is ambiguous
- a required permission or provider is unavailable
- the requested selection is empty or larger than the approved cap
```

For the concrete company-to-contact commands, use
[Build B2B lists](./b2b-lists.md).
