// biome-ignore-all lint/suspicious/noMisplacedAssertion: assertion helpers are called only by the node:test cases in this file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import { createDeterministicDatasetGenerationPageEffect } from "@kurobara/adapter-effect-deterministic";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeAuthorizeFirstDatasetGenerationPage,
  makeCheckpointFirstDatasetGenerationPage,
  makeClaimRunExecution,
  makeCreateDatasetGeneration,
  makeExecuteLeafAttemptRegistry,
  makeImportDataset,
  makeListCompanyCandidates,
  makeMaterializeNextDagRun,
  makePlanDatasetGeneration,
  makeRouteAndClaimNextReadyStep,
  type PlanDatasetGenerationDependencies,
  type PlanDatasetGenerationRequest,
} from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  createDataset,
  type DatasetGenerationPageArtifact,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  eventId,
  fieldId,
  idempotencyKey,
  instant,
  outboxMessageId,
  recordId,
  runId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  LeafEffectFinalOutcome,
  LeafEffectPort,
  LeafEffectRequest,
} from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_generation_page_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
const sql = postgres(databaseUrl.toString(), { max: 6 });
let runtime: PostgresRuntime;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
});

after(async () => {
  await runtime.close();
  await sql.end({ timeout: 5 });
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const hash = (value: string) =>
  contentHash(`sha256:${createHash("sha256").update(value).digest("hex")}`);

const now = instant(1_900_000_000_000);
const deadline = instant(now + 60_000);
const adapterKey = "deterministic-dataset-generation-page";
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;
const contactCapability = {
  capabilityId: capabilityId("contacts.discover"),
  capabilityVersion: "1.0.0",
} as const;
const identityCapability = {
  capabilityId: capabilityId("contacts.identity.reveal"),
  capabilityVersion: "1.0.0",
} as const;
const identityProviderNamespace = "prospeo-person-search";
const limits = {
  maxCalls: 1,
  maxCompanies: 10,
  maxContactsPerCompany: 0,
  maxContactsTotal: 0,
  maxEnrichments: 0,
  maxPages: 1,
  maxPhones: 0,
  maxResults: 10,
} as const;

const requestFor = (
  marker: string,
  useContactCapability = false
): PlanDatasetGenerationRequest => {
  const workspace = workspaceId(`workspace-generation-page-${marker}`);
  const target = datasetId(`dataset-generation-page-${marker}`);
  const selectedCapability = useContactCapability
    ? contactCapability
    : capability;
  const selectedLimits = useContactCapability
    ? {
        ...limits,
        maxCompanies: 1,
        maxContactsPerCompany: 1,
        maxContactsTotal: 1,
      }
    : limits;
  return {
    actorId: actorId("actor-generation-page"),
    authorityEnvelopeId: `authority-generation-page-${marker}`,
    capability: selectedCapability,
    fields: [
      {
        datasetId: target,
        fieldId: fieldId(`field-company-name-${marker}`),
        key: "name",
        label: "Company name",
        valueType: "string",
        workspaceId: workspace,
      },
      {
        datasetId: target,
        fieldId: fieldId(`field-company-domain-${marker}`),
        key: "domain",
        label: "Company domain",
        valueType: "string",
        workspaceId: workspace,
      },
      {
        datasetId: target,
        fieldId: fieldId(`field-company-country-${marker}`),
        key: "country_code",
        label: "Headquarters country",
        valueType: "string",
        workspaceId: workspace,
      },
      {
        datasetId: target,
        fieldId: fieldId(`field-company-industry-${marker}`),
        key: "industry_code",
        label: "Industry",
        valueType: "string",
        workspaceId: workspace,
      },
      {
        datasetId: target,
        fieldId: fieldId(`field-company-employees-${marker}`),
        key: "employee_count",
        label: "Employee count",
        valueType: "number",
        workspaceId: workspace,
      },
      {
        datasetId: target,
        fieldId: fieldId(`field-company-observed-${marker}`),
        key: "observed_at_ms",
        label: "Observed at",
        valueType: "number",
        workspaceId: workspace,
      },
    ],
    idempotencyKey: idempotencyKey(`generation-page-plan-${marker}`),
    limits: selectedLimits,
    query: useContactCapability
      ? {
          company_headquarters_country_codes: ["ES"],
          departments: [],
          organization_generation_id: `organization-generation-${marker}`,
          organizations: [
            {
              company_id: `company-${marker}`,
              country_code: "ES",
              domain: `${marker}.example`,
              name: `Company ${marker}`,
            },
          ],
          person_country_codes: [],
          result_kind: "contact",
          seniorities: [],
          titles: ["Founder"],
        }
      : { country: "ES", industry: "software" },
    requestedBudget: { limit: 2, unit: "credits" },
    requestedDeadline: deadline,
    targetDataset: {
      datasetId: target,
      name: `Synthetic generation ${marker}`,
      workspaceId: workspace,
    },
    unknownCostPolicy: { mode: "deny" },
    workspaceId: workspace,
  };
};

const identityRequestFor = (marker: string): PlanDatasetGenerationRequest => {
  const workspace = workspaceId(`workspace-generation-page-${marker}`);
  const target = datasetId(`dataset-generation-page-${marker}`);
  const sourceDataset = datasetId(`source-contact-${marker}`);
  const sourceRecord = recordId(`source-record-${marker}`);
  const fields = [
    ["display_name", "Display name", "string"],
    ["identity_completeness", "Identity completeness", "string"],
    ["identity_status", "Identity status", "string"],
    ["organization_domain", "Company domain", "string"],
    ["observed_at_ms", "Employment observed at", "number"],
  ] as const;
  return {
    actorId: actorId("actor-generation-page"),
    authorityEnvelopeId: `authority-generation-page-${marker}`,
    capability: identityCapability,
    fields: fields.map(([key, label, valueType]) => ({
      datasetId: target,
      fieldId: fieldId(`field-${key}-${marker}`),
      key,
      label,
      valueType,
      workspaceId: workspace,
    })),
    idempotencyKey: idempotencyKey(`generation-page-plan-${marker}`),
    limits: {
      ...limits,
      maxCompanies: 0,
      maxContactsTotal: 1,
      maxEnrichments: 1,
      maxResults: 1,
    },
    providerIdentityNamespace: identityProviderNamespace,
    query: {
      result_kind: "contact_identity",
      selected_contacts: [
        {
          candidate: {
            department: "Executive",
            display_name: "Synthetic Founder",
            identity_completeness: "obfuscated",
            job_title: "Founder",
            observed_at_ms: now,
            organization_domain: `${marker}.example`,
            organization_id: `company-${marker}`,
            organization_name: `Company ${marker}`,
            person_country_code: "ES",
            profile_url: null,
            seniority: "founder",
          },
          provider_identity: {
            provider_key: identityProviderNamespace,
            provider_subject_id: `prospeo-person-${marker}`,
          },
          source_record_id: sourceRecord,
        },
      ],
      source_dataset_id: sourceDataset,
    },
    requestedBudget: { limit: 2, unit: "credits" },
    requestedDeadline: deadline,
    targetDataset: {
      datasetId: target,
      name: `Synthetic generation ${marker}`,
      workspaceId: workspace,
    },
    unknownCostPolicy: { mode: "deny" },
    workspaceId: workspace,
  };
};

const planningDependencies = (
  marker: string,
  selectedCapability: PlanDatasetGenerationRequest["capability"] = capability
): PlanDatasetGenerationDependencies => ({
  clock: { now: async () => now },
  identifiers: {
    nextDatasetGenerationPlanId: async () =>
      datasetGenerationPlanId(`generation-page-plan-${marker}`),
  },
  normalizer: {
    normalize: (input) => ({
      capability: input.capability,
      contract: {
        catalogFingerprint: hash(`catalog-${marker}`),
        catalogVersion: "1.0.0",
        schemaFingerprint: hash(`query-schema-${marker}`),
        schemaId: `${selectedCapability.capabilityId}.query`,
        schemaVersion: "1.0.0",
      },
      normalizerVersion: "integration-1.0.0",
      status: "accepted",
      value: input.query,
    }),
  },
  persistence: runtime.datasetGenerationPlanning,
  snapshots: {
    resolve: (input) =>
      Promise.resolve({
        authority: {
          authorityEnvelopeId: input.authorityEnvelopeId,
          budgetLimit: {
            limit: 2,
            reserved: 0,
            spent: 0,
            unit: "credits",
          },
          capabilities: [selectedCapability],
          deadline,
          permissions: ["datasets:generate", "steps:execute"],
          subjectActorId: input.actorId,
          version: "1.0.0",
          workspaceId: input.workspaceId,
        },
        budget: { limit: 2, reserved: 0, spent: 0, unit: "credits" },
        deadline,
        policy: {
          factsHash: hash(`facts-${marker}`),
          requiredPermission: "datasets:generate",
          version: "1.0.0",
        },
        quote: {
          expiresAt: instant(deadline + 60_000),
          guarantee: "hard",
          pricingVersion: "pricing-1.0.0",
          quoteId: `quote-${marker}`,
          unit: "credits",
          upperBound: 1,
        },
        routeSnapshots: [
          {
            capability: selectedCapability,
            effectAdapterKey: adapterKey,
            factsHash: hash(`facts-${marker}`),
            pricingVersion: "pricing-1.0.0",
            reservableUpperBound: 1,
            reservationUnit: "credits",
            routeKey: `route-${marker}`,
            ...(selectedCapability.capabilityId ===
            identityCapability.capabilityId
              ? { providerIdentityNamespace: identityProviderNamespace }
              : {}),
          },
        ],
        unknownCostPolicy: input.requestedUnknownCostPolicy,
      }),
  },
});

let identitySequence = 0;
const identifiers = (marker: string) => ({
  nextEventId: async () => eventId(`event-${marker}-${++identitySequence}`),
  nextOutboxMessageId: async () =>
    outboxMessageId(`outbox-${marker}-${++identitySequence}`),
  nextRunId: async () => runId(`run-${marker}-${++identitySequence}`),
});

type PageMode =
  | "ambiguous"
  | "contact"
  | "deadline"
  | "empty"
  | "identity"
  | "record";

const executeGeneration = async (marker: string, mode: PageMode) => {
  const useContactCapability = mode === "contact";
  const useIdentityCapability = mode === "identity";
  const request = useIdentityCapability
    ? identityRequestFor(marker)
    : requestFor(marker, useContactCapability);
  await sql`
    INSERT INTO kurobara_core.workspaces (workspace_id)
    VALUES (${request.workspaceId})
  `;
  if (useIdentityCapability) {
    const sourceDatasetId = datasetId(`source-contact-${marker}`);
    const sourceRecordId = recordId(`source-record-${marker}`);
    const sourceDataset = createDataset({
      datasetId: sourceDatasetId,
      name: `Synthetic source contacts ${marker}`,
      workspaceId: request.workspaceId,
    });
    if (!sourceDataset.ok) {
      throw new Error(sourceDataset.error.message);
    }
    const source = JSON.stringify({
      dataset_id: sourceDatasetId,
      record_id: sourceRecordId,
      values: [],
      workspace_id: request.workspaceId,
    });
    const imported = await makeImportDataset({
      codecs: {
        csv: createCsvDatasetCodec(),
        jsonl: createJsonlDatasetCodec(),
      },
      datasets: runtime.datasets,
      requiredPermission: "datasets:import",
    })({
      actor: {
        actorId: request.actorId,
        authenticationMode: "api-key",
        credentialId: `credential-source-${marker}`,
        permissions: ["datasets:import"],
        workspaceId: request.workspaceId,
      },
      batchLimits: { maxBytes: 1024, maxItems: 1 },
      bytes: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield new TextEncoder().encode(source);
        },
      },
      dataset: sourceDataset.value,
      fields: [],
      format: "jsonl",
      importId: `source-import-${marker}`,
      maxRecordBytes: 1024,
      sourceContentHash: hash(source),
    });
    if (!imported.ok) {
      throw new Error(imported.error.message);
    }
  }
  const planned = await makePlanDatasetGeneration(
    planningDependencies(marker, request.capability)
  )(request);
  if (!planned.ok) {
    throw new Error(planned.error.message);
  }
  assert.equal(planned.ok, true);
  const created = await makeCreateDatasetGeneration({
    clock: { now: async () => now },
    identifiers: {
      nextDatasetGenerationId: async () =>
        datasetGenerationId(`generation-page-${marker}`),
    },
    persistence: runtime.datasetGeneration,
  })({
    generationPlanId: planned.value.plan.generationPlanId,
    workspaceId: request.workspaceId,
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  assert.equal(created.ok, true);
  const authorize = makeAuthorizeFirstDatasetGenerationPage({
    clock: { now: async () => instant(now + 100) },
    identifiers: identifiers(marker),
    persistence: runtime.datasetGenerationFirstPage,
  });
  const authorizationRequest = {
    actorId: request.actorId,
    actorPermissions: ["datasets:generate", "steps:execute"],
    authenticationMode: "api-key",
    correlationId: correlationId(`correlation-${marker}`),
    generationId: created.value.creation.generation.generationId,
    workspaceId: request.workspaceId,
  } as const;
  const [authorized, replay] = await Promise.all([
    authorize(authorizationRequest),
    authorize(authorizationRequest),
  ]);
  assert.equal(authorized.ok, true);
  assert.equal(replay.ok, true);
  if (!(authorized.ok && replay.ok)) {
    throw new Error("The first page was not durably authorized.");
  }
  assert.equal(authorized.value.page.runId, replay.value.page.runId);
  assert.deepEqual([authorized.value.replayed, replay.value.replayed].sort(), [
    false,
    true,
  ]);

  const bindingRows = await sql<
    readonly { event_id: string; start_key: string }[]
  >`
    SELECT message.event_id, binding.start_key
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.workspace_id = ${request.workspaceId}
      AND binding.run_id = ${authorized.value.page.runId}
  `;
  const runBinding = bindingRows[0];
  assert.ok(runBinding);
  const claim = await makeClaimRunExecution({
    clock: { now: async () => instant(now + 200) },
    identifiers: identifiers(`${marker}-claim`),
    persistence: runtime.runExecution,
  })({
    eventId: eventId(runBinding.event_id),
    runId: authorized.value.page.runId,
    startKey: runBinding.start_key,
    workspaceId: request.workspaceId,
  });
  assert.equal(claim.ok, true);

  const materialize = makeMaterializeNextDagRun({
    clock: { now: async () => instant(now + 10_000 + identitySequence) },
    identifiers: {
      nextEventId: async () => eventId(`dag-${marker}-${++identitySequence}`),
    },
    persistence: runtime.dagScheduling,
  });
  let root: Awaited<ReturnType<typeof materialize>> | undefined;
  for (let attemptNumber = 0; attemptNumber < 10; attemptNumber += 1) {
    const candidate = await materialize();
    if (
      candidate.status === "processed" &&
      candidate.runId === authorized.value.page.runId
    ) {
      root = candidate;
      break;
    }
  }
  assert.equal(root?.status, "processed");
  const routed = await makeRouteAndClaimNextReadyStep({
    availableEffectAdapterKeys: [adapterKey],
    clock: { now: async () => instant(now + 400) },
    persistence: runtime.stepRouting,
    requiredPermission: "steps:execute",
    retryDelayMilliseconds: 1000,
  })();
  assert.equal(routed.status, "claimed");
  if (routed.status !== "claimed" || !routed.result.ok) {
    throw new Error("The generation page route was not claimed.");
  }
  const attempt = routed.result.value.stepRun.attempts.at(-1);
  assert.ok(attempt);
  const leafRows = await sql<
    readonly { event_id: string; start_key: string }[]
  >`
    SELECT event_id, start_key
    FROM kurobara_core.step_leaf_execution_bindings
    WHERE workspace_id = ${request.workspaceId}
      AND attempt_id = ${attempt.attemptId}
  `;
  const leaf = leafRows[0];
  assert.ok(leaf);

  const expectedInput = {
    capability: planned.value.plan.requestIntent.capability,
    datasetId: planned.value.plan.requestIntent.targetDataset.datasetId,
    fields: planned.value.plan.requestIntent.fields,
    generationId: created.value.creation.generation.generationId,
    generationPlanId: planned.value.plan.generationPlanId,
    inputCursor: null,
    kind: "dataset-generation-page-input" as const,
    limits: {
      ...planned.value.plan.limits,
      maxResults: Math.min(
        planned.value.plan.limits.maxResults,
        useContactCapability || useIdentityCapability
          ? planned.value.plan.limits.maxContactsTotal
          : planned.value.plan.limits.maxCompanies
      ),
    },
    normalizedQuery: planned.value.plan.normalizedQuery,
    pageSequence: 1 as const,
    planHash: planned.value.plan.planHash,
    queryHash: planned.value.plan.queryHash,
    schemaHash: planned.value.plan.schemaHash,
    version: "1.0.0" as const,
    workspaceId: request.workspaceId,
  };
  const generatedRecord = {
    datasetId: request.targetDataset.datasetId,
    recordId: useIdentityCapability
      ? recordId(`source-record-${marker}`)
      : recordId(`record-${marker}`),
    values: request.fields.map((field) => ({
      fieldId: field.fieldId,
      value:
        {
          country_code: "ES",
          domain: `${marker}.example`,
          employee_count: 42,
          industry_code: "software",
          name: `Company ${marker}`,
          observed_at_ms: now,
          display_name: "Synthetic Founder",
          identity_completeness: "full",
          identity_status: "found",
          organization_domain: `${marker}.example`,
        }[field.key] ?? null,
    })),
    workspaceId: request.workspaceId,
  };
  const ambiguousExecutions: LeafEffectRequest[] = [];
  const ambiguousPort: LeafEffectPort = {
    adapterKey,
    execute: (effectRequest) => {
      ambiguousExecutions.push(structuredClone(effectRequest));
      return Promise.resolve({
        reason: "synthetic-provider-timeout",
        status: "outcome-unknown",
      });
    },
    lookup: () =>
      Promise.resolve({
        reason: "synthetic-provider-still-unknown",
        status: "outcome-unknown",
      }),
  };
  const baseEffect = createDeterministicDatasetGenerationPageEffect({
    expectedInput,
    page:
      mode === "empty" || mode === "deadline"
        ? { kind: "empty-certain" }
        : {
            hasMore: false,
            kind: "records",
            nextCursor: null,
            records: [generatedRecord],
            sourcePartitionCompleted: true,
          },
    settlementAmount: 0.5,
  });
  const withContactIdentity = (
    outcome: LeafEffectFinalOutcome
  ): LeafEffectFinalOutcome => {
    if (outcome.status !== "succeeded") {
      return outcome;
    }
    const output = outcome.output as DatasetGenerationPageArtifact;
    return {
      ...outcome,
      output: {
        ...output,
        items: output.items.map((item) => ({
          ...item,
          providerIdentity: {
            providerKey: adapterKey,
            providerSubjectId: `apollo-person-${marker}`,
          },
        })),
      },
    };
  };
  const contactEffect = {
    history: baseEffect.history,
    port: {
      adapterKey,
      execute: async (effectRequest: LeafEffectRequest) => {
        const outcome = await baseEffect.port.execute(effectRequest);
        return outcome.status === "outcome-unknown"
          ? outcome
          : withContactIdentity(outcome);
      },
      lookup: async (effectRequest: LeafEffectRequest) => {
        const outcome = await baseEffect.port.lookup(effectRequest);
        return outcome.status === "found"
          ? { ...outcome, outcome: withContactIdentity(outcome.outcome) }
          : outcome;
      },
    },
  };
  const withDerivedContactLineage = (
    outcome: LeafEffectFinalOutcome
  ): LeafEffectFinalOutcome => {
    const withIdentity = withContactIdentity(outcome);
    if (withIdentity.status !== "succeeded") {
      return withIdentity;
    }
    const output = withIdentity.output as DatasetGenerationPageArtifact;
    return {
      ...withIdentity,
      output: {
        ...output,
        items: output.items.map((item) => ({
          ...item,
          providerIdentity: {
            providerKey: identityProviderNamespace,
            providerSubjectId: `prospeo-person-${marker}`,
          },
          source: {
            datasetId: datasetId(`source-contact-${marker}`),
            recordId: recordId(`source-record-${marker}`),
          },
        })),
      },
    };
  };
  const identityEffect = {
    history: baseEffect.history,
    port: {
      adapterKey,
      execute: async (effectRequest: LeafEffectRequest) => {
        const outcome = await baseEffect.port.execute(effectRequest);
        return outcome.status === "outcome-unknown"
          ? outcome
          : withDerivedContactLineage(outcome);
      },
      lookup: async (effectRequest: LeafEffectRequest) => {
        const outcome = await baseEffect.port.lookup(effectRequest);
        return outcome.status === "found"
          ? { ...outcome, outcome: withDerivedContactLineage(outcome.outcome) }
          : outcome;
      },
    },
  };
  let effect = baseEffect;
  if (mode === "ambiguous") {
    effect = {
      history: () => ({ executions: ambiguousExecutions, lookups: [] }),
      port: ambiguousPort,
    };
  } else if (useContactCapability) {
    effect = contactEffect;
  } else if (useIdentityCapability) {
    effect = identityEffect;
  }
  const execute = makeExecuteLeafAttemptRegistry({
    clock: {
      now: async () =>
        mode === "deadline"
          ? instant(deadline + 1)
          : instant(now + 500 + identitySequence),
    },
    effects: [effect.port],
    identifiers: {
      nextEventId: async () => eventId(`leaf-${marker}-${++identitySequence}`),
    },
    outputValidator: {
      validate: async () => ({
        status: "accepted" as const,
        validatorVersion: "generation-page-integration-1.0.0",
      }),
    },
    persistence: runtime.stepExecution,
    queries: runtime.stepQueries,
    requiredPermission: "steps:execute",
  });
  const executed = await execute({
    attemptId: attempt.attemptId,
    eventId: eventId(leaf.event_id),
    runId: authorized.value.page.runId,
    startKey: leaf.start_key,
    stepRunId: routed.stepRunId,
    workspaceId: request.workspaceId,
  });
  if (mode === "deadline") {
    assert.equal(executed.ok, true);
    if (executed.ok) {
      assert.equal(executed.value.status, "failed");
    }
    assert.equal(effect.history().executions.length, 0);
    const deniedRows = await sql<
      readonly { generation_state: string; page_state: string }[]
    >`
      SELECT
        generation.state AS generation_state,
        page.state AS page_state
      FROM kurobara_core.dataset_generations AS generation
      JOIN kurobara_core.dataset_generation_pages AS page
        ON page.workspace_id = generation.workspace_id
        AND page.generation_id = generation.generation_id
      WHERE generation.workspace_id = ${request.workspaceId}
        AND generation.generation_id = ${created.value.creation.generation.generationId}
    `;
    assert.deepEqual(deniedRows[0], {
      generation_state: "planned",
      page_state: "run_created",
    });
    return {
      authorizationRequest,
      datasetId: request.targetDataset.datasetId,
      effect,
      generationId: created.value.creation.generation.generationId,
      mode,
      workspaceId: request.workspaceId,
    };
  }
  if (mode === "ambiguous") {
    assert.equal(executed.ok, true);
    if (executed.ok) {
      assert.equal(executed.value.status, "ambiguous");
    }
    assert.equal(effect.history().executions.length, 1);
    const ambiguousRows = await sql<
      readonly {
        generation_state: string;
        materialization_state: string;
        page_state: string;
      }[]
    >`
      SELECT
        generation.state AS generation_state,
        materialization.state AS materialization_state,
        page.state AS page_state
      FROM kurobara_core.dataset_generations AS generation
      JOIN kurobara_core.dataset_materializations AS materialization
        ON materialization.workspace_id = generation.workspace_id
        AND materialization.materialization_id = generation.materialization_id
      JOIN kurobara_core.dataset_generation_pages AS page
        ON page.workspace_id = generation.workspace_id
        AND page.generation_id = generation.generation_id
      WHERE generation.workspace_id = ${request.workspaceId}
        AND generation.generation_id = ${created.value.creation.generation.generationId}
    `;
    assert.deepEqual(ambiguousRows[0], {
      generation_state: "ambiguous",
      materialization_state: "ambiguous",
      page_state: "ambiguous",
    });
    return {
      authorizationRequest,
      datasetId: request.targetDataset.datasetId,
      effect,
      generationId: created.value.creation.generation.generationId,
      mode,
      workspaceId: request.workspaceId,
    };
  }
  if (!executed.ok) {
    throw new Error(executed.error.message);
  }
  assert.equal(executed.ok, true);
  assert.equal(executed.value.status, "succeeded");
  let converged: Awaited<ReturnType<typeof materialize>> | undefined;
  for (let attemptNumber = 0; attemptNumber < 10; attemptNumber += 1) {
    const candidate = await materialize();
    if (
      candidate.status === "processed" &&
      candidate.runId === authorized.value.page.runId
    ) {
      converged = candidate;
      break;
    }
  }
  assert.equal(converged?.status, "processed");
  if (converged?.status === "processed") {
    assert.equal(converged.finalized?.run.state, "completed");
  }
  return {
    authorizationRequest,
    datasetId: request.targetDataset.datasetId,
    effect,
    generationId: created.value.creation.generation.generationId,
    mode,
    workspaceId: request.workspaceId,
  };
};

test("checkpoints a canonical generated page after restart without a second provider effect", async () => {
  const fixture = await executeGeneration("records", "record");
  assert.equal(fixture.effect.history().executions.length, 1);
  const restarted = createPostgresRuntime(databaseUrl.toString());
  try {
    const checkpoint = makeCheckpointFirstDatasetGenerationPage({
      clock: { now: async () => instant(now + 1000) },
      persistence: restarted.datasetGenerationFirstPage,
    });
    const first = await checkpoint({
      generationId: fixture.generationId,
      workspaceId: fixture.workspaceId,
    });
    const replay = await checkpoint({
      generationId: fixture.generationId,
      workspaceId: fixture.workspaceId,
    });
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    if (first.ok && replay.ok) {
      assert.equal(first.value.status, "checkpointed");
      assert.equal(replay.value.status, "unchanged");
      assert.equal(first.value.page.providerKey, adapterKey);
      assert.equal(first.value.page.returnedCount, 1);
    }
    const candidates = await makeListCompanyCandidates({
      generations: restarted.datasetGeneration,
      records: restarted.datasetRecordPages,
    })({
      actor: {
        actorId: actorId("actor-generation-page"),
        authenticationMode: "api-key",
        credentialId: "credential-generation-page",
        permissions: ["datasets:read"],
        workspaceId: fixture.workspaceId,
      },
      afterOrdinal: 0,
      generationId: fixture.generationId,
      limit: 1,
    });
    assert.equal(candidates.ok, true);
    if (candidates.ok) {
      assert.deepEqual(candidates.value.items, [
        {
          candidate: {
            companyId: "record-records",
            countryCode: "ES",
            domain: "records.example",
            employeeCount: 42,
            industryCode: "software",
            name: "Company records",
            observedAtMs: now,
          },
          ordinal: 1,
        },
      ]);
      assert.deepEqual(candidates.value.page, {
        afterOrdinal: 0,
        hasMore: false,
        limit: 1,
        nextAfterOrdinal: null,
      });
      assert.equal(candidates.value.generation.datasetId, fixture.datasetId);
    }
  } finally {
    await restarted.close();
  }
  assert.equal(fixture.effect.history().executions.length, 1);
  const rows = await sql<
    readonly { lineage: string; records: string; usage: string }[]
  >`
    SELECT
      (SELECT count(*)::text
       FROM kurobara_core.dataset_records
       WHERE workspace_id = ${fixture.workspaceId}
         AND generation_id = ${fixture.generationId}) AS records,
      (SELECT count(*)::text
       FROM kurobara_core.dataset_generation_record_lineage
       WHERE workspace_id = ${fixture.workspaceId}
         AND generation_id = ${fixture.generationId}) AS lineage,
      (SELECT count(*)::text
       FROM kurobara_core.usage_ledger_entries
       WHERE workspace_id = ${fixture.workspaceId}) AS usage
  `;
  assert.deepEqual(rows[0], { lineage: "1", records: "1", usage: "1" });
});

test("commits a certain empty first page and locks the durable provider", async () => {
  const fixture = await executeGeneration("empty", "empty");
  const checkpoint = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: async () => instant(now + 1200) },
    persistence: runtime.datasetGenerationFirstPage,
  })({ generationId: fixture.generationId, workspaceId: fixture.workspaceId });
  assert.equal(checkpoint.ok, true);
  if (checkpoint.ok) {
    assert.equal(checkpoint.value.status, "checkpointed");
    assert.equal(checkpoint.value.page.returnedCount, 0);
    assert.equal(checkpoint.value.page.sourcePartitionCompleted, true);
    assert.equal(checkpoint.value.page.providerKey, adapterKey);
  }
  assert.equal(fixture.effect.history().executions.length, 1);
});

