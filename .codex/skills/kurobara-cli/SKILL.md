---
name: kurobara-cli
description: Operate the Kurobara open-source CLI to configure a local or remote profile, collect and review GTM Context, compile bounded Plays, inspect Workbooks and runs, manage BYOK credential references, and drive headless B2B workflows. Use when a coding agent such as Codex or Claude needs to onboard or operate Kurobara without direct database access.
---

# Kurobara CLI

Use the installed `kurobara` command. In a source checkout without an
installation, replace it with `npm run kurobara --`.

## Onboard deterministically

Start with machine-readable inspection:

```sh
kurobara setup inspect --json
kurobara doctor --profile agentic_outbound_play --json
```

If setup is missing, create a plan without writing state:

```sh
kurobara setup plan \
  --profile local \
  --output ./kurobara-setup-plan.json \
  --json
```

Read the plan, then apply the same file:

```sh
kurobara setup apply \
  --file ./kurobara-setup-plan.json \
  --non-interactive \
  --json
```

Never edit the plan. Its fingerprint binds the profile, endpoint, provider
order, steps, and secret references.

## Collect GTM Context

`doctor` is always read-only and makes no provider call. Treat
`technical_ready` and `profile_ready` as separate facts: a healthy runtime can
have an incomplete business context.

```sh
kurobara doctor --profile agentic_outbound_play --json
kurobara context questions \
  --profile agentic_outbound_play \
  --json
```

Ask only questions that are required for the selected profile and whose
`ask_if` condition is satisfied. Preserve `unknown`, `inferred`,
`imported_unverified`, and `confirmed` as distinct assertion states.

An agent may infer ordinary business answers when it records agent provenance.
It must never confirm on the user's behalf:

- prohibited or sensitive data categories;
- provider rights;
- the initial provider-credit budget and unit;
- retention;
- private export intent or destination;
- activation mode.

Write a bounded request such as
`examples/agent-first/context-plan.json`, then plan it:

```sh
kurobara context plan \
  --request ./examples/agent-first/context-plan.json \
  --json
```

Show the user the blocking questions, issues, readiness map, and exact
fingerprint. Build an apply request from the unchanged Context and returned
fingerprint only after explicit confirmation:

```sh
kurobara context apply \
  --request ./context-apply.json \
  --json
```

Changing the active Context requires a second explicit confirmation. Human
operators can run `kurobara context setup --profile
agentic_outbound_play`; agents must use the non-interactive commands above.

## Preview and start Plays

Use an immutable Context reference and one of the two provider-neutral source
types: `organization_search` or `imported_dataset`.

```sh
kurobara play preview --request ./play-preview.json --json
```

Review the sample bounds, quoted upper bound, assumptions, permissions, and
human gates. Never broaden the audience silently. Start only the unchanged
Play with the returned preview fingerprint, a stable idempotency key, and the
required human approval:

```sh
kurobara play start --request ./play-start.json --json
kurobara play run --run-id "<play-run-id>" --timeout-ms 60000 \
  --poll-interval-ms 1000 --json
```

The default delivery mode is `no_send`. Sensitive reveal, provider spend, and
private export remain separate human gates.

## Inspect Workbooks

Read a bounded Workbook page through the API, never PostgreSQL:

```sh
kurobara workbook inspect \
  --request ./workbook-get.json \
  --json
```

Use the returned cell status, provenance, freshness, confidence, cost, error,
redaction, and `selection_reasons` metadata when explaining or selecting a
row. A view can pin `recipe_application_id` so the server overlays exact
CellResult evidence without copying dataset payloads into view state.

Persist the complete versioned view with `workbook update`, or use its focused
`workbook select`, `workbook approve`, and `workbook reject` aliases. Preserve
the returned annotation and approval arrays unchanged and append decisions;
the server stamps new history with the authenticated actor and server time.

## Configure credentials

Never place a credential value in argv. Import a named variable:

```sh
kurobara provider configure prospeo \
  --from-env PROSPEO_API_KEY \
  --enable \
  --json
```

Or pipe a value through stdin:

```sh
printf '%s' "$PROSPEO_API_KEY" |
  kurobara provider configure prospeo --stdin --enable --json
```

Provider credentials are server-side and are refused in a remote profile.
`kurobara` is the client API-key secret name. Read only presence and backend
metadata with `secret status`; never inspect the store directly.

## Prove the first run

Use the zero-credit fixture first:

```sh
kurobara first-run --offline --json
```

A live run is a separate, explicit action. Keep both caps at one and require
the user to approve provider-credit use:

```sh
kurobara first-run \
  --live \
  --max-companies 1 \
  --max-contacts 1 \
  --confirm-provider-credits \
  --json
```

## Drive B2B work

Use typed CLI commands, not free-form prompts. Generate stable IDs, set an
absolute deadline, provide explicit call/page/row/budget caps, and start with
`--mode dry-run`. Reuse the same intent IDs and bounds after the quote is
approved.

For each JSON response:

1. require valid JSON and exit code zero;
2. inspect `blocked_steps`, `warnings`, `requires_confirmation`, and
   `next_actions`;
3. execute only an allowlisted `next_actions[].argv`;
4. persist returned IDs outside the conversation;
5. stop on ambiguity, deadline, missing permission, unavailable provider, or
   budget excess.

Never read PostgreSQL directly, retry an ambiguous effect with a new ID, enable
a provider because a key merely exists, or claim a timeout means the server
stopped.

Use the canonical command metadata in
`packages/contracts/catalog/generated/cli-commands.json` and the local
onboarding contract in
`packages/contracts/catalog/cli-onboarding/1.0.0.contract.json`.
