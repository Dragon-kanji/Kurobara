# Agent integration

Kurobara is designed to be controlled by Codex, Claude Code, scripts, or other
tool-using agents without embedding an LLM in the runtime.

## Best interface today

Use the CLI when the agent can execute local commands. Use REST when Kurobara
runs as a separate loopback or private service. The TypeScript SDK and optional
stdio MCP server project the same generated operations.

The repository includes a concise
[`kurobara-cli` companion skill](../.codex/skills/kurobara-cli/SKILL.md) for
Codex-compatible agents. Other agents can follow the same commands directly.

## Onboard from a clean shell

```sh
kurobara setup inspect --json
kurobara setup plan \
  --profile local \
  --output ./kurobara-setup-plan.json \
  --json
kurobara setup apply \
  --file ./kurobara-setup-plan.json \
  --non-interactive \
  --json
kurobara doctor --profile agentic_outbound_play --json
kurobara context questions \
  --profile agentic_outbound_play \
  --json
kurobara first-run --offline --json
```

Do not edit the plan. Parse `blocked_steps`, `warnings`,
`requires_confirmation`, and `next_actions[].argv`; never derive a shell
command from prose.

## Machine contract

- Successful CLI output is JSON on stdout.
- Errors use a bounded Problem Details JSON shape on stderr and a non-zero exit
  code; stdout stays empty.
- The default API endpoint is `http://127.0.0.1:3000`.
- Override it with `KUROBARA_API_URL` or `--endpoint`.
- Authenticate with `KUROBARA_API_KEY` or `--api-key-file`, never both.
- Prefer `--api-key-file` so the credential does not appear in prompts,
  command arguments, or copied shell history.

Do not let an agent read PostgreSQL directly. IDs, status, provenance, cost,
and results are available through the supported interfaces.

For setup credentials, prefer `secret set --from-env <NAME>` or `--stdin`.
Values are forbidden in argv. A remote profile can store only the client
Kurobara key, never a server-side provider key.

## GTM Context interview

`doctor` separates `technical_ready`, `profile_ready`, and
`operational_ready`. A missing Context does not turn a healthy runtime into a
system outage. It returns the selected business profile, business-context
state, blocking question IDs, remediation, the canonical questionnaire, and
argv-safe next actions. It stays non-interactive, read-only, and makes no
provider call.

An external agent owns the conversation:

1. call `context questions --profile ... --json`;
2. ask only questions required for the selected profile and whose `ask_if`
   condition is satisfied;
3. preserve unknowns and record provenance for every assertion;
4. call `context plan` with the bounded JSON document;
5. show issues, readiness, and the exact fingerprint to the human;
6. call `context apply` only with the unchanged Context and approved
   fingerprint.

An agent may infer ordinary offer, audience, and qualification answers. Only a
human can confirm prohibited or sensitive data, provider rights, budget,
retention, export intent or destination, and activation mode. Changing the
active Context requires a second confirmation.

Human operators can use:

```sh
kurobara context setup --profile agentic_outbound_play
```

That wizard calls the same REST operations. It does not embed a model or write
an unreviewed draft.

## Play and Workbook loop

A Play pins one exact Context revision. It declares a measurable objective,
one `organization_search` or `imported_dataset` source, the audience,
exclusions, selection rules, preview caps, capabilities, budget, deadline,
stop conditions, approval state, and `no_send` delivery.

```sh
kurobara play preview --request ./play-preview.json --json
kurobara play start --request ./play-start.json --json
kurobara play run --run-id "<play-run-id>" --timeout-ms 60000 \
  --poll-interval-ms 1000 --json
kurobara workbook inspect --request ./workbook-get.json --json
kurobara workbook select --request ./workbook-select.json --json
kurobara workbook approve --request ./workbook-approve.json --json
```

Preview is the review boundary: inspect its quote, assumptions, permission
envelope, exact stages, and human gates. Do not modify the Play between preview
and start. Reuse the same idempotency key when resuming the same intent.
Without `--timeout-ms`, `play run` performs exactly one durable status read.
With a bounded timeout, it polls until the run is paused or terminal.

A Workbook is a bounded server projection, not a copy of business rows. Read
cell status, provenance, freshness, confidence, cost, errors, redaction, and
selection reasons before approving records. `workbook select`, `workbook
approve`, and `workbook reject` are focused aliases of the same versioned
`workbook update` contract: each request carries the complete prior view plus
the appended decision. The server preserves annotation and approval history
and stamps new entries with the authenticated actor and server time.

## Canonical references

- [OpenAPI 3.1](../packages/contracts/catalog/generated/openapi-3.1.1.json) -
  REST paths and schemas.
- [CLI command catalog](../packages/contracts/catalog/generated/cli-commands.json) -
  generated command metadata.
- [Operation catalog](../packages/contracts/catalog/operations) - versioned
  request, response, permission and problem contracts.
- [TypeScript client](../packages/sdk-ts/src/index.ts) - source-preview SDK.
- [MCP tool catalog](../packages/contracts/catalog/generated/mcp-tools.json) -
  generated tool metadata served by the optional local stdio MCP process.

These are source-preview artifacts, not published npm packages. Contract
changes start in the canonical catalog and use `npm run generate:contracts`;
generated files are never edited directly.

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
| Read or configure GTM readiness | `context questions`, `context setup`, `context plan`, `context apply`, `context status` |
| Preview, approve, start, pause, or retire a Play | `play preview`, `play apply`, `play start`, `play pause`, `play retire` |
| Inspect one durable Play run | `play run` |
| Inspect, select, approve, or reject rows in a bounded Workbook | `workbook inspect`, `workbook select`, `workbook approve`, `workbook reject`, `workbook update` |
| Import CSV or JSONL | `dataset import` |
| Apply a recipe | `recipe apply` |
| Watch or export a recipe application | `recipe watch`, `recipe export` |
| Discover companies | `company search` |
| Watch or read a generation | `company watch`, `company results` |
| Cancel a generation | `company cancel` |
| Discover contacts from a company generation or imported domain dataset | `contact search`, `contact results` |
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