test("persists contact provider identity in immutable lineage without leaking it into the dataset record", async () => {
  const fixture = await executeGeneration("contact-lineage", "contact");
  const checkpoint = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: async () => instant(now + 1250) },
    persistence: runtime.datasetGenerationFirstPage,
  })({ generationId: fixture.generationId, workspaceId: fixture.workspaceId });
  assert.equal(checkpoint.ok, true);
  const rows = await sql<
    readonly {
      provider_key: string | null;
      provider_subject_id: string | null;
      record: unknown;
    }[]
  >`
    SELECT lineage.provider_key, lineage.provider_subject_id, record.record
    FROM kurobara_core.dataset_generation_record_lineage AS lineage
    JOIN kurobara_core.dataset_records AS record
      ON record.workspace_id = lineage.workspace_id
      AND record.dataset_id = lineage.dataset_id
      AND record.record_id = lineage.record_id
    WHERE lineage.workspace_id = ${fixture.workspaceId}
      AND lineage.generation_id = ${fixture.generationId}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.provider_key, adapterKey);
  assert.equal(rows[0]?.provider_subject_id, "apollo-person-contact-lineage");
  assert.equal(
    Object.hasOwn((rows[0]?.record ?? {}) as object, "providerIdentity"),
    false
  );
  await assert.rejects(
    sql`
      UPDATE kurobara_core.dataset_generation_record_lineage
      SET provider_subject_id = 'changed'
      WHERE workspace_id = ${fixture.workspaceId}
        AND generation_id = ${fixture.generationId}
    `
  );
});

test("finalizes and checkpoints a selected contact identity artifact with exact source lineage", async () => {
  const fixture = await executeGeneration("selected-identity", "identity");
  const checkpoint = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: async () => instant(now + 1275) },
    persistence: runtime.datasetGenerationFirstPage,
  })({ generationId: fixture.generationId, workspaceId: fixture.workspaceId });
  if (!checkpoint.ok) {
    throw new Error(
      `Selected identity checkpoint failed: ${checkpoint.error.code}: ${checkpoint.error.message}`
    );
  }
  if (checkpoint.ok) {
    assert.equal(checkpoint.value.status, "checkpointed");
    assert.equal(checkpoint.value.page.returnedCount, 1);
  }
  const rows = await sql<
    readonly {
      provider_key: string | null;
      provider_subject_id: string | null;
      source_dataset_id: string | null;
      source_record_id: string | null;
    }[]
  >`
    SELECT
      provider_key,
      provider_subject_id,
      source_dataset_id,
      source_record_id
    FROM kurobara_core.dataset_generation_record_lineage
    WHERE workspace_id = ${fixture.workspaceId}
      AND generation_id = ${fixture.generationId}
  `;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    provider_key: identityProviderNamespace,
    provider_subject_id: "prospeo-person-selected-identity",
    source_dataset_id: "source-contact-selected-identity",
    source_record_id: "source-record-selected-identity",
  });
});

test("keeps generation and page pristine when the deadline closes before the effect", async () => {
  const fixture = await executeGeneration("deadline", "deadline");
  assert.equal(fixture.effect.history().executions.length, 0);
});

test("projects an unknown provider outcome atomically and blocks the page", async () => {
  const fixture = await executeGeneration("ambiguous", "ambiguous");
  const checkpoint = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: async () => instant(now + 1300) },
    persistence: runtime.datasetGenerationFirstPage,
  })({ generationId: fixture.generationId, workspaceId: fixture.workspaceId });
  assert.equal(checkpoint.ok, true);
  if (checkpoint.ok) {
    assert.equal(checkpoint.value.status, "ambiguous");
  }
  assert.equal(fixture.effect.history().executions.length, 1);
});
