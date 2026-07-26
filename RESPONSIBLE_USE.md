# Responsible use

Kurobara can call paid providers and process professional contact data. The
operator is responsible for authorization, provider terms, applicable law,
costs, retention, exports, and downstream use.

## Minimum practice

- Use only accounts, systems, and data you are authorized to access.
- Start with `dry-run` and the smallest practical caps.
- Give agents only the permissions, budget, deadline, and data they need.
- Enrich only an explicit contact selection.
- Keep credentials and exports out of Git, prompts, logs, and public issues.
- Preserve provenance and distinguish provider claims from verified facts.
- Stop on ambiguous outcomes rather than spending again blindly.
- Honor opt-outs, deletion requests, provider deletions, and retention limits.
- Review output before using it for outreach or another consequential action.

## Provider responsibility

An adapter, key, successful request, or open-source license does not grant a
right to use or redistribute provider data. Review the account plan, endpoint
terms, territory, purpose, and retention rules for each provider.

## Agent responsibility

Do not give an autonomous agent an unbounded provider key or broad operator
credential. Persist idempotency keys outside the conversation, use finite
polling, and require human review for policy, privacy, or high-cost decisions.

Kurobara's controls reduce accidental scope. They do not replace operator
judgment or legal obligations.

## Contact data

The current flow keeps the initial shortlist obfuscated and derives identity
and email datasets only for selected records. Phone enrichment is outside the
V1 path. Export files remain sensitive even when the source is professional.

Security vulnerabilities follow [SECURITY.md](./SECURITY.md). Non-sensitive
questions follow [SUPPORT.md](./SUPPORT.md).
