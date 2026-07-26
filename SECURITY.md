# Security policy

Kurobara is a pre-release project. No branch or version currently carries a
security-support or response-time commitment.

## Report a vulnerability privately

Use
[GitHub private vulnerability reporting](https://github.com/Dragon-kanji/Kurobara/security/advisories/new).
It is enabled for this repository.

Do not disclose a vulnerability in an issue, pull request, discussion, commit,
support request, log, or social post.

Include only what is needed:

- affected commit and component;
- execution mode and preconditions;
- minimal reproduction steps;
- observed and plausible impact;
- boundaries of your testing and remaining uncertainty;
- redacted evidence using authorized test data;
- whether active exploitation or prior disclosure is known;
- your public-credit preference.

Never include a real credential, unnecessary personal data, full production
dump, provider payload you cannot redistribute, or data obtained outside your
authorization.

## Scope

Relevant reports include:

- authentication, authorization, or workspace-isolation bypass;
- secret, personal-data, or confidential-content exposure;
- unexpected code execution, injection, file access, or network request;
- exploitable supply-chain weakness in Kurobara's use of a dependency;
- agent action beyond granted authority, budget, deadline, or consent;
- integrity or provenance failure affecting durable state or artifacts.

An unimplemented design risk is not a vulnerability in a shipped revision.
Issues in a provider, fork, or deployment belong to its operator unless
Kurobara's integration creates or materially worsens the exposure.

## Safe research

Test only systems, accounts, and data you own or are explicitly authorized to
use. Avoid service disruption, data destruction, unauthorized cost, social
engineering, persistence, mass scanning, privacy invasion, and access beyond
the minimal proof.

Stop when you encounter unexpected real data or the impact exceeds the approved
scope.

## Process

The project may validate scope, request a safer reproduction, prepare a fix or
mitigation, and coordinate publishable details. This is a process description,
not an SLA, embargo, attribution promise, or guarantee of a release.

Non-sensitive bugs and usage questions follow [SUPPORT.md](./SUPPORT.md).
