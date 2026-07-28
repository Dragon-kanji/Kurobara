---
name: kurobara-cli
description: Operate the Kurobara open-source CLI to configure a local or remote profile, diagnose readiness, manage BYOK credential references, run the zero-credit fixture, and build bounded company/contact lists. Use when a coding agent such as Codex or Claude needs to onboard Kurobara or drive its headless B2B workflow without direct database access.
---

# Kurobara CLI

Use the installed `kurobara` command. In a source checkout without an
installation, replace it with `npm run kurobara --`.

## Onboard deterministically

Start with machine-readable inspection:

```sh
kurobara setup inspect --json
kurobara doctor --json
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
