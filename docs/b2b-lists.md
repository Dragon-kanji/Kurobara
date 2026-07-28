# Build B2B lists

Kurobara can start from search criteria or from an imported CSV/JSONL dataset.
Both paths create the same bounded organization snapshot before contact
discovery. The workflow then creates an obfuscated shortlist, enriches only
selected contacts, and exports the final dataset.

## Current workflow

```text
search criteria OR imported organization domains
  -> bounded organization snapshot
  -> company candidates
  -> contact shortlist
  -> selected identities
  -> selected work emails
  -> optional verification
  -> CSV or JSONL
```

The shortlist never exposes email or phone fields. Identity and work-email
steps create derived datasets instead of mutating the shortlist.

## Fastest live test

The bounded dogfood harness is the safest first provider-backed run. It expects
`HUNTER_API_KEY` and `PROSPEO_API_KEY` in the environment or in an untracked
local environment file already supported by the harness.

Preflight does not call a provider:

```sh
npm run b2b:dogfood:preflight
```

Review the machine-readable preflight, then explicitly allow calls:

```sh
npm run b2b:dogfood -- run --confirm-provider-calls
```

The harness is capped at three companies, three contacts, and four provider
requests. It runs the real CLI, API, PostgreSQL, Hatchet, Hunter, and Prospeo
path through a GTM Context, approved Play, interrupted and resumed Play run,
Workbook inspection, one human approval, and private export. It then removes
its private CSV and temporary runtime. It is a qualification tool, not a
persistent campaign runner.

## Persistent CLI workflow

A reusable environment must run the API and worker against the same PostgreSQL
database, Hatchet instance, planning snapshots, provider keys, privacy keyring,
and provider order. The source preview does not yet ship a production-ready
BYOK Compose profile; compose and review that environment explicitly.

The following commands show the product flow after the runtime and API key are
ready. Use synthetic or authorized values and keep every cap small for the
first run.

### 1. Plan company discovery

```sh
deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"

npm run kurobara -- company search \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --authority-envelope-id authority-company-local \
  --budget-limit 1 \
  --budget-unit requests \
  --country ES \
  --industry software \
  --dataset-id "companies-${run_id}" \
  --dataset-name "Spanish software companies" \
  --deadline-ms "${deadline_ms}" \
  --discovery-id "company-search-${run_id}" \
  --max-calls 1 \
  --max-companies 20 \
  --max-pages 1 \
  --mode dry-run
```

The Hunter adapter accepts one ISO alpha-2 country. `gaming` and `software`
have exact Hunter mappings. Other bounded `kurobara-v1` industry codes, such as
`pet-food`, use Hunter's declared keyword fallback and remain visible in the
provider registry; Kurobara does not relabel them. Employee bounds are optional
but must be provided together.

Inspect the JSON quote. To start the exact same intent before it expires,
repeat the command with the same IDs and values and change only:

```sh
--mode start
```

Store the returned `generation_id`.

### 2. Wait and read companies

```sh
npm run kurobara -- company watch \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --generation-id "<company-generation-id>" \
  --poll-interval-ms 1000 \
  --timeout-ms 300000

npm run kurobara -- company results \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --generation-id "<company-generation-id>" \
  --limit 100
```

Do not continue until the generation is `ready`.

### 3. Build a contact shortlist

Choose exactly one organization source:

- a ready company generation using `--organization-generation-id`; or
- a completed imported dataset using `--organization-dataset-id`.

With a ready company generation:

```sh
deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"

npm run kurobara -- contact search \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --authority-envelope-id authority-contact-local \
  --budget-limit 2 \
  --budget-unit requests \
  --company-country ES \
  --person-country ES \
  --title "Sales Director" \
  --seniority director \
  --organization-generation-id "<company-generation-id>" \
  --dataset-id "contacts-${run_id}" \
  --dataset-name "Sales leaders" \
  --deadline-ms "${deadline_ms}" \
  --discovery-id "contact-search-${run_id}" \
  --max-calls 2 \
  --max-companies 2 \
  --max-contacts-per-company 1 \
  --max-contacts-total 2 \
  --max-pages 2 \
  --mode dry-run
```

