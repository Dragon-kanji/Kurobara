# Getting started

This path reaches a real Kurobara export without a provider account or provider
credits.

## Requirements

- Git
- Docker with Compose v2
- Node.js `24.14.0`
- npm `10.9.4`

## Install the source preview

```sh
git clone https://github.com/Dragon-kanji/Kurobara.git
cd Kurobara
npm ci
npm run install:cli -- --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Verify the command from any directory:

```sh
command -v kurobara
kurobara --help
kurobara doctor --json
```

The doctor can report the API and runtime as unavailable before a persistent
stack is running. It still diagnoses the installation, configuration, client
credential, and provider admission.

The launcher is tied to this checkout. Kurobara does not currently publish an
npm package or binary.

## Human onboarding

```sh
kurobara setup
kurobara setup status
kurobara first-run --offline --json
```

The TTY uses a concise black, white, and pink identity. Human Context, Play,
run, and Workbook receipts separate status, constraints, execution stages,
rows, evidence, and review state so the important boundary is visible before
the next action. Workbook columns that do not fit are reported rather than
silently omitted; use `--json` for the complete machine projection.

Color disables for `--no-color`, `NO_COLOR`, and `TERM=dumb`. Watch progress is
interactive-TTY only and disables for `TERM=dumb`, CI, JSON, and
non-interactive execution.

The offline first run proves:

```text
CLI -> HTTP API -> PostgreSQL -> Hatchet -> worker -> durable result -> export
```

It imports synthetic data, applies a deterministic recipe, verifies restart
and backup/restore behavior, exports the result, and removes its temporary
stack. It makes no external provider or LLM call.

## Agent onboarding

Agents must inspect, plan, and apply explicitly:

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

kurobara setup status --json
kurobara first-run --offline --json
```

Do not edit the plan. Its fingerprint binds all steps and secret references.
Machine results expose `completed_steps`, `blocked_steps`, `warnings`,
`requires_confirmation`, and structured `next_actions[].argv`.

## Credentials

Use the system keychain when available. Linux falls back to a private file
outside the repository when `secret-tool` is unavailable; that file must
remain mode `0600`.

Never put a credential value in command arguments:

```sh
kurobara secret set kurobara --from-env KUROBARA_API_KEY --json

printf '%s' "$PROSPEO_API_KEY" |
  kurobara provider configure prospeo --stdin --enable --json
```

`kurobara` is the client API key. Provider keys are server-side and can be
stored only for a local profile. The CLI reports presence and backend metadata,
never secret values.

No provider is enabled merely because a key exists. Exa and PDL retain their
explicit rights gates; PDL remains unavailable in this preview.

## Upgrade or remove

Kurobara performs no background update check. Ask explicitly:

```sh
kurobara --version
kurobara update check --json
git pull --ff-only
npm ci
npm run install:cli -- --prefix "$HOME/.local"
```

Reinstall is idempotent. Supported older configuration is migrated only by an
explicit command:

```sh
kurobara setup migrate --json
```

Remove only the launcher created by this checkout:

```sh
npm run uninstall:cli -- --prefix "$HOME/.local"
```

The uninstaller refuses to remove an unrelated executable.

## Next

- Build a real list: [B2B list workflow](./b2b-lists.md)
- Automate safely: [Agent integration](./agents.md)
- Configure providers: [Providers](./providers.md)
- Run a persistent stack: [Operations and privacy](./operations.md)
