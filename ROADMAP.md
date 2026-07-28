# Roadmap

Kurobara is an open-source, headless B2B data runtime for CLI, API, and coding
agents. This roadmap describes outcomes, not dates or support commitments.

## Delivered in the source preview

- CSV and JSONL dataset import and export.
- Versioned recipe apply, watch, and direct export.
- Durable PostgreSQL and Hatchet execution with restart safety.
- Company discovery without an input CSV.
- Obfuscated contact shortlist from ready company candidates.
- Selected professional identity and work-email enrichment.
- Explicit work-email verification.
- Contact export receipts, expiry, revocation, and subject restriction.
- REST, TypeScript SDK, and non-interactive CLI projections.
- Resumable human and agent CLI onboarding, secure BYOK references, typed
  diagnostics, and a source-preview launcher.
- BYOK provider adapters with bounded budgets and provenance.
- Deterministic self-host smoke, backup/restore, release manifests, SBOMs, and
  clean-room qualification.

## Next

1. **Usable persistent BYOK self-hosting**
   - a reviewed provider-backed Compose profile;
   - simpler bootstrap and secret injection;
   - operator-visible capability and configuration diagnostics.

2. **Better list building**
   - broader company filters and normalized taxonomies;
   - explicit, policy-driven multi-provider fallback;
   - larger bounded batches and resumable exports;
   - clearer per-provider quote and credit reporting.

3. **Agent ergonomics**
   - generated operation-specific CLI help;
   - stable machine documentation generated from canonical contracts;
   - MCP projection after CLI and REST contracts stabilize;
   - stricter delegated authority and multi-agent run graphs.

4. **Provider ecosystem**
   - external plugin sandbox and network policy;
   - provider conformance profiles;
   - documented compatibility and deprecation policy.

5. **Stable distribution**
   - supported installation path;
   - signed and reproducible packages or images;
   - upgrade, migration, and rollback qualification;
   - stable versioning and compatibility policy.

## Explicitly not in the current preview

- a hosted Kurobara API or managed service;
- a web UI;
- a published npm package or OCI image;
- a native MCP server;
- automatic phone enrichment;
- unbounded autonomous provider calls;
- guaranteed support, SLA, or provider redistribution rights.

Structural changes should preserve the boundaries in
[docs/architecture.md](./docs/architecture.md).