With an imported dataset, map the domain column and optionally the company
name and country columns. If no country column exists, provide an explicit
default:

```sh
npm run kurobara -- contact search \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --authority-envelope-id authority-contact-local \
  --budget-limit 2 \
  --budget-unit requests \
  --organization-dataset-id "<imported-company-dataset-id>" \
  --domain-field website \
  --name-field company_name \
  --default-company-country FR \
  --title "Category Manager" \
  --seniority manager \
  --dataset-id "contacts-${run_id}" \
  --dataset-name "Petfood category managers" \
  --deadline-ms "${deadline_ms}" \
  --discovery-id "contact-search-import-${run_id}" \
  --max-calls 2 \
  --max-companies 3 \
  --max-contacts-per-company 1 \
  --max-contacts-total 3 \
  --max-pages 2 \
  --mode dry-run
```

Accepted domain inputs may be hostnames or HTTP(S) URLs. Kurobara lowercases
and IDNA-normalizes them, strips ports and URL paths, preserves subdomains, and
rejects credentials, IP addresses, local/single-label hosts, and malformed
labels. It performs no DNS request and does not collapse domains.

The JSON response includes `organization_source` with the imported dataset and
materialization IDs, content hash, mapping, and accepted, rejected, duplicate,
and truncated counts. This lineage is part of the immutable plan.

Review the quote, repeat with `--mode start`, wait with `company watch`, then
read the shortlist:

```sh
npm run kurobara -- contact results \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --generation-id "<contact-generation-id>" \
  --limit 100
```

The result contains Kurobara record IDs, an obfuscated display identity,
employment context, and company context. Provider subject IDs remain in
restricted lineage. Email and phone are not returned.

### 4. Enrich an explicit selection

Choose one to three unique Kurobara record IDs from the same contact dataset.
Each operation needs a unique idempotency key, deadline, authority, and budget.

```sh
deadline_ms="$(( $(date +%s) * 1000 + 300000 ))"

npm run kurobara -- contact reveal-identity \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --contact-dataset-id "<contact-dataset-id>" \
  --record-id "<record-id>" \
  --operation-id "identity-${run_id}" \
  --authority-envelope-id authority-contact-local \
  --deadline-ms "${deadline_ms}" \
  --budget-limit 1 \
  --budget-unit requests
```

Wait for the returned generation. Use its `result_dataset_id` as the input to
work-email resolution:

```sh
npm run kurobara -- contact enrich-email \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --contact-dataset-id "<identity-dataset-id>" \
  --record-id "<record-id>" \
  --operation-id "email-${run_id}" \
  --authority-envelope-id authority-contact-local \
  --deadline-ms "${deadline_ms}" \
  --budget-limit 1 \
  --budget-unit requests
```

Verification is intentionally separate. Read `work_email_verification` first,
then call `contact verify-email` only when your policy requires another check.

### 5. Export

```sh
npm run kurobara -- dataset export \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file .local/api-key \
  --dataset-id "<final-dataset-id>" \
  --format csv \
  --output .local/contacts.csv \
  --receipt .local/contacts.receipt.json \
  --max-bytes 1048576 \
  --timeout-ms 300000
```

Contact exports require both `datasets:export` and `contacts:export`, a server
side export policy, and a stable privacy keyring. The receipt records delivery
state and expiry without placing credentials in the CSV.

## Cost and failure rules

- Always run `dry-run` before `start`.
- Use call, page, company, contact, deadline, and budget caps.
- Reusing an idempotency key with different input is rejected.
- Contact discovery currently makes one provider attempt per step; it does not
  automatically call a second provider after `not_found` or an error.
- An ambiguous provider outcome stops further spending until reconciled.
- Kurobara records request usage, but a provider can apply its own credit rules.

Provider-specific behavior is documented in [Providers](./providers.md).
Privacy and export controls are documented in
[Operations and privacy](./operations.md).
