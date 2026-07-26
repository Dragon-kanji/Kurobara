# Providers

Kurobara is BYOK: each operator supplies provider accounts and credentials.
The open-source project supplies adapters and safety controls, not provider
credits, contract rights, or permission to redistribute provider data.

## Current adapters

| Provider | Environment | Current role | Qualification |
| --- | --- | --- | --- |
| Hunter | `HUNTER_API_KEY` | Company discovery; optional work-email resolution and verification | Company discovery qualified live; remaining mappings covered offline |
| Prospeo | `PROSPEO_API_KEY` | Contact shortlist, identity reveal, and work-email resolution | Main contact path qualified live |
| Tavily | `TAVILY_API_KEY` | Organization website resolution | Maintained adapter; explicit route only |
| Exa | `EXA_API_KEY` plus `KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true` | Organization website resolution | Explicit route only; fails closed without rights attestation |
| Apollo | `APOLLO_API_KEY` | Optional contact/company routes | Opt-in and outside the default path; the owner test returned `403` |
| People Data Labs | `PDL_API_KEY` plus `KUROBARA_PDL_DATA_RIGHTS_CONFIRMED=true` | Secondary adapter candidate | Offline-only in this preview; not part of the default runtime |

The default contact order is `prospeo,hunter`. Tavily, Exa, Apollo, and PDL are
never enabled merely because an adapter package exists.

## Provider order

`KUROBARA_PROVIDER_ORDER` is a comma-separated list with no spaces:

```sh
export KUROBARA_PROVIDER_ORDER="prospeo,hunter"
```

The order selects eligible initial routes. It is not a generic waterfall.
Contact generations currently allow one provider attempt per step, so a
Prospeo `not_found`, error, or retryable outage does not automatically call
Hunter.

## Credential handling

- Keep keys in a secret manager or private environment file.
- Inject only the keys required by the API and worker.
- API and worker must use the same route configuration.
- Never pass a provider key through the Kurobara CLI.
- Never commit a real `.env`, provider response, or contact export.
- Redact authorization headers, signed URLs, provider IDs, and personal data
  from logs and bug reports.

Kurobara validates configuration at startup and does not expose credential
values in route descriptors.

## Contact data boundaries

The contact flow deliberately separates:

1. an obfuscated shortlist with no email or phone;
2. a selected identity dataset;
3. a selected work-email dataset;
4. an optional verification dataset;
5. a controlled export with a delivery receipt.

Provider subject IDs remain in restricted lineage. Prospeo mobile enrichment is
forced off. Phone-number enrichment is not part of the current V1 path.

## Cost model

Kurobara records budgets and usage in normalized units such as requests.
Provider billing can differ:

- a successful identity call may consume an email credit even when Kurobara
  strips the email from that step;
- provider-side free re-enrichment windows are not guaranteed by Kurobara;
- plan changes can alter endpoint access or quota behavior;
- an HTTP success does not prove redistribution rights.

Start with the smallest caps and inspect the provider dashboard after the first
run.

## Adding a provider

Use the existing surfaces instead of inventing a new provider protocol:

1. start from [`templates/plugin-adapter`](../templates/plugin-adapter) for an
   external sidecar, or
   [`packages/adapters/provider-example`](../packages/adapters/provider-example)
   for an in-repository adapter;
2. declare the capability, contracts, credential mode, egress hosts, timeouts,
   idempotency and cost model in the manifest;
3. implement configuration validation, estimation, execution, lookup,
   normalization, health and safe error classification through
   [`packages/plugin-sdk`](../packages/plugin-sdk);
4. add hostile-response, timeout, ambiguous-outcome, idempotency, redaction and
   cost-bound tests;
5. for an official in-tree route, add explicit admission in
   [`provider-registry`](../packages/adapters/provider-registry) and runtime
   composition. A package existing in the repository must not enable a route;
6. run packaging and conformance before requesting review.

Every adapter must:

- implement a declared port without leaking provider types into the domain;
- declare capabilities, credential requirements, limits, and cost units;
- validate hostile responses at the adapter boundary;
- preserve idempotency and represent ambiguous outcomes;
- return normalized provenance without secrets;
- pass the plugin packaging and conformance tests;
- document the operator terms and data-handling assumptions.

Run:

```sh
npm run test:plugin-packaging
npm run check
npm run typecheck
npm run build
```

The plugin SDK and conformance packages are source-preview artifacts and are not
published to npm yet. The root packaging test qualifies them through local
tarballs and exercises the external template exactly as shipped.

An adapter merged into the repository is not an endorsement by the provider.
