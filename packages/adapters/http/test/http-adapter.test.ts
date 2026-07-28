import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  catalogFingerprint,
  schemaFingerprints,
  schemaIds,
} from "@kurobara/contracts";

import {
  contactIdentityExecutionQueryContract,
  contactWorkEmailExecutionQueryContract,
  createHttpApp,
  HTTP_ADAPTER_LIMITS,
  type HttpAdapterDependencies,
} from "../src/index.ts";

const SYNTHETIC_HASH = `sha256:${"a".repeat(64)}`;
const AUTHORIZATION = "Bearer synthetic-api-key";
const JSON_MEDIA_TYPE = "application/json";
const AUTHORIZATION_LIMIT_ERROR_PATTERN =
  /maxAuthorizationHeaderBytes must be a positive safe integer/;
const BODY_LIMIT_ERROR_PATTERN = /maxBodyBytes must be a positive safe integer/;
const IMPORT_LIMIT_ERROR_PATTERN =
  /maxImportBytes must be a positive safe integer/;
const SENSITIVE_DETAIL_PATTERN = /sensitive-/;
const CONTACT_SENSITIVE_FIELD_PATTERN =
  /email|phone|provider_(?:candidate_)?id|provider_cursor/u;
const EXPORT_STREAM_FAILURE_PATTERN = /Dataset export stream failed/u;
const JSON_HEADERS = {
  authorization: AUTHORIZATION,
  "content-type": "application/json; charset=utf-8",
} as const;

const organizationDiscoveryRequest = {
  authority_envelope_id: "authority-synthetic",
  budget: { limit: 10, unit: "credits" },
  dataset_id: "dataset-synthetic",
  dataset_name: "Synthetic companies",
  deadline_ms: 1_752_700_060_000,
  discovery_id: "discovery-synthetic",
  limits: { max_calls: 2, max_companies: 50, max_pages: 2 },
  mode: "dry-run",
  query: {
    country_codes: ["FR"],
    country_scope: "headquarters",
    industry_codes: ["software"],
    industry_taxonomy: "kurobara-v1",
    result_kind: "company",
  },
} as const;

const contactDiscoveryRequest = {
  authority_envelope_id: "authority-synthetic",
  budget: { limit: 2, unit: "credits" },
  dataset_id: "contacts-synthetic",
  dataset_name: "Synthetic contacts",
  deadline_ms: 1_752_700_060_000,
  discovery_id: "contact-discovery-synthetic",
  limits: {
    max_calls: 2,
    max_companies: 3,
    max_contacts_per_company: 2,
    max_contacts_total: 6,
    max_pages: 2,
  },
  mode: "dry-run",
  organization_generation_id: "organization-generation-synthetic",
  query: {
    company_headquarters_country_codes: ["ES"],
    departments: ["sales"],
    person_country_codes: [],
    result_kind: "contact",
    seniorities: ["director"],
    titles: [],
  },
} as const;

const selectedContactDerivationRequest = {
  authority_envelope_id: "authority-synthetic",
  budget: { limit: 3, unit: "credits" },
  contact_dataset_id: "contacts-synthetic",
  contact_record_ids: ["contact-1", "contact-2"],
  deadline_ms: 1_752_700_060_000,
  operation_id: "operation-synthetic",
} as const;

type AuthenticationResult = Awaited<
  ReturnType<HttpAdapterDependencies["authenticateApiKey"]>
>;
type Actor = Extract<AuthenticationResult, Readonly<{ ok: true }>>["value"];
type ApplyRecipeResult = Awaited<
  ReturnType<HttpAdapterDependencies["applyRecipe"]>
>;
type ApplyRecipeValue = Extract<
  ApplyRecipeResult,
  Readonly<{ ok: true }>
>["value"];
type CreateRunResult = Awaited<
  ReturnType<HttpAdapterDependencies["createRun"]>
>;
type CreateRunValue = Extract<CreateRunResult, Readonly<{ ok: true }>>["value"];
type CancelRunResult = Awaited<
  ReturnType<HttpAdapterDependencies["cancelRun"]>
>;
type CancelRunValue = Extract<CancelRunResult, Readonly<{ ok: true }>>["value"];
type GetRunResult = Awaited<ReturnType<HttpAdapterDependencies["getRun"]>>;
type GetRunValue = Extract<GetRunResult, Readonly<{ ok: true }>>["value"];
type GetRecipeApplicationStatusResult = Awaited<
  ReturnType<HttpAdapterDependencies["getRecipeApplicationStatus"]>
>;
type GetRecipeApplicationStatusValue = Extract<
  GetRecipeApplicationStatusResult,
  Readonly<{ ok: true }>
>["value"];
type ExportRecipeApplicationResult = Awaited<
  ReturnType<HttpAdapterDependencies["exportRecipeApplication"]>
>;
type ExportRecipeApplicationValue = Extract<
  ExportRecipeApplicationResult,
  Readonly<{ ok: true }>
>["value"];
type ExportDataset = NonNullable<HttpAdapterDependencies["exportDataset"]>;
type ExportDatasetResult = Awaited<ReturnType<ExportDataset>>;
type ExportDatasetValue = Extract<
  ExportDatasetResult,
  Readonly<{ ok: true }>
>["value"];
type GetExportDelivery = NonNullable<
  HttpAdapterDependencies["getExportDelivery"]
>;
type GetExportDeliveryValue = Extract<
  Awaited<ReturnType<GetExportDelivery>>,
  Readonly<{ ok: true }>
>["value"];
type RestrictContactPrivacy = NonNullable<
  HttpAdapterDependencies["restrictContactPrivacy"]
>;
type RestrictContactPrivacyValue = Extract<
  Awaited<ReturnType<RestrictContactPrivacy>>,
  Readonly<{ ok: true }>
>["value"];
type RevokeExportDelivery = NonNullable<
  HttpAdapterDependencies["revokeExportDelivery"]
>;
type RevokeExportDeliveryValue = Extract<
  Awaited<ReturnType<RevokeExportDelivery>>,
  Readonly<{ ok: true }>
>["value"];
type ImportDatasetResult = Awaited<
  ReturnType<HttpAdapterDependencies["importDataset"]>
>;
type ImportDatasetValue = Extract<
  ImportDatasetResult,
  Readonly<{ ok: true }>
>["value"];
type ListCapabilitiesResult = Awaited<
  ReturnType<HttpAdapterDependencies["listCapabilities"]>
>;
type ListCapabilitiesValue = Extract<
  ListCapabilitiesResult,
  Readonly<{ ok: true }>
>["value"];
type QuoteRunPlanResult = Awaited<
  ReturnType<HttpAdapterDependencies["quoteRunPlan"]>
>;
type QuoteRunPlanValue = Extract<
  QuoteRunPlanResult,
  Readonly<{ ok: true }>
>["value"];
type Gtm = NonNullable<HttpAdapterDependencies["gtm"]>;
type PlayRun = NonNullable<Awaited<ReturnType<Gtm["getPlayRun"]>>>;

const camelCaseKey = (key: string): string =>
  key.replace(/_([a-z])/gu, (_match, character: string) =>
    character.toUpperCase()
  );

const toInternalProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toInternalProjection);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        camelCaseKey(key),
        toInternalProjection(entry),
      ])
    );
  }
  return value;
};

const validPlayRunContractFixture: unknown = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/catalog/fixtures/play-run-get-response/valid/minimal.json",
      import.meta.url
    ),
    "utf8"
  )
);

const storedPlayRunFromContractFixture = (): PlayRun => {
  if (
    validPlayRunContractFixture === null ||
    typeof validPlayRunContractFixture !== "object" ||
    !("run" in validPlayRunContractFixture)
  ) {
    throw new TypeError("The Play run contract fixture must contain a run");
  }
  const internalRun = toInternalProjection(validPlayRunContractFixture.run);
  if (
    internalRun === null ||
    typeof internalRun !== "object" ||
    !("play" in internalRun)
  ) {
    throw new TypeError("The Play run contract fixture must contain a play");
  }
  const { play, ...run } = internalRun;
  return {
    ...run,
    definition: play,
    executionActor: {
      actorId: "actor-synthetic",
      authenticationMode: "api-key",
      permissions: ["plays:execute"],
    },
  } as unknown as PlayRun;
};

const actor = {
  actorId: "actor-synthetic",
  authenticationMode: "api-key",
  credentialId: "credential-synthetic",
  permissions: [
    "capabilities:list",
    "contacts:enrich",
    "datasets:export",
    "datasets:read",
    "plans:quote",
    "recipes:export",
    "recipes:read",
    "runs:cancel",
    "runs:create",
    "runs:read",
    "steps:execute",
  ],
  workspaceId: "workspace-synthetic",
} as unknown as Actor;

const queuedRun = {
  aggregateVersion: 1,
  createdAt: 1_752_700_000_000,
  eventSequence: 1,
  idempotencyKey: "idempotency-synthetic",
  intentionHash: SYNTHETIC_HASH,
  resultCompleteness: "none",
  runId: "run-synthetic",
  runPlanId: "plan-synthetic",
  state: "queued",
  workspaceId: "workspace-synthetic",
} as unknown as CreateRunValue["run"];

const runSnapshot = {
  cost: { reserved: 8, spent: 2, unit: "credits" },
  run: queuedRun,
} as unknown as GetRunValue;

const cancelledRun = {
  ...queuedRun,
  aggregateVersion: 2,
  eventSequence: 3,
  state: "cancelled",
} as unknown as CancelRunValue["run"];

const quotedPlan = {
  authority: { authorityEnvelopeId: "authority-synthetic" },
  budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
  catalogFingerprint: SYNTHETIC_HASH,
  catalogVersion: "1.0.0",
  deadline: 1_752_700_060_000,
  planHash: SYNTHETIC_HASH,
  quote: {
    expiresAt: 1_752_700_030_000,
    guarantee: "hard",
    pricingVersion: "pricing-1",
    quoteId: "quote-synthetic",
    unit: "credits",
    upperBound: 8,
  },
  runPlanId: "plan-synthetic",
  workspaceId: "workspace-synthetic",
} as unknown as QuoteRunPlanValue["plan"];

const listedCapabilities = {
  authorityEnvelopeId: "authority-synthetic",
  capabilities: [
    {
      capabilityId: "documents.summarize",
      capabilityVersion: "1.0.0",
    },
  ],
  workspaceId: "workspace-synthetic",
} as unknown as ListCapabilitiesValue;

const importedDataset = {
  progress: {
    batchCount: 1,
    datasetId: "dataset-synthetic",
    errorCount: 0,
    importId: "import-synthetic",
    itemCount: 2,
    recordCount: 2,
    state: "completed",
    workspaceId: "workspace-synthetic",
  },
  replayed: false,
} as unknown as ImportDatasetValue;

const discoveredOrganizations = {
  mode: "dry_run",
  plan: {
    generationPlanId: "generation-plan-synthetic",
    planHash: SYNTHETIC_HASH,
    queryHash: SYNTHETIC_HASH,
    quote: {
      expiresAt: 1_752_700_030_000,
      guarantee: "hard",
      unit: "credits",
      upperBound: 8,
    },
    requestIntent: {
      targetDataset: { datasetId: "dataset-synthetic" },
    },
    workspaceId: "workspace-synthetic",
  },
  replayed: false,
  status: "planned",
} as unknown as Extract<
  Awaited<
    ReturnType<NonNullable<HttpAdapterDependencies["discoverOrganizations"]>>
  >,
  { ok: true }
>["value"];

const discoveredContacts = {
  ...discoveredOrganizations,
  organizationSource: {
    generationId: "organization-generation-synthetic",
    kind: "generation",
  },
  plan: {
    ...discoveredOrganizations.plan,
    requestIntent: { targetDataset: { datasetId: "contacts-synthetic" } },
  },
} as unknown as Extract<
  Awaited<ReturnType<NonNullable<HttpAdapterDependencies["discoverContacts"]>>>,
  { ok: true }
>["value"];

const datasetGeneration = {
  generation: {
    cost: { reserved: 0, spent: 0, unit: "credits" },
    counters: {
      accepted: 0,
      calls: 0,
      duplicates: 0,
      pages: 0,
      rejected: 0,
      returned: 0,
    },
    datasetId: "dataset-synthetic",
    generationId: "generation-synthetic",
    generationPlanId: "generation-plan-synthetic",
    materializationId: "materialization-synthetic",
    state: "planned",
    workspaceId: "workspace-synthetic",
  },
  materialization: {
    materializationId: "materialization-synthetic",
    recordCount: 0,
    state: "building",
  },
} as unknown as Extract<
  Awaited<
    ReturnType<NonNullable<HttpAdapterDependencies["getDatasetGeneration"]>>
  >,
  { ok: true }
>["value"];

const derivedSelectedContacts = {
  creation: {
    generation: {
      ...datasetGeneration.generation,
      datasetId: "derived-contacts-synthetic",
      state: "running",
    },
    materialization: datasetGeneration.materialization,
  },
  plan: {
    ...discoveredOrganizations.plan,
    generationPlanId: "derived-generation-plan-synthetic",
  },
  replayed: false,
  sourceContactDatasetId: "contacts-synthetic",
  sourceContactRecordIds: ["contact-1", "contact-2"],
  status: "running",
} as unknown as Extract<
  Awaited<
    ReturnType<NonNullable<HttpAdapterDependencies["deriveContactWorkEmails"]>>
  >,
  { ok: true }
>["value"];

const cancelledDatasetGeneration = {
  ...datasetGeneration,
  generation: {
    ...datasetGeneration.generation,
    state: "cancelled",
    stop: { reason: "requested", requestedAt: 1_752_700_001_000 },
  },
  materialization: {
    ...datasetGeneration.materialization,
    state: "cancelled",
  },
} as typeof datasetGeneration;

type ListCompanyCandidatesResult = Awaited<
  ReturnType<HttpAdapterDependencies["listCompanyCandidates"]>
>;
type ListCompanyCandidatesValue = Extract<
  ListCompanyCandidatesResult,
  Readonly<{ ok: true }>
>["value"];

const listedCompanyCandidates = {
  generation: {
    ...datasetGeneration.generation,
    capability: {
      capabilityId: "organizations.discover",
      capabilityVersion: "1.0.0",
    },
    planHash: SYNTHETIC_HASH,
    queryHash: SYNTHETIC_HASH,
    schemaHash: SYNTHETIC_HASH,
    state: "completed",
  },
  items: [
    {
      candidate: {
        companyId: "company-synthetic",
        countryCode: "FR",
        domain: "synthetic.example",
        employeeCount: 42,
        industryCode: "software",
        name: "Synthetic Company",
        observedAtMs: 1_752_700_001_000,
      },
      ordinal: 1,
    },
  ],
  materialization: {
    ...datasetGeneration.materialization,
    completedAt: 1_752_700_001_000,
    completionReason: "source-completed",
    contentHash: SYNTHETIC_HASH,
    coverage: {
      basis: "locked_provider_route",
      status: "complete_for_declared_source",
    },
    recordCount: 1,
    revision: 1,
    state: "ready",
  },
  page: {
    afterOrdinal: 0,
    hasMore: false,
    limit: 25,
    nextAfterOrdinal: null,
  },
} as unknown as ListCompanyCandidatesValue;

type ListContactCandidates = NonNullable<
  HttpAdapterDependencies["listContactCandidates"]
>;
type ListContactCandidatesResult = Awaited<ReturnType<ListContactCandidates>>;
type ListContactCandidatesValue = Extract<
  ListContactCandidatesResult,
  Readonly<{ ok: true }>
>["value"];

const listedContactCandidates = {
  ...listedCompanyCandidates,
  generation: {
    ...listedCompanyCandidates.generation,
    capability: {
      capabilityId: "contacts.discover",
      capabilityVersion: "1.0.0",
    },
  },
  items: [
    {
      candidate: {
        contactId: "contact-synthetic",
        department: "sales",
        displayName: "Synthetic Contact",
        identityCompleteness: "full",
        jobTitle: "Sales Director",
        observedAt: 1_752_700_001_000,
        organizationDomain: "synthetic.example",
        organizationId: "company-synthetic",
        organizationName: "Synthetic Company",
        personCountryCode: "ES",
        profileUrl: "https://social.example/synthetic-contact",
        seniority: "director",
      },
      ordinal: 1,
    },
  ],
} as unknown as ListContactCandidatesValue;

const appliedRecipe = {
  application: {
    createdAt: 1_752_700_000_000,
    datasetId: "dataset-synthetic",
    graph: { recordIds: ["record-1", "record-2"] },
    graphHash: SYNTHETIC_HASH,
    intentHash: SYNTHETIC_HASH,
    maxCells: 10,
    recipeApplicationId: "application-synthetic",
    recipeId: "recipe-synthetic",
    recipeRevision: "1.0.0",
    targetFieldId: "field-category",
    workspaceId: "workspace-synthetic",
  },
  applicationReplayed: false,
  counts: { active: 0, bound: 0, cached: 0, createdRun: 2, total: 2 },
  recipeReplayed: false,
} as unknown as ApplyRecipeValue;

const watchedRecipeApplication = {
  application: appliedRecipe.application,
  counts: {
    bound: 2,
    failed: 0,
    pending: 1,
    running: 0,
    skipped: 0,
    succeeded: 1,
    total: 2,
    unbound: 0,
  },
  state: "running",
  terminal: false,
} as unknown as GetRecipeApplicationStatusValue;

const exportBodyText =
  '{"dataset_id":"dataset-synthetic","record_id":"record-1","values":[],"workspace_id":"workspace-synthetic"}\n';
const exportBodyBytes = new TextEncoder().encode(exportBodyText);
const exportedRecipeApplication = {
  application: appliedRecipe.application,
  contentHash: SYNTHETIC_HASH,
  contentLength: exportBodyBytes.byteLength,
  dataset: {
    datasetId: "dataset-synthetic",
    name: "Synthetic dataset",
    workspaceId: "workspace-synthetic",
  },
  events: {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield { bytes: exportBodyBytes, recordNumber: 1, type: "chunk" } as const;
    },
  },
  fields: [
    {
      datasetId: "dataset-synthetic",
      fieldId: "field-name",
      key: "name",
      label: "Name",
      valueType: "string",
      workspaceId: "workspace-synthetic",
    },
  ],
  format: "jsonl",
  recipe: {
    datasetId: "dataset-synthetic",
    enrichmentRecipeId: "recipe-synthetic",
    inputFieldIds: ["field-name"],
    name: "Resolve a synthetic category",
    recipeRevision: "1.0.0",
    targetFieldId: "field-category",
    workflowContentHash: SYNTHETIC_HASH,
    workflowRevision: "1.0.0",
    workflowSpecId: "workflow-synthetic",
    workspaceId: "workspace-synthetic",
  },
} as unknown as ExportRecipeApplicationValue;

const datasetExportFields = [
  {
    datasetId: "derived-contacts-synthetic",
    fieldId: "field-display-name",
    key: "display_name",
    label: "Display name",
    valueType: "string",
    workspaceId: "workspace-synthetic",
  },
  {
    datasetId: "derived-contacts-synthetic",
    fieldId: "field-work-email",
    key: "work_email",
    label: "Work email",
    valueType: "string",
    workspaceId: "workspace-synthetic",
  },
] as unknown as ExportDatasetValue["fields"];

const datasetExportValue = (
  format: "csv" | "jsonl",
  body: string,
  fields: ExportDatasetValue["fields"] = datasetExportFields
): ExportDatasetValue => {
  const bytes = new TextEncoder().encode(body);
  return {
    contentHash: SYNTHETIC_HASH,
    contentLength: bytes.byteLength,
    dataset: {
      datasetId: "derived-contacts-synthetic",
      name: "Derived synthetic contacts",
      workspaceId: "workspace-synthetic",
    },
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { bytes, recordNumber: 1, type: "chunk" } as const;
      },
    },
    fields,
    format,
  } as unknown as ExportDatasetValue;
};

const exportDelivery = {
  deliveryId: "delivery-synthetic",
  effectiveExpiresAt: 1_752_786_400_000,
  intentHash: SYNTHETIC_HASH,
  manifest: {
    applicationId: null,
    contentHash: SYNTHETIC_HASH,
    contentLength: 76,
    dataClasses: ["contact-identity", "professional-email"],
    datasetId: "derived-contacts-synthetic",
    fieldIds: ["field-display-name", "field-work-email"],
    format: "jsonl",
    manifestVersion: "2.0.0",
    observedExpiries: [
      {
        dataClass: "contact-identity",
        expiresAt: 1_752_786_400_000,
        observedAt: 1_752_700_000_000,
      },
      {
        dataClass: "professional-email",
        expiresAt: 1_752_786_400_000,
        observedAt: 1_752_700_000_000,
      },
    ],
    ownerActorId: "actor-synthetic",
    policyPurpose: {
      policyExpiresAt: 1_752_786_400_000,
      policyVersion: "policy-synthetic-v1",
      purposeRef: "synthetic-business-research",
      territory: "ES",
    },
    providerRights: {
      expiresAt: 1_752_786_400_000,
      mode: "synthetic-fixture",
      version: "rights-synthetic-v1",
    },
    recipeId: null,
    recipeRevision: null,
    source: {
      capabilityId: "contacts.work-email.resolve",
      capabilityVersion: "1.0.0",
      generationId: "generation-synthetic",
      generationPlanId: "generation-plan-synthetic",
      kind: "generated-dataset",
      planHash: SYNTHETIC_HASH,
    },
    workspaceId: "workspace-synthetic",
  },
  preparedAt: 1_752_700_010_000,
  state: "prepared",
} as unknown as RevokeExportDeliveryValue;

const exportDeliveryReadback = {
  delivery: {
    ...exportDelivery,
    deliveredAt: 1_752_700_020_000,
    state: "delivered",
  },
  effectiveExpiresAt: 1_752_786_400_000,
  state: "delivered",
} as unknown as GetExportDeliveryValue;

const contactPrivacyRestriction = {
  affectedDeliveryCount: 2,
  newlyRevokedDeliveryCount: 1,
  proof: {
    reason: "provider-opt-out",
    registeredAt: 1_752_700_030_000,
    tombstoneId: "tombstone-synthetic",
    workspaceId: "workspace-synthetic",
  },
  replayed: false,
} as unknown as RestrictContactPrivacyValue;

const validCreateBody = {
  idempotency_key: "idempotency-synthetic",
  intention_hash: SYNTHETIC_HASH,
  run_plan_id: "plan-synthetic",
} as const;

const validQuoteBody = {
  authority_envelope_id: "authority-synthetic",
  budget: { limit: 10, unit: "credits" },
  deadline_ms: 1_752_700_060_000,
  normalized_input_hash: SYNTHETIC_HASH,
  workflow_content_hash: SYNTHETIC_HASH,
  workflow_revision: "1.0.0",
  workflow_spec_id: "workflow-synthetic",
  workspace_id: "workspace-synthetic",
} as const;

const validImportMetadata = {
  batch_limits: { max_bytes: 4096, max_items: 100 },
  dataset: {
    dataset_id: "dataset-synthetic",
    name: "Synthetic dataset",
    workspace_id: "workspace-synthetic",
  },
  fields: [
    {
      dataset_id: "dataset-synthetic",
      field_id: "field-name",
      key: "name",
      label: "Name",
      value_type: "string",
      workspace_id: "workspace-synthetic",
    },
  ],
  format: "jsonl",
  import_id: "import-synthetic",
  max_record_bytes: 1024,
  source_content_hash: SYNTHETIC_HASH,
} as const;

const validApplyBody = {
  application_id: "application-synthetic",
  authority_envelope_id: "authority-synthetic",
  cell_budget: { limit: 5, unit: "credits" },
  deadline_ms: 1_752_700_060_000,
  max_cells: 10,
  recipe: {
    dataset_id: "dataset-synthetic",
    input_field_ids: ["field-name"],
    name: "Resolve a synthetic category",
    recipe_id: "recipe-synthetic",
    recipe_revision: "1.0.0",
    target_field_id: "field-category",
    workflow_content_hash: SYNTHETIC_HASH,
    workflow_revision: "1.0.0",
    workflow_spec_id: "workflow-synthetic",
    workspace_id: "workspace-synthetic",
  },
} as const;

type MultipartPart = Readonly<{
  chunks: readonly (string | Uint8Array)[];
  filename?: string;
  mediaType: string;
  name: string;
}>;

const multipartBodyChunks = (
  parts: readonly MultipartPart[],
  boundary: string
): Uint8Array[] => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${
          part.filename === undefined ? "" : `; filename="${part.filename}"`
        }\r\nContent-Type: ${part.mediaType}\r\n\r\n`
      )
    );
    for (const chunk of part.chunks) {
      chunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    }
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return chunks;
};

const importRequest = (
  parts: readonly MultipartPart[],
  boundary = "kurobara-synthetic-boundary",
  signal?: AbortSignal
): Request => {
  const chunks = multipartBodyChunks(parts, boundary);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Request("http://localhost/v1/dataset-imports", {
    body,
    duplex: "half",
    headers: {
      authorization: AUTHORIZATION,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  } as RequestInit & { duplex: "half" });
};

const metadataPart = (
  value: unknown = validImportMetadata,
  mediaType = JSON_MEDIA_TYPE
): MultipartPart => ({
  chunks: [JSON.stringify(value)],
  mediaType,
  name: "metadata",
});

const sourcePart = (
  chunks: readonly (string | Uint8Array)[] = [
    '{"record_id":"record-1","name":"Ada"}\n',
  ],
  mediaType = "application/x-ndjson"
): MultipartPart => ({
  chunks,
  filename: "dataset.jsonl",
  mediaType,
  name: "source",
});

const makeDependencies = (
  overrides: Partial<HttpAdapterDependencies> = {}
): HttpAdapterDependencies => ({
  applyRecipe: () => Promise.resolve({ ok: true, value: appliedRecipe }),
  authenticateApiKey: () => Promise.resolve({ ok: true, value: actor }),
  cancelDatasetGeneration: () =>
    Promise.resolve({
      ok: true,
      value: { generation: cancelledDatasetGeneration, replayed: false },
    }),
  cancelRun: () =>
    Promise.resolve({
      ok: true,
      value: { replayed: false, run: cancelledRun },
    }),
  createRun: () =>
    Promise.resolve({
      ok: true,
      value: { replayed: false, run: queuedRun },
    }),
  deriveContactIdentities: () =>
    Promise.resolve({ ok: true, value: derivedSelectedContacts }),
  deriveContactWorkEmails: () =>
    Promise.resolve({ ok: true, value: derivedSelectedContacts }),
  discoverContacts: () =>
    Promise.resolve({ ok: true, value: discoveredContacts }),
  discoverOrganizations: () =>
    Promise.resolve({ ok: true, value: discoveredOrganizations }),
  exportDataset: () =>
    Promise.resolve({
      ok: true,
      value: datasetExportValue(
        "jsonl",
        '{"display_name":"Synthetic Contact","work_email":"synthetic@example.test"}\n'
      ),
    }),
  exportRecipeApplication: () =>
    Promise.resolve({ ok: true, value: exportedRecipeApplication }),
  getExportDelivery: () =>
    Promise.resolve({ ok: true, value: exportDeliveryReadback }),
  getDatasetGeneration: () =>
    Promise.resolve({ ok: true, value: datasetGeneration }),
  getRecipeApplicationStatus: () =>
    Promise.resolve({ ok: true, value: watchedRecipeApplication }),
  getRun: () => Promise.resolve({ ok: true, value: runSnapshot }),
  importDataset: () => Promise.resolve({ ok: true, value: importedDataset }),
  listCapabilities: () =>
    Promise.resolve({ ok: true, value: listedCapabilities }),
  listContactCandidates: () =>
    Promise.resolve({ ok: true, value: listedContactCandidates }),
  listCompanyCandidates: () =>
    Promise.resolve({ ok: true, value: listedCompanyCandidates }),
  quoteRunPlan: () =>
    Promise.resolve({ ok: true, value: { plan: quotedPlan } }),
  readiness: () => true,
  restrictContactPrivacy: () =>
    Promise.resolve({ ok: true, value: contactPrivacyRestriction }),
  revokeExportDelivery: () =>
    Promise.resolve({
      ok: true,
      value: {
        ...exportDelivery,
        revokedAt: 1_752_700_040_000,
        state: "revoked",
      } as unknown as RevokeExportDeliveryValue,
    }),
  ...overrides,
});

test("projects a durable Play run through its public contract", async () => {
  const playActor = {
    ...actor,
    permissions: [...actor.permissions, "plays:read"],
  } as unknown as Actor;
  const gtm = {
    getPlayRun: () => Promise.resolve(storedPlayRunFromContractFixture()),
  } as unknown as Gtm;
  const app = createHttpApp(
    makeDependencies({
      authenticateApiKey: () => Promise.resolve({ ok: true, value: playActor }),
      gtm,
    })
  );

  const response = await app.request("/v1/play-runs/play-run-1", {
    headers: { authorization: AUTHORIZATION },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), validPlayRunContractFixture);
});

test("projects one bounded organization discovery through the application facade", async () => {
  let captured:
    | Parameters<
        NonNullable<HttpAdapterDependencies["discoverOrganizations"]>
      >[0]
    | undefined;
  const app = createHttpApp(
    makeDependencies({
      discoverOrganizations: (request) => {
        captured = request;
        return Promise.resolve({
          ok: true,
          value: discoveredOrganizations,
        });
      },
    })
  );
  const response = await app.request("/v1/organization-discoveries", {
    body: JSON.stringify(organizationDiscoveryRequest),
    headers: JSON_HEADERS,
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(captured?.mode, "dry_run");
  assert.deepEqual(captured?.planning.limits, {
    maxCalls: 2,
    maxCompanies: 50,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 2,
    maxPhones: 0,
    maxResults: 50,
  });
  assert.deepEqual(await response.json(), {
    dataset_id: "dataset-synthetic",
    generation_plan_id: "generation-plan-synthetic",
    mode: "dry-run",
    plan_hash: SYNTHETIC_HASH,
    query_hash: SYNTHETIC_HASH,
    quote: {
      expires_at_ms: 1_752_700_030_000,
      guarantee: "hard",
      unit: "credits",
      upper_bound: 8,
    },
    replayed: false,
    state: "planned",
    workspace_id: "workspace-synthetic",
  });
});

test("projects bounded contact discovery and exact work-email selection", async () => {
  const app = createHttpApp(makeDependencies());
  const discoveryResponse = await app.request("/v1/contact-discoveries", {
    body: JSON.stringify(contactDiscoveryRequest),
    headers: JSON_HEADERS,
    method: "POST",
  });
  assert.equal(discoveryResponse.status, 200);
  const discoveryBody = await discoveryResponse.json();
  assert.equal(
    discoveryBody.organization_generation_id,
    "organization-generation-synthetic"
  );
  assert.deepEqual(discoveryBody.organization_source, {
    generation_id: "organization-generation-synthetic",
    kind: "generation",
  });
  const emailResponse = await app.request(
    "/v1/contact-work-email-resolutions",
    {
      body: JSON.stringify({
        authority_envelope_id: "authority-synthetic",
        budget: { limit: 2, unit: "credits" },
        contact_dataset_id: "contacts-synthetic",
        contact_record_ids: ["contact-1", "contact-2"],
        deadline_ms: 1_752_700_060_000,
        operation_id: "resolve-synthetic",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    }
  );
  assert.equal(emailResponse.status, 200);
  assert.deepEqual((await emailResponse.json()).contact_record_ids, [
    "contact-1",
    "contact-2",
  ]);
});

describe("selected-contact derived dataset routes", () => {
  test("maps identity reveal, work-email resolve, and verify to the exact facades", async () => {
    const identityRequests: Parameters<
      NonNullable<HttpAdapterDependencies["deriveContactIdentities"]>
    >[0][] = [];
    const workEmailRequests: Parameters<
      NonNullable<HttpAdapterDependencies["deriveContactWorkEmails"]>
    >[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        deriveContactIdentities: (request) => {
          identityRequests.push(request);
          return Promise.resolve({ ok: true, value: derivedSelectedContacts });
        },
        deriveContactWorkEmails: (request) => {
          workEmailRequests.push(request);
          return Promise.resolve({ ok: true, value: derivedSelectedContacts });
        },
      })
    );
    const routes = [
      {
        operationId: "identity-reveal-synthetic",
        path: "/v1/contact-identity-reveals",
      },
      {
        kind: "resolve",
        operationId: "work-email-resolve-synthetic",
        path: "/v1/contact-work-email-resolutions",
      },
      {
        kind: "verify",
        operationId: "work-email-verify-synthetic",
        path: "/v1/contact-work-email-verifications",
      },
    ] as const;

    for (const route of routes) {
      const response = await app.request(route.path, {
        body: JSON.stringify({
          ...selectedContactDerivationRequest,
          operation_id: route.operationId,
        }),
        headers: {
          ...JSON_HEADERS,
          "x-correlation-id": "correlation-selected-contacts",
        },
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(
        response.headers.get("x-correlation-id"),
        "correlation-selected-contacts"
      );
      assert.deepEqual(await response.json(), {
        contact_dataset_id: "contacts-synthetic",
        contact_record_ids: ["contact-1", "contact-2"],
        generation_id: "generation-synthetic",
        generation_plan_id: "derived-generation-plan-synthetic",
        operation_id: route.operationId,
        replayed: false,
        result_dataset_id: "derived-contacts-synthetic",
        state: "building",
        workspace_id: "workspace-synthetic",
      });
    }

    assert.deepEqual(identityRequests, [
      {
        actor,
        authorityEnvelopeId: "authority-synthetic",
        budget: { limit: 3, unit: "credits" },
        contactDatasetId: "contacts-synthetic",
        contactRecordIds: ["contact-1", "contact-2"],
        correlationId: "correlation-selected-contacts",
        deadline: 1_752_700_060_000,
        operationId: "identity-reveal-synthetic",
      },
    ]);
    assert.deepEqual(workEmailRequests, [
      {
        actor,
        authorityEnvelopeId: "authority-synthetic",
        budget: { limit: 3, unit: "credits" },
        contactDatasetId: "contacts-synthetic",
        contactRecordIds: ["contact-1", "contact-2"],
        correlationId: "correlation-selected-contacts",
        deadline: 1_752_700_060_000,
        kind: "resolve",
        operationId: "work-email-resolve-synthetic",
      },
      {
        actor,
        authorityEnvelopeId: "authority-synthetic",
        budget: { limit: 3, unit: "credits" },
        contactDatasetId: "contacts-synthetic",
        contactRecordIds: ["contact-1", "contact-2"],
        correlationId: "correlation-selected-contacts",
        deadline: 1_752_700_060_000,
        kind: "verify",
        operationId: "work-email-verify-synthetic",
      },
    ]);
  });

  test("rejects invalid selections before I/O and redacts permission, selection, and privacy failures", async () => {
    let identityCalls = 0;
    const invalidSelectionApp = createHttpApp(
      makeDependencies({
        deriveContactIdentities: () => {
          identityCalls += 1;
          return Promise.resolve({ ok: true, value: derivedSelectedContacts });
        },
      })
    );
    const invalidSelection = await invalidSelectionApp.request(
      "/v1/contact-identity-reveals",
      {
        body: JSON.stringify({
          ...selectedContactDerivationRequest,
          contact_record_ids: [
            "contact-1",
            "contact-2",
            "contact-3",
            "contact-4",
          ],
        }),
        headers: JSON_HEADERS,
        method: "POST",
      }
    );
    await assertProblem(invalidSelection, 400, "request-invalid");
    assert.equal(identityCalls, 0);

    const failures = [
      {
        code: "authority-permission-missing",
        override: {
          deriveContactIdentities: () =>
            Promise.resolve({
              error: {
                code: "authority-permission-missing",
                message: "sensitive-permission-detail",
                stage: "authorization" as const,
              },
              ok: false as const,
            }),
        },
        path: "/v1/contact-identity-reveals",
        status: 403,
      },
      {
        code: "request-invalid",
        override: {
          deriveContactWorkEmails: () =>
            Promise.resolve({
              error: {
                code: "contact-selection-invalid",
                message: "sensitive-selection-detail",
                stage: "selection" as const,
              },
              ok: false as const,
            }),
        },
        path: "/v1/contact-work-email-resolutions",
        status: 400,
      },
      {
        code: "domain-rejected",
        override: {
          deriveContactWorkEmails: () =>
            Promise.resolve({
              error: {
                code: "contact-privacy-restricted",
                message: "sensitive-privacy-detail",
                stage: "privacy" as const,
              },
              ok: false as const,
            }),
        },
        path: "/v1/contact-work-email-verifications",
        status: 422,
      },
    ] as const;
    for (const failure of failures) {
      const app = createHttpApp(makeDependencies(failure.override));
      const response = await app.request(failure.path, {
        body: JSON.stringify(selectedContactDerivationRequest),
        headers: JSON_HEADERS,
        method: "POST",
      });
      await assertProblem(response.clone(), failure.status, failure.code);
      assert.doesNotMatch(await response.text(), SENSITIVE_DETAIL_PATTERN);
    }
  });

  test("refuses undeclared methods and exports both execution-query contracts", async () => {
    const app = createHttpApp(makeDependencies());
    for (const path of [
      "/v1/contact-identity-reveals",
      "/v1/contact-work-email-resolutions",
      "/v1/contact-work-email-verifications",
    ]) {
      const response = await app.request(path, { method: "GET" });
      await assertProblem(response.clone(), 405, "method-not-allowed");
      assert.equal(response.headers.get("allow"), "POST");
    }

    assert.deepEqual(contactIdentityExecutionQueryContract, {
      catalogFingerprint,
      catalogVersion: "0.13.0",
      schemaFingerprint: schemaFingerprints.ContactIdentityExecutionQuery,
      schemaId: schemaIds.ContactIdentityExecutionQuery,
      schemaVersion: "1.0.0",
    });
    assert.deepEqual(contactWorkEmailExecutionQueryContract, {
      catalogFingerprint,
      catalogVersion: "0.13.0",
      schemaFingerprint: schemaFingerprints.ContactWorkEmailExecutionQuery,
      schemaId: schemaIds.ContactWorkEmailExecutionQuery,
      schemaVersion: "1.0.0",
    });
  });
});

test("reads one authenticated dataset generation status", async () => {
  const app = createHttpApp(makeDependencies());
  const response = await app.request(
    "/v1/dataset-generations/generation-synthetic",
    { headers: { authorization: AUTHORIZATION } }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.generation_id, "generation-synthetic");
  assert.equal(body.materialization_state, "building");
  assert.equal(body.terminal, false);
});

test("lists one provider-neutral company candidate page with public provenance", async () => {
  let captured:
    | Parameters<HttpAdapterDependencies["listCompanyCandidates"]>[0]
    | undefined;
  const app = createHttpApp(
    makeDependencies({
      listCompanyCandidates: (request) => {
        captured = request;
        return Promise.resolve({ ok: true, value: listedCompanyCandidates });
      },
    })
  );
  const response = await app.request(
    "/v1/dataset-generations/generation-synthetic/company-candidates?limit=25",
    { headers: { authorization: AUTHORIZATION } }
  );

  assert.equal(response.status, 200);
  assert.equal(captured?.afterOrdinal, 0);
  assert.equal(captured?.generationId, "generation-synthetic");
  assert.equal(captured?.limit, 25);
  assert.equal(captured?.actor.workspaceId, "workspace-synthetic");
  assert.deepEqual(await response.json(), {
    dataset_id: "dataset-synthetic",
    generation_id: "generation-synthetic",
    items: [
      {
        candidate: {
          company_id: "company-synthetic",
          country_code: "FR",
          domain: "synthetic.example",
          employee_count: 42,
          industry_code: "software",
          name: "Synthetic Company",
          observed_at_ms: 1_752_700_001_000,
        },
        ordinal: 1,
      },
    ],
    page: {
      after_ordinal: 0,
      has_more: false,
      limit: 25,
      next_after_ordinal: null,
    },
    provenance: {
      capability_id: "organizations.discover",
      capability_version: "1.0.0",
      completed_at_ms: 1_752_700_001_000,
      completion_reason: "source-completed",
      coverage: {
        basis: "locked_provider_route",
        status: "complete_for_declared_source",
      },
      generation_plan_id: "generation-plan-synthetic",
      materialization_content_hash: SYNTHETIC_HASH,
      materialization_id: "materialization-synthetic",
      materialization_revision: 1,
      plan_hash: SYNTHETIC_HASH,
      query_hash: SYNTHETIC_HASH,
      schema_hash: SYNTHETIC_HASH,
    },
    record_count: 1,
    workspace_id: "workspace-synthetic",
  });
});

test("lists one privacy-safe provider-neutral contact candidate page", async () => {
  let captured: Parameters<ListContactCandidates>[0] | undefined;
  const app = createHttpApp(
    makeDependencies({
      listContactCandidates: (request) => {
        captured = request;
        return Promise.resolve({ ok: true, value: listedContactCandidates });
      },
    })
  );
  const response = await app.request(
    "/v1/dataset-generations/generation-synthetic/contact-candidates?limit=25&after_ordinal=0",
    { headers: { authorization: AUTHORIZATION } }
  );
  assert.equal(response.status, 200);
  const responseText = await response.clone().text();
  assert.equal(captured?.generationId, "generation-synthetic");
  assert.equal(captured?.actor.workspaceId, "workspace-synthetic");
  assert.deepEqual((await response.json()).items, [
    {
      candidate: {
        contact_id: "contact-synthetic",
        department: "sales",
        display_name: "Synthetic Contact",
        identity_completeness: "full",
        job_title: "Sales Director",
        observed_at_ms: 1_752_700_001_000,
        organization_domain: "synthetic.example",
        organization_id: "company-synthetic",
        organization_name: "Synthetic Company",
        person_country_code: "ES",
        profile_url: "https://social.example/synthetic-contact",
        seniority: "director",
      },
      ordinal: 1,
    },
  ]);
  assert.doesNotMatch(responseText, CONTACT_SENSITIVE_FIELD_PATTERN);
});

test("masks absent and non-ready contact generations as the same 404", async () => {
  for (const domainCode of [
    "dataset-generation-not-found",
    "dataset-generation-not-ready",
  ] as const) {
    const app = createHttpApp(
      makeDependencies({
        listContactCandidates: () =>
          Promise.resolve({
            error: { code: domainCode, message: "sensitive-provider-detail" },
            ok: false,
          } as ListContactCandidatesResult),
      })
    );
    const response = await app.request(
      "/v1/dataset-generations/generation-synthetic/contact-candidates?limit=25",
      { headers: { authorization: AUTHORIZATION } }
    );
    await assertProblem(response.clone(), 404, "dataset-generation-not-found");
    assert.doesNotMatch(await response.text(), SENSITIVE_DETAIL_PATTERN);
  }
});

test("returns service unavailable when contact candidate listing is not composed", async () => {
  const dependencies = makeDependencies();
  const { listContactCandidates: _listContactCandidates, ...withoutListing } =
    dependencies;
  await assertProblem(
    await createHttpApp(withoutListing).request(
      "/v1/dataset-generations/generation-synthetic/contact-candidates?limit=25",
      { headers: { authorization: AUTHORIZATION } }
    ),
    503,
    "service-unavailable"
  );
});

test("rejects ambiguous or out-of-contract company candidate page queries", async () => {
  let listCalls = 0;
  const app = createHttpApp(
    makeDependencies({
      listCompanyCandidates: () => {
        listCalls += 1;
        return Promise.resolve({ ok: true, value: listedCompanyCandidates });
      },
    })
  );
  for (const query of [
    "",
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?limit=01",
    "?limit=25&limit=50",
    "?limit=25&after_ordinal=-1",
    "?limit=25&after_ordinal=1&after_ordinal=2",
    "?limit=25&unknown=true",
  ]) {
    await assertProblem(
      await app.request(
        `/v1/dataset-generations/generation-synthetic/company-candidates${query}`,
        { headers: { authorization: AUTHORIZATION } }
      ),
      400,
      "request-invalid"
    );
  }
  assert.equal(listCalls, 0);
});

test("maps company candidate domain failures without leaking diagnostics", async () => {
  for (const [domainCode, problemCode, status] of [
    ["permission-missing", "authority-permission-missing", 403],
    ["dataset-generation-not-found", "dataset-generation-not-found", 404],
    ["dataset-generation-not-ready", "dataset-generation-not-found", 404],
    ["request-invalid", "request-invalid", 400],
    ["dataset-schema-invalid", "output-contract-violation", 500],
    ["dataset-record-invalid", "output-contract-violation", 500],
  ] as const) {
    const app = createHttpApp(
      makeDependencies({
        listCompanyCandidates: () =>
          Promise.resolve({
            error: { code: domainCode, message: "sensitive-provider-detail" },
            ok: false,
          } as ListCompanyCandidatesResult),
      })
    );
    const response = await app.request(
      "/v1/dataset-generations/generation-synthetic/company-candidates?limit=25",
      { headers: { authorization: AUTHORIZATION } }
    );
    await assertProblem(response.clone(), status, problemCode);
    assert.ok(!(await response.text()).includes("sensitive-provider-detail"));
  }
});

test("fails closed when a company candidate response violates its contract", async () => {
  const app = createHttpApp(
    makeDependencies({
      listCompanyCandidates: () =>
        Promise.resolve({
          ok: true,
          value: {
            ...listedCompanyCandidates,
            materialization: {
              ...listedCompanyCandidates.materialization,
              completionReason: "legacy-source-exhausted",
            },
          },
        } as ListCompanyCandidatesResult),
    })
  );
  await assertProblem(
    await app.request(
      "/v1/dataset-generations/generation-synthetic/company-candidates?limit=25&after_ordinal=0",
      { headers: { authorization: AUTHORIZATION } }
    ),
    500,
    "output-contract-violation"
  );
});

test("cancels one authenticated dataset generation idempotently", async () => {
  const app = createHttpApp(makeDependencies());
  const response = await app.request(
    "/v1/dataset-generations/generation-synthetic/cancel",
    {
      body: JSON.stringify({ idempotency_key: "cancel-generation-synthetic" }),
      headers: JSON_HEADERS,
      method: "POST",
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.generation_id, "generation-synthetic");
  assert.equal(body.state, "cancelled");
  assert.equal(body.stop_reason, "requested");
  assert.equal(body.terminal, true);
});

const createRequest = (
  body: string = JSON.stringify(validCreateBody),
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Request =>
  new Request("http://localhost/v1/runs", {
    body,
    headers,
    method: "POST",
  });

const cancelRequest = (
  runId = "run-synthetic",
  body: string = JSON.stringify({ idempotency_key: "cancel-synthetic" }),
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Request =>
  new Request(`http://localhost/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    body,
    headers,
    method: "POST",
  });

const applyRequest = (
  body: string = JSON.stringify(validApplyBody),
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Request =>
  new Request("http://localhost/v1/recipe-applications", {
    body,
    headers,
    method: "POST",
  });

const watchRequest = (
  applicationId = "application-synthetic",
  headers: Readonly<Record<string, string>> = {
    authorization: AUTHORIZATION,
  }
): Request =>
  new Request(
    `http://localhost/v1/recipe-applications/${encodeURIComponent(applicationId)}`,
    { headers }
  );

const exportRequest = (
  body: string = JSON.stringify({
    application_id: "application-synthetic",
    field_ids: ["field-name"],
    format: "jsonl",
  }),
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Request =>
  new Request("http://localhost/v1/recipe-application-exports", {
    body,
    headers,
    method: "POST",
  });

const quoteRequest = (
  body: string = JSON.stringify(validQuoteBody),
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Request =>
  new Request("http://localhost/v1/plans", {
    body,
    headers,
    method: "POST",
  });

const capabilitiesRequest = (
  path = "/v1/capabilities?authority_envelope_id=authority-synthetic",
  headers: Readonly<Record<string, string>> = {
    authorization: AUTHORIZATION,
  }
): Request => new Request(`http://localhost${path}`, { headers });

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const assertProblem = async (
  response: Response,
  expectedStatus: number,
  expectedCode: string
): Promise<void> => {
  ensure(response.status === expectedStatus, "Unexpected problem status.");
  ensure(
    (response.headers.get("content-type") ?? "").startsWith(
      "application/problem+json"
    ),
    "Unexpected problem media type."
  );
  const body: unknown = await response.json();
  ensure(
    body !== null && typeof body === "object",
    "Problem body must be an object."
  );
  ensure(
    Reflect.get(body, "code") === expectedCode,
    "Unexpected problem code."
  );
  ensure(
    Reflect.get(body, "status") === expectedStatus,
    "Unexpected problem status field."
  );
  ensure(
    typeof Reflect.get(body, "type") === "string",
    "Problem type must be a string."
  );
  ensure(
    typeof Reflect.get(body, "title") === "string",
    "Problem title must be a string."
  );
  ensure(
    typeof Reflect.get(body, "retryable") === "boolean",
    "Problem retryable must be a boolean."
  );
  ensure(
    typeof Reflect.get(body, "correlation_id") === "string",
    "Problem correlation identifier must be a string."
  );
};

describe("HTTP adapter probes", () => {
  test("serves health and readiness without authentication", async () => {
    const app = createHttpApp(makeDependencies());

    const health = await app.request("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "healthy" });

    const ready = await app.request("/readyz");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
  });

  test("reports a false or failed readiness callback canonically", async () => {
    const unavailable = createHttpApp(
      makeDependencies({ readiness: () => false })
    );
    await assertProblem(
      await unavailable.request("/readyz"),
      503,
      "service-unavailable"
    );

    const failed = createHttpApp(
      makeDependencies({
        readiness: () => {
          throw new Error("database-password-must-not-leak");
        },
      })
    );
    const response = await failed.request("/readyz");
    await assertProblem(response.clone(), 503, "service-unavailable");
    assert.ok(!(await response.text()).includes("database-password"));
  });
});

describe("GET /v1/capabilities", () => {
  test("returns a private authority-scoped runtime capability snapshot", async () => {
    const receivedRequests: Parameters<
      HttpAdapterDependencies["listCapabilities"]
    >[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        listCapabilities: (request) => {
          receivedRequests.push(request);
          return Promise.resolve({ ok: true, value: listedCapabilities });
        },
      })
    );

    const response = await app.request(capabilitiesRequest());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      authority_envelope_id: "authority-synthetic",
      capabilities: [
        {
          capability_id: "documents.summarize",
          capability_version: "1.0.0",
        },
      ],
      workspace_id: "workspace-synthetic",
    });
    assert.equal(receivedRequests.length, 1);
    assert.strictEqual(receivedRequests[0]?.actor, actor);
    assert.equal(
      receivedRequests[0]?.authorityEnvelopeId,
      "authority-synthetic"
    );
  });

  test("strictly validates the exact authority query", async () => {
    let listCalls = 0;
    const app = createHttpApp(
      makeDependencies({
        listCapabilities: () => {
          listCalls += 1;
          return Promise.resolve({ ok: true, value: listedCapabilities });
        },
      })
    );

    for (const path of [
      "/v1/capabilities",
      "/v1/capabilities?authority_envelope_id=",
      "/v1/capabilities?authority_envelope_id=one&authority_envelope_id=two",
      "/v1/capabilities?authority_envelope_id=one&unknown=true",
    ]) {
      await assertProblem(
        await app.request(capabilitiesRequest(path)),
        400,
        "request-invalid"
      );
    }
    assert.equal(listCalls, 0);
  });

  test("maps discovery failures without exposing application messages", async () => {
    const failures = [
      ["authority-permission-missing", 403],
      ["authority-subject-mismatch", 403],
      ["deadline-elapsed", 409],
      ["request-invalid", 400],
      ["service-unavailable", 503],
    ] as const;

    for (const [code, status] of failures) {
      const app = createHttpApp(
        makeDependencies({
          listCapabilities: () =>
            Promise.resolve({
              error: { code, message: "unsafe-capability-message" },
              ok: false,
            }),
        })
      );
      const response = await app.request(capabilitiesRequest());
      await assertProblem(response.clone(), status, code);
      assert.ok(!(await response.text()).includes("unsafe-capability-message"));
    }
  });

  test("rejects methods outside the discovery contract", async () => {
    const app = createHttpApp(makeDependencies());
    const response = await app.request("/v1/capabilities", { method: "POST" });
    await assertProblem(response, 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "GET");
  });
});

describe("POST /v1/plans", () => {
  test("quotes and persists a plan from server-derived authority context", async () => {
    const receivedRequests: Parameters<
      HttpAdapterDependencies["quoteRunPlan"]
    >[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        quoteRunPlan: (request) => {
          receivedRequests.push(request);
          return Promise.resolve({ ok: true, value: { plan: quotedPlan } });
        },
      })
    );

    const response = await app.request(quoteRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authority_envelope_id: "authority-synthetic",
      budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      catalog_fingerprint: SYNTHETIC_HASH,
      catalog_version: "1.0.0",
      deadline_ms: 1_752_700_060_000,
      plan_hash: SYNTHETIC_HASH,
      quote: {
        expires_at_ms: 1_752_700_030_000,
        guarantee: "hard",
        pricing_version: "pricing-1",
        quote_id: "quote-synthetic",
        unit: "credits",
        upper_bound: 8,
      },
      run_plan_id: "plan-synthetic",
      workspace_id: "workspace-synthetic",
    });
    assert.equal(receivedRequests.length, 1);
    assert.strictEqual(receivedRequests[0]?.actor, actor);
    assert.equal(receivedRequests[0]?.workspaceId, "workspace-synthetic");
  });

  test("validates the public request before invoking application planning", async () => {
    let quoteCalls = 0;
    const app = createHttpApp(
      makeDependencies({
        quoteRunPlan: () => {
          quoteCalls += 1;
          return Promise.resolve({ ok: true, value: { plan: quotedPlan } });
        },
      })
    );

    await assertProblem(
      await app.request(
        quoteRequest(JSON.stringify(validQuoteBody), {
          authorization: AUTHORIZATION,
        })
      ),
      415,
      "unsupported-media-type"
    );
    await assertProblem(
      await app.request(
        quoteRequest(JSON.stringify({ ...validQuoteBody, unknown: true }))
      ),
      400,
      "request-invalid"
    );
    assert.equal(quoteCalls, 0);
  });

  test("maps planning failures without exposing internal messages", async () => {
    const failures = [
      ["authority-permission-missing", undefined, 403],
      ["authority-subject-mismatch", undefined, 403],
      ["deadline-elapsed", undefined, 409],
      ["invalid-budget", undefined, 422],
      ["quote-unit-mismatch", undefined, 422],
      ["service-unavailable", undefined, 503],
      ["workspace-mismatch", undefined, 403],
      ["domain-rejected", "workflow-snapshot-unavailable", 422],
    ] as const;

    for (const [code, domainCode, status] of failures) {
      const app = createHttpApp(
        makeDependencies({
          quoteRunPlan: () =>
            Promise.resolve({
              error: {
                code,
                ...(domainCode === undefined ? {} : { domainCode }),
                message: "unsafe-planning-message",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request(quoteRequest());
      await assertProblem(response.clone(), status, code);
      assert.ok(!(await response.text()).includes("unsafe-planning-message"));
    }
  });

  test("rejects methods not declared by the plans route", async () => {
    const app = createHttpApp(makeDependencies());
    const response = await app.request("/v1/plans", { method: "GET" });
    await assertProblem(response, 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("POST /v1/runs", () => {
  test("creates and replays a run with server-derived auth context", async () => {
    let createCalls = 0;
    const receivedRequests: Parameters<
      HttpAdapterDependencies["createRun"]
    >[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        createRun: (request) => {
          receivedRequests.push(request);
          const replayed = createCalls > 0;
          createCalls += 1;
          return Promise.resolve({
            ok: true,
            value: { replayed, run: queuedRun },
          });
        },
      })
    );

    const first = await app.request(
      new Request("http://localhost/v1/runs", {
        body: JSON.stringify({
          ...validCreateBody,
          actor: { workspaceId: "client-controlled-workspace" },
        }),
        headers: JSON_HEADERS,
        method: "POST",
      })
    );
    await assertProblem(first, 400, "request-invalid");
    assert.equal(createCalls, 0);

    const correlationId = "correlation-synthetic";
    const requestHeaders = {
      ...JSON_HEADERS,
      "x-correlation-id": correlationId,
    };
    const created = await app.request(
      createRequest(JSON.stringify(validCreateBody), requestHeaders)
    );
    assert.equal(created.status, 200);
    assert.equal(created.headers.get("x-correlation-id"), correlationId);
    assert.deepEqual(await created.json(), {
      aggregate_version: 1,
      created_at_ms: 1_752_700_000_000,
      event_sequence: 1,
      replayed: false,
      result_completeness: "none",
      run_id: "run-synthetic",
      run_plan_id: "plan-synthetic",
      state: "queued",
      workspace_id: "workspace-synthetic",
    });

    const replayed = await app.request(createRequest());
    assert.equal(replayed.status, 200);
    assert.equal(Reflect.get(await replayed.json(), "replayed"), true);
    assert.equal(receivedRequests.length, 2);
    assert.strictEqual(receivedRequests[0]?.actor, actor);
    assert.equal(receivedRequests[0]?.correlationId, correlationId);
  });

  test("enforces JSON media type and validates malformed or invalid bodies", async () => {
    const app = createHttpApp(makeDependencies());

    await assertProblem(
      await app.request(
        createRequest(JSON.stringify(validCreateBody), {
          authorization: AUTHORIZATION,
        })
      ),
      415,
      "unsupported-media-type"
    );
    await assertProblem(
      await app.request(
        createRequest(JSON.stringify(validCreateBody), {
          authorization: AUTHORIZATION,
          "content-type": "text/plain",
        })
      ),
      415,
      "unsupported-media-type"
    );

    for (const invalidBody of [
      "",
      "{",
      "null",
      JSON.stringify({ ...validCreateBody, unknown: true }),
      JSON.stringify({ ...validCreateBody, intention_hash: "not-a-hash" }),
    ]) {
      await assertProblem(
        await app.request(createRequest(invalidBody)),
        400,
        "request-invalid"
      );
    }
  });

  test("enforces the actual streamed body-size limit", async () => {
    const app = createHttpApp(makeDependencies());
    const request = createRequest(
      JSON.stringify({ payload: "x".repeat(HTTP_ADAPTER_LIMITS.jsonBodyBytes) })
    );
    assert.equal(request.headers.get("content-length"), null);

    await assertProblem(await app.request(request), 413, "payload-too-large");
  });

  test("uses an explicitly configured body-size limit", async () => {
    const app = createHttpApp(makeDependencies(), { maxBodyBytes: 32 });

    await assertProblem(
      await app.request(createRequest()),
      413,
      "payload-too-large"
    );
  });

  test("maps every declared create failure to its canonical problem", async () => {
    const failures = [
      ["authority-permission-missing", undefined, 403],
      ["idempotency-key-reused", undefined, 409],
      ["intention-hash-mismatch", undefined, 409],
      ["request-invalid", undefined, 400],
      ["run-plan-already-consumed", undefined, 409],
      ["run-plan-not-found", undefined, 404],
      ["domain-rejected", "authority-capability-missing", 403],
      ["domain-rejected", "authority-permission-missing", 403],
      ["domain-rejected", "authority-subject-mismatch", 403],
      ["domain-rejected", "deadline-elapsed", 409],
      ["domain-rejected", "invalid-budget", 422],
      ["domain-rejected", "quote-expired", 409],
      ["domain-rejected", "quote-unit-mismatch", 422],
      ["domain-rejected", "workspace-mismatch", 403],
      ["domain-rejected", "unrecognized-domain-code", 422],
    ] as const;

    for (const [code, domainCode, status] of failures) {
      const app = createHttpApp(
        makeDependencies({
          createRun: () =>
            Promise.resolve({
              error: { code, domainCode, message: "unsafe-internal-message" },
              ok: false,
            }),
        })
      );
      const response = await app.request(createRequest());
      await assertProblem(
        response.clone(),
        status,
        code === "domain-rejected" && domainCode !== "unrecognized-domain-code"
          ? domainCode
          : code
      );
      assert.ok(!(await response.text()).includes("unsafe-internal-message"));
    }
  });
});

describe("POST /v1/runs/:run_id/cancel", () => {
  test("projects the path identity, server auth, and exact idempotent replay", async () => {
    const received: Parameters<HttpAdapterDependencies["cancelRun"]>[0][] = [];
    let calls = 0;
    const app = createHttpApp(
      makeDependencies({
        cancelRun: (request) => {
          received.push(request);
          const replayed = calls > 0;
          calls += 1;
          return Promise.resolve({
            ok: true,
            value: { replayed, run: cancelledRun },
          });
        },
      })
    );
    const correlationId = "correlation-cancel-synthetic";
    const first = await app.request(
      cancelRequest(
        "run-synthetic",
        JSON.stringify({ idempotency_key: "cancel-synthetic" }),
        { ...JSON_HEADERS, "x-correlation-id": correlationId }
      )
    );
    const replay = await app.request(cancelRequest());

    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-correlation-id"), correlationId);
    assert.deepEqual(await first.json(), {
      aggregate_version: 2,
      created_at_ms: 1_752_700_000_000,
      event_sequence: 3,
      replayed: false,
      result_completeness: "none",
      run_id: "run-synthetic",
      run_plan_id: "plan-synthetic",
      state: "cancelled",
      workspace_id: "workspace-synthetic",
    });
    assert.equal(replay.status, 200);
    assert.equal(Reflect.get(await replay.json(), "replayed"), true);
    assert.equal(received.length, 2);
    assert.strictEqual(received[0]?.actor, actor);
    assert.deepEqual(received[0], {
      actor,
      correlationId,
      idempotencyKey: "cancel-synthetic",
      runId: "run-synthetic",
    });
  });

  test("accepts only the idempotency key in the closed JSON body", async () => {
    let calls = 0;
    const app = createHttpApp(
      makeDependencies({
        cancelRun: () => {
          calls += 1;
          return Promise.resolve({
            ok: true,
            value: { replayed: false, run: cancelledRun },
          });
        },
      })
    );

    await assertProblem(
      await app.request(
        cancelRequest(
          "run-synthetic",
          JSON.stringify({
            actor: { workspace_id: "client-controlled" },
            idempotency_key: "cancel-synthetic",
          })
        )
      ),
      400,
      "request-invalid"
    );
    await assertProblem(
      await app.request(
        cancelRequest(
          "run-synthetic",
          JSON.stringify({
            idempotency_key: "cancel-synthetic",
            run_id: "body-controlled-run",
          })
        )
      ),
      400,
      "request-invalid"
    );
    for (const [label, request, status, code] of [
      [
        "empty body",
        cancelRequest("run-synthetic", ""),
        400,
        "request-invalid",
      ],
      [
        "malformed body",
        cancelRequest("run-synthetic", "{"),
        400,
        "request-invalid",
      ],
      [
        "null body",
        cancelRequest("run-synthetic", "null"),
        400,
        "request-invalid",
      ],
      [
        "empty idempotency key",
        cancelRequest("run-synthetic", JSON.stringify({ idempotency_key: "" })),
        400,
        "request-invalid",
      ],
      [
        "oversized run id",
        cancelRequest(
          "x".repeat(256),
          JSON.stringify({ idempotency_key: "cancel-synthetic" })
        ),
        400,
        "request-invalid",
      ],
      [
        "missing media type",
        cancelRequest(
          "run-synthetic",
          JSON.stringify({ idempotency_key: "cancel-synthetic" }),
          { authorization: AUTHORIZATION }
        ),
        415,
        "unsupported-media-type",
      ],
    ] as const) {
      const response = await app.request(request);
      assert.equal(response.status, status, label);
      await assertProblem(response, status, code);
    }
    assert.equal(calls, 0);
  });

  test("maps cancellation authorization, tenant masking, conflicts, and domain rejection", async () => {
    for (const [code, domainCode, status, publicCode] of [
      [
        "authority-permission-missing",
        undefined,
        403,
        "authority-permission-missing",
      ],
      ["run-not-found", undefined, 404, "run-not-found"],
      ["idempotency-key-reused", undefined, 409, "idempotency-key-reused"],
      ["request-invalid", undefined, 400, "request-invalid"],
      ["domain-rejected", "invalid-transition", 422, "domain-rejected"],
    ] as const) {
      const app = createHttpApp(
        makeDependencies({
          cancelRun: () =>
            Promise.resolve({
              error: {
                code,
                ...(domainCode === undefined ? {} : { domainCode }),
                message: "workspace-secret-other-tenant",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request(cancelRequest("run-secret"));
      await assertProblem(response.clone(), status, publicCode);
      const body = await response.text();
      assert.equal(body.includes("workspace-secret"), false);
      assert.equal(body.includes("other-tenant"), false);
    }
  });

  test("rejects a success snapshot outside the cancellation state contract", async () => {
    const app = createHttpApp(
      makeDependencies({
        cancelRun: () =>
          Promise.resolve({
            ok: true,
            value: {
              replayed: false,
              run: queuedRun as unknown as CancelRunValue["run"],
            },
          }),
      })
    );
    const response = await app.request(cancelRequest());
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.equal((await response.text()).includes("run-synthetic"), false);
  });

  test("registers only POST on the cancellation route", async () => {
    const response = await createHttpApp(makeDependencies()).request(
      "/v1/runs/run-synthetic/cancel",
      { method: "GET" }
    );
    await assertProblem(response.clone(), 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("POST /v1/recipe-applications", () => {
  test("maps one exact public command to the aggregate use case", async () => {
    const received: Parameters<HttpAdapterDependencies["applyRecipe"]>[0][] =
      [];
    const app = createHttpApp(
      makeDependencies({
        applyRecipe: (request) => {
          received.push(request);
          return Promise.resolve({ ok: true, value: appliedRecipe });
        },
      })
    );

    const response = await app.request(
      applyRequest(
        JSON.stringify({
          ...validApplyBody,
          aggregate_budget: { limit: 10, unit: "credits" },
          record_ids: ["record-1", "record-2"],
        }),
        {
          ...JSON_HEADERS,
          "x-correlation-id": "correlation-recipe-apply",
        }
      )
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      active_cell_count: 0,
      application_id: "application-synthetic",
      application_replayed: false,
      bound_cell_count: 0,
      cached_cell_count: 0,
      created_run_count: 2,
      dataset_id: "dataset-synthetic",
      recipe_id: "recipe-synthetic",
      recipe_replayed: false,
      recipe_revision: "1.0.0",
      total_cell_count: 2,
      workspace_id: "workspace-synthetic",
    });
    assert.equal(received.length, 1);
    assert.strictEqual(received[0]?.actor, actor);
    assert.equal(received[0]?.applicationId, "application-synthetic");
    assert.equal(received[0]?.correlationId, "correlation-recipe-apply");
    assert.deepEqual(received[0]?.cellBudget, {
      limit: 5,
      unit: "credits",
    });
    assert.deepEqual(received[0]?.aggregateBudget, {
      limit: 10,
      unit: "credits",
    });
    assert.deepEqual(received[0]?.recordIds, ["record-1", "record-2"]);
    assert.equal(received[0]?.recipe.enrichmentRecipeId, "recipe-synthetic");
    assert.deepEqual(received[0]?.recipe.inputFieldIds, ["field-name"]);
  });

  test("validates media type and the closed apply schema", async () => {
    const app = createHttpApp(makeDependencies());

    await assertProblem(
      await app.request(
        applyRequest(JSON.stringify(validApplyBody), {
          authorization: AUTHORIZATION,
        })
      ),
      415,
      "unsupported-media-type"
    );
    for (const body of [
      "",
      "{",
      "null",
      JSON.stringify({ ...validApplyBody, unknown: true }),
      JSON.stringify({ ...validApplyBody, max_cells: 0 }),
      JSON.stringify({
        ...validApplyBody,
        recipe: { ...validApplyBody.recipe, workspace_id: "" },
      }),
    ]) {
      await assertProblem(
        await app.request(applyRequest(body)),
        400,
        "request-invalid"
      );
    }
  });

  test("maps aggregate conflicts, quote failures, and invariants safely", async () => {
    const failures = [
      [
        "authority-permission-missing",
        undefined,
        403,
        "authority-permission-missing",
      ],
      ["request-invalid", undefined, 400, "request-invalid"],
      ["workspace-mismatch", undefined, 403, "workspace-mismatch"],
      [
        "recipe-registration-rejected",
        "recipe-revision-conflict",
        409,
        "idempotency-key-reused",
      ],
      [
        "recipe-application-rejected",
        "recipe-application-conflict",
        409,
        "idempotency-key-reused",
      ],
      [
        "recipe-cell-quote-rejected",
        "deadline-elapsed",
        409,
        "deadline-elapsed",
      ],
      ["recipe-cell-quote-rejected", "invalid-budget", 422, "invalid-budget"],
      [
        "recipe-cell-quote-rejected",
        "service-unavailable",
        503,
        "service-unavailable",
      ],
      [
        "recipe-cell-run-rejected",
        "run-plan-input-mismatch",
        422,
        "domain-rejected",
      ],
      ["recipe-apply-invariant", undefined, 500, "internal-error"],
    ] as const;

    for (const [code, domainCode, status, expectedCode] of failures) {
      const app = createHttpApp(
        makeDependencies({
          applyRecipe: () =>
            Promise.resolve({
              error: {
                code,
                ...(domainCode === undefined ? {} : { domainCode }),
                message: "sensitive-recipe-failure",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request(applyRequest());
      await assertProblem(response.clone(), status, expectedCode);
      assert.equal((await response.text()).includes("sensitive-recipe"), false);
    }
  });

  test("rejects other methods canonically", async () => {
    const app = createHttpApp(makeDependencies());
    const response = await app.request("/v1/recipe-applications", {
      method: "GET",
    });
    await assertProblem(response, 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("POST /v1/recipe-application-exports", () => {
  test("streams the exact preflighted export with canonical headers", async () => {
    const received: Parameters<
      HttpAdapterDependencies["exportRecipeApplication"]
    >[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        exportRecipeApplication: (request) => {
          received.push(request);
          return Promise.resolve({
            ok: true,
            value: exportedRecipeApplication,
          });
        },
      })
    );

    const response = await app.request(exportRequest());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="kurobara-recipe-application.jsonl"'
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      response.headers.get("x-kurobara-content-sha256"),
      SYNTHETIC_HASH
    );
    assert.equal(
      response.headers.get("content-length"),
      String(exportBodyBytes.byteLength)
    );
    assert.equal(await response.text(), exportBodyText);
    assert.equal(received.length, 1);
    assert.strictEqual(received[0]?.actor, actor);
    assert.equal(received[0]?.recipeApplicationId, "application-synthetic");
    assert.equal(received[0]?.format, "jsonl");
    assert.deepEqual(received[0]?.fieldIds, ["field-name"]);
  });

  test("validates media type and the closed export schema before I/O", async () => {
    let exportCalls = 0;
    const app = createHttpApp(
      makeDependencies({
        exportRecipeApplication: () => {
          exportCalls += 1;
          return Promise.resolve({
            ok: true,
            value: exportedRecipeApplication,
          });
        },
      })
    );

    await assertProblem(
      await app.request(
        exportRequest(undefined, { authorization: AUTHORIZATION })
      ),
      415,
      "unsupported-media-type"
    );
    for (const body of [
      "",
      "{",
      "null",
      JSON.stringify({ application_id: "application-synthetic" }),
      JSON.stringify({
        application_id: "application-synthetic",
        format: "xml",
      }),
      JSON.stringify({
        application_id: "application-synthetic",
        field_ids: ["field-name", "field-name"],
        format: "jsonl",
      }),
      JSON.stringify({
        application_id: "application-synthetic",
        format: "jsonl",
        unknown: true,
      }),
    ]) {
      await assertProblem(
        await app.request(exportRequest(body)),
        400,
        "request-invalid"
      );
    }
    assert.equal(exportCalls, 0);
  });

  test("maps every export failure to a redacted public problem", async () => {
    const failures = [
      ["authority-permission-missing", 403, "authority-permission-missing"],
      ["export-too-large", 413, "export-too-large"],
      ["recipe-application-not-found", 404, "recipe-application-not-found"],
      ["field-selection-invalid", 400, "request-invalid"],
      ["dataset-not-ready", 409, "recipe-application-export-unavailable"],
      [
        "recipe-projection-incomplete",
        409,
        "recipe-application-export-unavailable",
      ],
      ["sparse-csv-unsupported", 409, "recipe-application-export-unavailable"],
      ["dataset-not-found", 500, "output-contract-violation"],
      ["recipe-not-found", 500, "output-contract-violation"],
      ["recipe-projection-count-mismatch", 500, "output-contract-violation"],
      ["recipe-projection-duplicate", 500, "output-contract-violation"],
      ["recipe-projection-identity-mismatch", 500, "output-contract-violation"],
      ["recipe-projection-invalid", 500, "output-contract-violation"],
      ["codec-configuration-invalid", 500, "internal-error"],
    ] as const;

    for (const [code, status, publicCode] of failures) {
      const app = createHttpApp(
        makeDependencies({
          exportRecipeApplication: () =>
            Promise.resolve({
              error: { code, message: "sensitive-export-diagnostic" },
              ok: false,
            }),
        })
      );
      const response = await app.request(exportRequest());
      await assertProblem(response.clone(), status, publicCode);
      assert.equal((await response.text()).includes("sensitive-export"), false);
    }
  });

  test("refuses a mismatched application result before committing headers", async () => {
    const app = createHttpApp(
      makeDependencies({
        exportRecipeApplication: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exportedRecipeApplication,
              application: {
                ...exportedRecipeApplication.application,
                recipeApplicationId: "application-other",
              },
            },
          }),
      })
    );

    await assertProblem(
      await app.request(exportRequest()),
      500,
      "output-contract-violation"
    );
  });

  test("propagates cancellation and redacts a late stream failure", async () => {
    let cancelled = false;
    const cancellableEvents: ExportRecipeApplicationValue["events"] = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({
              done: false as const,
              value: { bytes: new Uint8Array([1]), type: "chunk" as const },
            }),
          return: () => {
            cancelled = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    const cancellable = createHttpApp(
      makeDependencies({
        exportRecipeApplication: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exportedRecipeApplication,
              contentLength: 1,
              events: cancellableEvents,
            },
          }),
      })
    );
    const cancellableResponse = await cancellable.request(exportRequest());
    const cancellableReader = cancellableResponse.body?.getReader();
    assert.ok(cancellableReader);
    await cancellableReader.read();
    await cancellableReader.cancel();
    assert.equal(cancelled, true);

    const failingEvents: ExportRecipeApplicationValue["events"] = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { bytes: new Uint8Array([1]), type: "chunk" } as const;
        throw new Error("sensitive-row-value");
      },
    };
    const failing = createHttpApp(
      makeDependencies({
        exportRecipeApplication: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exportedRecipeApplication,
              contentLength: 2,
              events: failingEvents,
            },
          }),
      })
    );
    const failingResponse = await failing.request(exportRequest());
    const failingReader = failingResponse.body?.getReader();
    assert.ok(failingReader);
    assert.deepEqual(await failingReader.read(), {
      done: false,
      value: new Uint8Array([1]),
    });
    await assert.rejects(failingReader.read(), EXPORT_STREAM_FAILURE_PATTERN);
  });

  test("rejects other methods canonically", async () => {
    const response = await createHttpApp(makeDependencies()).request(
      "/v1/recipe-application-exports",
      { method: "GET" }
    );
    await assertProblem(response, 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("POST /v1/dataset-exports", () => {
  test("streams exact JSONL and CSV projections with canonical download headers", async () => {
    const requests: Parameters<ExportDataset>[0][] = [];
    const jsonlBody =
      '{"display_name":"Synthetic Contact","work_email":"synthetic@example.test"}\n';
    const csvBody = '"work_email"\n"synthetic@example.test"\n';
    const app = createHttpApp(
      makeDependencies({
        exportDataset: (request) => {
          requests.push(request);
          return Promise.resolve({
            ok: true,
            value:
              request.format === "csv"
                ? datasetExportValue(
                    "csv",
                    csvBody,
                    datasetExportFields.slice(1)
                  )
                : datasetExportValue("jsonl", jsonlBody),
          });
        },
      })
    );

    const cases = [
      {
        body: jsonlBody,
        contentType: "application/x-ndjson",
        fieldIds: ["field-display-name", "field-work-email"],
        filename: 'attachment; filename="kurobara-dataset.jsonl"',
        format: "jsonl",
      },
      {
        body: csvBody,
        contentType: "text/csv; charset=utf-8",
        fieldIds: ["field-work-email"],
        filename: 'attachment; filename="kurobara-dataset.csv"',
        format: "csv",
      },
    ] as const;
    for (const current of cases) {
      const response = await app.request("/v1/dataset-exports", {
        body: JSON.stringify({
          dataset_id: "derived-contacts-synthetic",
          field_ids: current.fieldIds,
          format: current.format,
        }),
        headers: JSON_HEADERS,
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(
        response.headers.get("content-disposition"),
        current.filename
      );
      assert.equal(response.headers.get("content-type"), current.contentType);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        response.headers.get("content-length"),
        String(new TextEncoder().encode(current.body).byteLength)
      );
      assert.equal(
        response.headers.get("x-kurobara-content-sha256"),
        SYNTHETIC_HASH
      );
      assert.equal(await response.text(), current.body);
    }

    assert.deepEqual(requests, [
      {
        actor,
        datasetId: "derived-contacts-synthetic",
        fieldIds: ["field-display-name", "field-work-email"],
        format: "jsonl",
        maxRecordBytes: 16_777_216,
      },
      {
        actor,
        datasetId: "derived-contacts-synthetic",
        fieldIds: ["field-work-email"],
        format: "csv",
        maxRecordBytes: 16_777_216,
      },
    ]);
  });

  test("adds one complete delivery tuple for Contact exports and rejects a malformed receipt", async () => {
    const body =
      '{"display_name":"Synthetic Contact","work_email":"synthetic@example.test"}\n';
    const exported = datasetExportValue("jsonl", body);
    const trackedDelivery = {
      ...exportDelivery,
      manifest: {
        ...exportDelivery.manifest,
        contentHash: exported.contentHash,
        contentLength: exported.contentLength,
        fieldIds: exported.fields.map((field) => field.fieldId),
      },
    } as unknown as NonNullable<ExportDatasetValue["delivery"]>;
    const app = createHttpApp(
      makeDependencies({
        exportDataset: () =>
          Promise.resolve({
            ok: true,
            value: { ...exported, delivery: trackedDelivery },
          }),
      })
    );
    const response = await app.request("/v1/dataset-exports", {
      body: JSON.stringify({
        dataset_id: "derived-contacts-synthetic",
        format: "jsonl",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-kurobara-delivery-id"),
      "delivery-synthetic"
    );
    assert.equal(
      response.headers.get("x-kurobara-delivery-expires-at-ms"),
      "1752786400000"
    );
    assert.equal(response.headers.get("x-kurobara-delivery-state"), "prepared");
    assert.equal(await response.text(), body);

    const replayed = createHttpApp(
      makeDependencies({
        exportDataset: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exported,
              delivery: {
                ...trackedDelivery,
                deliveredAt: 1_752_700_020_000,
                state: "delivered",
              } as unknown as NonNullable<ExportDatasetValue["delivery"]>,
            },
          }),
      })
    );
    const replayedResponse = await replayed.request("/v1/dataset-exports", {
      body: JSON.stringify({
        dataset_id: "derived-contacts-synthetic",
        format: "jsonl",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    });
    assert.equal(replayedResponse.status, 200);
    assert.equal(
      replayedResponse.headers.get("x-kurobara-delivery-state"),
      "delivered"
    );
    assert.equal(await replayedResponse.text(), body);

    const malformed = createHttpApp(
      makeDependencies({
        exportDataset: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exported,
              delivery: {
                ...trackedDelivery,
                manifest: {
                  ...trackedDelivery.manifest,
                  contentHash: `sha256:${"b".repeat(64)}`,
                },
              } as unknown as NonNullable<ExportDatasetValue["delivery"]>,
            },
          }),
      })
    );
    const invalid = await malformed.request("/v1/dataset-exports", {
      body: JSON.stringify({
        dataset_id: "derived-contacts-synthetic",
        format: "jsonl",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    });
    await assertProblem(invalid.clone(), 500, "output-contract-violation");
    assert.equal(invalid.headers.get("x-kurobara-delivery-id"), null);
    assert.equal(
      invalid.headers.get("x-kurobara-delivery-expires-at-ms"),
      null
    );
    assert.equal(invalid.headers.get("x-kurobara-delivery-state"), null);

    const revoked = createHttpApp(
      makeDependencies({
        exportDataset: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exported,
              delivery: {
                ...trackedDelivery,
                revokedAt: 1_752_700_030_000,
                state: "revoked",
              } as unknown as NonNullable<ExportDatasetValue["delivery"]>,
            },
          }),
      })
    );
    const revokedResponse = await revoked.request("/v1/dataset-exports", {
      body: JSON.stringify({
        dataset_id: "derived-contacts-synthetic",
        format: "jsonl",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    });
    await assertProblem(
      revokedResponse.clone(),
      500,
      "output-contract-violation"
    );
    assert.equal(revokedResponse.headers.get("x-kurobara-delivery-id"), null);
  });

  test("validates field selection before I/O and redacts export failures", async () => {
    let exportCalls = 0;
    const invalidApp = createHttpApp(
      makeDependencies({
        exportDataset: () => {
          exportCalls += 1;
          return Promise.resolve({
            ok: true,
            value: datasetExportValue("jsonl", "{}\n"),
          });
        },
      })
    );
    const invalid = await invalidApp.request("/v1/dataset-exports", {
      body: JSON.stringify({
        dataset_id: "derived-contacts-synthetic",
        field_ids: ["field-work-email", "field-work-email"],
        format: "jsonl",
      }),
      headers: JSON_HEADERS,
      method: "POST",
    });
    await assertProblem(invalid, 400, "request-invalid");
    assert.equal(exportCalls, 0);

    for (const [failureCode, expectedCode, expectedStatus] of [
      ["authority-permission-missing", "authority-permission-missing", 403],
      ["contact-privacy-restricted", "authority-permission-missing", 403],
      ["contact-privacy-check-failed", "service-unavailable", 503],
      ["field-selection-invalid", "request-invalid", 400],
    ] as const) {
      const app = createHttpApp(
        makeDependencies({
          exportDataset: () =>
            Promise.resolve({
              error: {
                code: failureCode,
                message: "sensitive-dataset-export-detail",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request("/v1/dataset-exports", {
        body: JSON.stringify({
          dataset_id: "derived-contacts-synthetic",
          format: "jsonl",
        }),
        headers: JSON_HEADERS,
        method: "POST",
      });
      await assertProblem(response.clone(), expectedStatus, expectedCode);
      assert.doesNotMatch(await response.text(), SENSITIVE_DETAIL_PATTERN);
    }
  });

  test("refuses undeclared methods", async () => {
    const response = await createHttpApp(makeDependencies()).request(
      "/v1/dataset-exports",
      { method: "GET" }
    );
    await assertProblem(response.clone(), 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("export delivery lifecycle routes", () => {
  test("reads and revokes one owner-scoped PII-free delivery", async () => {
    const getRequests: Parameters<GetExportDelivery>[0][] = [];
    const revokeRequests: Parameters<RevokeExportDelivery>[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        getExportDelivery: (request) => {
          getRequests.push(request);
          return Promise.resolve({
            ok: true,
            value: exportDeliveryReadback,
          });
        },
        revokeExportDelivery: (request) => {
          revokeRequests.push(request);
          return Promise.resolve({
            ok: true,
            value: {
              ...exportDelivery,
              revokedAt: 1_752_700_040_000,
              state: "revoked",
            } as unknown as RevokeExportDeliveryValue,
          });
        },
      })
    );

    const read = await app.request("/v1/export-deliveries/delivery-synthetic", {
      headers: { authorization: AUTHORIZATION },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "private, no-store");
    const readBody = await read.json();
    assert.deepEqual(readBody, {
      content_hash: SYNTHETIC_HASH,
      content_length: 76,
      dataset_id: "derived-contacts-synthetic",
      delivered_at_ms: 1_752_700_020_000,
      delivery_id: "delivery-synthetic",
      expires_at_ms: 1_752_786_400_000,
      format: "jsonl",
      prepared_at_ms: 1_752_700_010_000,
      state: "delivered",
    });

    const revoked = await app.request(
      "/v1/export-deliveries/delivery-synthetic/revoke",
      {
        body: "{}",
        headers: JSON_HEADERS,
        method: "POST",
      }
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.headers.get("cache-control"), "private, no-store");
    const revokedBody = await revoked.json();
    assert.deepEqual(revokedBody, {
      content_hash: SYNTHETIC_HASH,
      content_length: 76,
      dataset_id: "derived-contacts-synthetic",
      delivery_id: "delivery-synthetic",
      expires_at_ms: 1_752_786_400_000,
      format: "jsonl",
      prepared_at_ms: 1_752_700_010_000,
      revoked_at_ms: 1_752_700_040_000,
      state: "revoked",
    });
    assert.deepEqual(getRequests, [
      { actor, deliveryId: "delivery-synthetic" },
    ]);
    assert.deepEqual(revokeRequests, [
      { actor, deliveryId: "delivery-synthetic" },
    ]);
    assert.doesNotMatch(
      JSON.stringify([readBody, revokedBody]),
      CONTACT_SENSITIVE_FIELD_PATTERN
    );
  });

  test("maps permission and owner-masked absence without leaking messages", async () => {
    for (const [dependency, path, method] of [
      ["getExportDelivery", "/v1/export-deliveries/delivery-synthetic", "GET"],
      [
        "revokeExportDelivery",
        "/v1/export-deliveries/delivery-synthetic/revoke",
        "POST",
      ],
    ] as const) {
      for (const [failure, status, code] of [
        ["authority-permission-missing", 403, "authority-permission-missing"],
        ["delivery-not-found", 404, "export-delivery-not-found"],
      ] as const) {
        const app = createHttpApp(
          makeDependencies({
            [dependency]: () =>
              Promise.resolve({
                error: {
                  code: failure,
                  message: "sensitive-private-person@example.test",
                },
                ok: false,
              }),
          })
        );
        const response = await app.request(path, {
          ...(method === "POST" ? { body: "{}" } : {}),
          headers:
            method === "POST" ? JSON_HEADERS : { authorization: AUTHORIZATION },
          method,
        });
        await assertProblem(response.clone(), status, code);
        assert.doesNotMatch(await response.text(), SENSITIVE_DETAIL_PATTERN);
      }
    }
  });

  test("fails closed on cross-workspace output, unavailable composition, invalid paths, and methods", async () => {
    const crossWorkspace = createHttpApp(
      makeDependencies({
        getExportDelivery: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...exportDeliveryReadback,
              delivery: {
                ...exportDeliveryReadback.delivery,
                manifest: {
                  ...exportDeliveryReadback.delivery.manifest,
                  workspaceId: "workspace-other",
                },
              },
            } as unknown as GetExportDeliveryValue,
          }),
      })
    );
    await assertProblem(
      await crossWorkspace.request("/v1/export-deliveries/delivery-synthetic", {
        headers: { authorization: AUTHORIZATION },
      }),
      500,
      "output-contract-violation"
    );
    for (const invalidDelivery of [
      exportDelivery,
      {
        ...exportDelivery,
        state: "revoked",
      } as unknown as RevokeExportDeliveryValue,
    ]) {
      const invalidRevoke = createHttpApp(
        makeDependencies({
          revokeExportDelivery: () =>
            Promise.resolve({ ok: true, value: invalidDelivery }),
        })
      );
      await assertProblem(
        await invalidRevoke.request(
          "/v1/export-deliveries/delivery-synthetic/revoke",
          { body: "{}", headers: JSON_HEADERS, method: "POST" }
        ),
        500,
        "output-contract-violation"
      );
    }

    const dependencies = makeDependencies();
    const {
      getExportDelivery: _get,
      revokeExportDelivery: _revoke,
      ...rest
    } = dependencies;
    await assertProblem(
      await createHttpApp(rest).request(
        "/v1/export-deliveries/delivery-synthetic",
        { headers: { authorization: AUTHORIZATION } }
      ),
      503,
      "service-unavailable"
    );
    await assertProblem(
      await createHttpApp(makeDependencies()).request(
        "/v1/export-deliveries/%20",
        { headers: { authorization: AUTHORIZATION } }
      ),
      400,
      "request-invalid"
    );
    await assertProblem(
      await createHttpApp(makeDependencies()).request(
        "/v1/export-deliveries/delivery-synthetic/revoke",
        {
          body: "{}",
          headers: { authorization: AUTHORIZATION },
          method: "POST",
        }
      ),
      415,
      "unsupported-media-type"
    );
    await assertProblem(
      await createHttpApp(makeDependencies()).request(
        "/v1/export-deliveries/delivery-synthetic/revoke",
        {
          body: '{"unexpected":true}',
          headers: JSON_HEADERS,
          method: "POST",
        }
      ),
      400,
      "request-invalid"
    );

    const wrongGetMethod = await createHttpApp(makeDependencies()).request(
      "/v1/export-deliveries/delivery-synthetic",
      { method: "POST" }
    );
    await assertProblem(wrongGetMethod.clone(), 405, "method-not-allowed");
    assert.equal(wrongGetMethod.headers.get("allow"), "GET");
    const wrongRevokeMethod = await createHttpApp(makeDependencies()).request(
      "/v1/export-deliveries/delivery-synthetic/revoke",
      { method: "GET" }
    );
    await assertProblem(wrongRevokeMethod.clone(), 405, "method-not-allowed");
    assert.equal(wrongRevokeMethod.headers.get("allow"), "POST");
  });
});

describe("POST /v1/contact-privacy-restrictions", () => {
  test("registers exact email and provider subjects while returning only a PII-free receipt", async () => {
    const requests: Parameters<RestrictContactPrivacy>[0][] = [];
    const app = createHttpApp(
      makeDependencies({
        restrictContactPrivacy: (request) => {
          requests.push(request);
          return Promise.resolve({
            ok: true,
            value: {
              ...contactPrivacyRestriction,
              proof: {
                ...contactPrivacyRestriction.proof,
                reason: request.reason,
              },
            } as RestrictContactPrivacyValue,
          });
        },
      })
    );
    const inputs = [
      {
        idempotency_key: "restriction-email-synthetic",
        reason: "provider-opt-out",
        subject: {
          kind: "email",
          value: "private.person@example.test",
        },
      },
      {
        idempotency_key: "restriction-provider-synthetic",
        reason: "provider-deletion",
        subject: {
          kind: "provider-subject",
          provider_key: "synthetic-provider",
          value: "sensitive-provider-subject",
        },
      },
    ] as const;
    for (const input of inputs) {
      const response = await app.request("/v1/contact-privacy-restrictions", {
        body: JSON.stringify(input),
        headers: JSON_HEADERS,
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        affected_delivery_count: 2,
        newly_revoked_delivery_count: 1,
        reason: input.reason,
        registered_at_ms: 1_752_700_030_000,
        replayed: false,
        tombstone_id: "tombstone-synthetic",
      });
      assert.equal(text.includes(input.subject.value), false);
    }
    assert.deepEqual(requests, [
      {
        actor,
        idempotencyKey: "restriction-email-synthetic",
        reason: "provider-opt-out",
        subject: {
          kind: "email",
          value: "private.person@example.test",
        },
      },
      {
        actor,
        idempotencyKey: "restriction-provider-synthetic",
        reason: "provider-deletion",
        subject: {
          kind: "provider-subject",
          providerKey: "synthetic-provider",
          value: "sensitive-provider-subject",
        },
      },
    ]);
  });

  test("validates before I/O and redacts permission, conflict, and subject errors", async () => {
    let calls = 0;
    const validationApp = createHttpApp(
      makeDependencies({
        restrictContactPrivacy: () => {
          calls += 1;
          return Promise.resolve({
            ok: true,
            value: contactPrivacyRestriction,
          });
        },
      })
    );
    const invalid = await validationApp.request(
      "/v1/contact-privacy-restrictions",
      {
        body: JSON.stringify({
          idempotency_key: "restriction-invalid",
          reason: "provider-opt-out",
          subject: { kind: "email", value: "not-an-email" },
        }),
        headers: JSON_HEADERS,
        method: "POST",
      }
    );
    await assertProblem(invalid, 400, "request-invalid");
    assert.equal(calls, 0);

    for (const [failure, status, code] of [
      ["authority-permission-missing", 403, "authority-permission-missing"],
      ["idempotency-conflict", 409, "idempotency-key-reused"],
      ["subject-invalid", 400, "request-invalid"],
    ] as const) {
      const app = createHttpApp(
        makeDependencies({
          restrictContactPrivacy: () =>
            Promise.resolve({
              error: {
                code: failure,
                message: "sensitive-private-person@example.test",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request("/v1/contact-privacy-restrictions", {
        body: JSON.stringify({
          idempotency_key: "restriction-synthetic",
          reason: "provider-opt-out",
          subject: {
            kind: "email",
            value: "private.person@example.test",
          },
        }),
        headers: JSON_HEADERS,
        method: "POST",
      });
      await assertProblem(response.clone(), status, code);
      assert.equal(
        (await response.text()).includes("private.person@example.test"),
        false
      );
    }
  });

  test("fails closed on workspace drift and rejects unavailable, media-type, and method cases", async () => {
    const crossWorkspace = createHttpApp(
      makeDependencies({
        restrictContactPrivacy: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...contactPrivacyRestriction,
              proof: {
                ...contactPrivacyRestriction.proof,
                workspaceId: "workspace-other",
              },
            } as unknown as RestrictContactPrivacyValue,
          }),
      })
    );
    const body = JSON.stringify({
      idempotency_key: "restriction-synthetic",
      reason: "provider-opt-out",
      subject: { kind: "email", value: "private.person@example.test" },
    });
    await assertProblem(
      await crossWorkspace.request("/v1/contact-privacy-restrictions", {
        body,
        headers: JSON_HEADERS,
        method: "POST",
      }),
      500,
      "output-contract-violation"
    );

    const dependencies = makeDependencies();
    const { restrictContactPrivacy: _restrict, ...withoutRestriction } =
      dependencies;
    await assertProblem(
      await createHttpApp(withoutRestriction).request(
        "/v1/contact-privacy-restrictions",
        { body, headers: JSON_HEADERS, method: "POST" }
      ),
      503,
      "service-unavailable"
    );
    await assertProblem(
      await createHttpApp(makeDependencies()).request(
        "/v1/contact-privacy-restrictions",
        {
          body,
          headers: {
            authorization: AUTHORIZATION,
            "content-type": "text/plain",
          },
          method: "POST",
        }
      ),
      415,
      "unsupported-media-type"
    );
    const wrongMethod = await createHttpApp(makeDependencies()).request(
      "/v1/contact-privacy-restrictions",
      { method: "GET" }
    );
    await assertProblem(wrongMethod.clone(), 405, "method-not-allowed");
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  });
});

describe("POST /v1/dataset-imports", () => {
  test("streams canonical multipart source bytes into first and replay calls", async () => {
    const calls: Parameters<HttpAdapterDependencies["importDataset"]>[0][] = [];
    const observedChunks: Uint8Array[][] = [];
    let invocation = 0;
    const app = createHttpApp(
      makeDependencies({
        importDataset: async (request) => {
          calls.push(request);
          const chunks: Uint8Array[] = [];
          for await (const chunk of request.bytes) {
            assert.ok(chunk instanceof Uint8Array);
            chunks.push(chunk);
          }
          observedChunks.push(chunks);
          invocation += 1;
          return {
            ok: true,
            value: { ...importedDataset, replayed: invocation === 2 },
          };
        },
      })
    );
    const sourceChunks = [
      '{"record_id":"record-1","name":"Ada"}\n',
      '{"record_id":"record-2","name":"Lin"}\n',
    ];

    const first = await app.request(
      importRequest([metadataPart(), sourcePart(sourceChunks)])
    );
    const replay = await app.request(
      importRequest([metadataPart(), sourcePart(sourceChunks)])
    );

    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      batch_count: 1,
      dataset_id: "dataset-synthetic",
      error_count: 0,
      import_id: "import-synthetic",
      item_count: 2,
      record_count: 2,
      replayed: false,
      state: "completed",
      workspace_id: "workspace-synthetic",
    });
    assert.equal(replay.status, 200);
    assert.equal(Reflect.get(await replay.json(), "replayed"), true);
    assert.equal(calls.length, 2);
    assert.strictEqual(calls[0]?.actor, actor);
    assert.deepEqual(calls[0]?.batchLimits, {
      maxBytes: 4096,
      maxItems: 100,
    });
    assert.deepEqual(calls[0]?.dataset, {
      datasetId: "dataset-synthetic",
      name: "Synthetic dataset",
      workspaceId: "workspace-synthetic",
    });
    assert.deepEqual(calls[0]?.fields, [
      {
        datasetId: "dataset-synthetic",
        fieldId: "field-name",
        key: "name",
        label: "Name",
        valueType: "string",
        workspaceId: "workspace-synthetic",
      },
    ]);
    assert.equal(calls[0]?.format, "jsonl");
    assert.equal(calls[0]?.importId, "import-synthetic");
    assert.equal(calls[0]?.maxRecordBytes, 1024);
    assert.equal(calls[0]?.sourceContentHash, SYNTHETIC_HASH);
    for (const chunks of observedChunks) {
      assert.ok(chunks.length > 0);
      assert.equal(
        new TextDecoder().decode(
          Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
        ),
        sourceChunks.join("")
      );
    }
  });

  test("enforces multipart ordering, media types, exact parts, and metadata shape", async () => {
    let calls = 0;
    const app = createHttpApp(
      makeDependencies({
        importDataset: () => {
          calls += 1;
          return Promise.resolve({ ok: true, value: importedDataset });
        },
      })
    );

    await assertProblem(
      await app.request("/v1/dataset-imports", {
        body: "{}",
        headers: JSON_HEADERS,
        method: "POST",
      }),
      415,
      "unsupported-media-type"
    );
    await assertProblem(
      await app.request(importRequest([sourcePart(), metadataPart()])),
      400,
      "request-invalid"
    );
    await assertProblem(
      await app.request(
        importRequest([metadataPart(), sourcePart(undefined, "text/csv")])
      ),
      415,
      "unsupported-media-type"
    );
    await assertProblem(
      await app.request(
        importRequest([{ ...metadataPart(), chunks: ["{"] }, sourcePart()])
      ),
      400,
      "request-invalid"
    );
    await assertProblem(
      await app.request(
        importRequest([
          metadataPart({ ...validImportMetadata, unexpected: true }),
          sourcePart(),
        ])
      ),
      400,
      "request-invalid"
    );
    await assertProblem(
      await app.request(importRequest([metadataPart()])),
      400,
      "request-invalid"
    );
    assert.equal(calls, 0);
    await assertProblem(
      await app.request(
        importRequest([metadataPart(), sourcePart(), sourcePart()])
      ),
      400,
      "request-invalid"
    );
    assert.equal(calls, 1);
  });

  test("bounds metadata and source independently without buffering source", async () => {
    const metadataLimited = createHttpApp(makeDependencies(), {
      maxBodyBytes: 32,
    });
    await assertProblem(
      await metadataLimited.request(
        importRequest([metadataPart(), sourcePart()])
      ),
      413,
      "payload-too-large"
    );

    let observedBytes = 0;
    const sourceLimited = createHttpApp(
      makeDependencies({
        importDataset: async (request) => {
          for await (const chunk of request.bytes) {
            observedBytes += chunk.byteLength;
          }
          return { ok: true, value: importedDataset };
        },
      }),
      { maxImportBytes: 4 }
    );
    await assertProblem(
      await sourceLimited.request(
        importRequest([metadataPart(), sourcePart(["123", "456"])])
      ),
      413,
      "payload-too-large"
    );
    assert.ok(observedBytes <= 4);
  });

  test("drains the source after application cancellation", async () => {
    let firstChunkBytes = 0;
    const app = createHttpApp(
      makeDependencies({
        importDataset: async (request) => {
          const iterator = request.bytes[Symbol.asyncIterator]();
          const first = await iterator.next();
          assert.equal(first.done, false);
          if (!first.done) {
            firstChunkBytes = first.value.byteLength;
          }
          await iterator.return?.();
          return {
            error: {
              code: "dataset-import-conflict",
              message: "sensitive durable conflict",
            },
            ok: false,
          };
        },
      })
    );

    const response = await app.request(
      importRequest([
        metadataPart(),
        sourcePart(["first\n", "second\n", "third\n"]),
      ])
    );
    await assertProblem(response, 409, "dataset-import-conflict");
    assert.ok(firstChunkBytes > 0);
  });

  test("rejects an aborted request without starting the import", async () => {
    let calls = 0;
    const app = createHttpApp(
      makeDependencies({
        importDataset: () => {
          calls += 1;
          return Promise.resolve({ ok: true, value: importedDataset });
        },
      })
    );
    const controller = new AbortController();
    const request = importRequest(
      [metadataPart(), sourcePart()],
      "kurobara-aborted-boundary",
      controller.signal
    );
    controller.abort();

    await assertProblem(await app.request(request), 400, "request-invalid");
    assert.equal(calls, 0);
  });

  test("settles a pump failure while the source is active", {
    timeout: 2000,
  }, async () => {
    const boundary = "kurobara-failing-pump-boundary";
    const chunks = multipartBodyChunks(
      [metadataPart(), sourcePart(["partial-source"])],
      boundary
    );
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === 5) {
          throw new Error("synthetic disconnected request");
        }
        const chunk = chunks[index];
        index += 1;
        if (chunk !== undefined) {
          controller.enqueue(chunk);
        }
      },
    });
    const request = new Request("http://localhost/v1/dataset-imports", {
      body,
      duplex: "half",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });
    const app = createHttpApp(
      makeDependencies({
        importDataset: async (input) => {
          for await (const _chunk of input.bytes) {
            // Consumption proves the source iterator also settles on disconnect.
          }
          return { ok: true, value: importedDataset };
        },
      })
    );

    await assertProblem(await app.request(request), 400, "request-invalid");
  });

  test("maps every declared import failure without exposing messages", async () => {
    const cases = [
      ["authority-permission-missing", 403],
      ["authority-subject-mismatch", 403],
      ["dataset-import-conflict", 409],
      ["dataset-import-failed", 422],
      ["dataset-source-mismatch", 422],
      ["request-invalid", 400],
    ] as const;

    for (const [code, status] of cases) {
      const app = createHttpApp(
        makeDependencies({
          importDataset: () =>
            Promise.resolve({
              error: { code, message: `sensitive-${code}` },
              ok: false,
            }),
        })
      );
      const response = await app.request(
        importRequest([metadataPart(), sourcePart()])
      );
      const responseText = await response.clone().text();
      await assertProblem(response, status, code);
      assert.doesNotMatch(responseText, SENSITIVE_DETAIL_PATTERN);
    }
  });

  test("enforces output contract plus registered route and method", async () => {
    const invalidOutput = createHttpApp(
      makeDependencies({
        importDataset: () =>
          Promise.resolve({
            ok: true,
            value: {
              ...importedDataset,
              progress: { ...importedDataset.progress, state: "running" },
            } as unknown as ImportDatasetValue,
          }),
      })
    );
    await assertProblem(
      await invalidOutput.request(
        importRequest([metadataPart(), sourcePart()])
      ),
      500,
      "output-contract-violation"
    );

    const app = createHttpApp(makeDependencies());
    const method = await app.request("/v1/dataset-imports", {
      method: "GET",
    });
    await assertProblem(method, 405, "method-not-allowed");
    assert.equal(method.headers.get("allow"), "POST");
  });
});

describe("GET /v1/recipe-applications/:application_id", () => {
  test("returns one no-store durable status snapshot", async () => {
    let observedApplicationId = "";
    const app = createHttpApp(
      makeDependencies({
        getRecipeApplicationStatus: (request) => {
          observedApplicationId = request.recipeApplicationId;
          return Promise.resolve({
            ok: true,
            value: watchedRecipeApplication,
          });
        },
      })
    );
    const response = await app.request(watchRequest());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(observedApplicationId, "application-synthetic");
    assert.deepEqual(await response.json(), {
      application_id: "application-synthetic",
      bound_cell_count: 2,
      dataset_id: "dataset-synthetic",
      failed_cell_count: 0,
      pending_cell_count: 1,
      recipe_id: "recipe-synthetic",
      recipe_revision: "1.0.0",
      running_cell_count: 0,
      skipped_cell_count: 0,
      state: "running",
      succeeded_cell_count: 1,
      terminal: false,
      total_cell_count: 2,
      unbound_cell_count: 0,
      workspace_id: "workspace-synthetic",
    });
  });

  test("authenticates and validates the path before reading status", async () => {
    let calls = 0;
    const app = createHttpApp(
      makeDependencies({
        getRecipeApplicationStatus: () => {
          calls += 1;
          return Promise.resolve({
            ok: true,
            value: watchedRecipeApplication,
          });
        },
      })
    );

    const unauthenticated = await app.request(
      watchRequest("application-synthetic", {})
    );
    await assertProblem(unauthenticated, 401, "authentication-required");
    assert.equal(
      unauthenticated.headers.get("cache-control"),
      "private, no-store"
    );
    await assertProblem(
      await app.request(watchRequest("x".repeat(256))),
      400,
      "request-invalid"
    );
    assert.equal(calls, 0);
  });

  test("preserves not-found non-disclosure and maps watch invariants", async () => {
    for (const [code, expected] of [
      ["recipe-application-not-found", "recipe-application-not-found"],
      ["recipe-application-watch-invariant", "output-contract-violation"],
    ] as const) {
      const app = createHttpApp(
        makeDependencies({
          getRecipeApplicationStatus: () =>
            Promise.resolve({
              error: {
                code,
                message: "sensitive-other-workspace-application",
              },
              ok: false,
            }),
        })
      );
      const response = await app.request(watchRequest());
      await assertProblem(
        response.clone(),
        expected === "recipe-application-not-found" ? 404 : 500,
        expected
      );
      assert.doesNotMatch(await response.text(), SENSITIVE_DETAIL_PATTERN);
    }
  });

  test("rejects response-schema and cross-field invariant drift", async () => {
    for (const value of [
      {
        ...watchedRecipeApplication,
        counts: { ...watchedRecipeApplication.counts, total: 3 },
      },
      {
        ...watchedRecipeApplication,
        state: "succeeded",
        terminal: true,
      },
    ]) {
      const app = createHttpApp(
        makeDependencies({
          getRecipeApplicationStatus: () =>
            Promise.resolve({
              ok: true,
              value: value as GetRecipeApplicationStatusValue,
            }),
        })
      );
      await assertProblem(
        await app.request(watchRequest()),
        500,
        "output-contract-violation"
      );
    }
  });

  test("registers only GET on the item route", async () => {
    const response = await createHttpApp(makeDependencies()).request(
      "/v1/recipe-applications/application-synthetic",
      { method: "POST" }
    );
    await assertProblem(response.clone(), 405, "method-not-allowed");
    assert.equal(response.headers.get("allow"), "GET");
  });
});

describe("GET /v1/runs/:run_id", () => {
  test("returns the authorized run snapshot", async () => {
    const app = createHttpApp(makeDependencies());
    const response = await app.request("/v1/runs/run-synthetic", {
      headers: { authorization: AUTHORIZATION },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aggregate_version: 1,
      cost: { reserved: 8, spent: 2, unit: "credits" },
      created_at_ms: 1_752_700_000_000,
      event_sequence: 1,
      result_completeness: "none",
      run_id: "run-synthetic",
      run_plan_id: "plan-synthetic",
      state: "queued",
      workspace_id: "workspace-synthetic",
    });
  });

  test("preserves workspace non-disclosure from the supplied use case", async () => {
    const app = createHttpApp(
      makeDependencies({
        getRun: () =>
          Promise.resolve({
            error: {
              code: "run-not-found",
              message: "Run belongs to workspace-secret-other-tenant.",
            },
            ok: false,
          }),
      })
    );
    const response = await app.request("/v1/runs/run-secret", {
      headers: { authorization: AUTHORIZATION },
    });

    await assertProblem(response.clone(), 404, "run-not-found");
    const responseText = await response.text();
    assert.ok(!responseText.includes("workspace-secret"));
    assert.ok(!responseText.includes("other-tenant"));
  });

  test("maps read permission and request failures canonically", async () => {
    for (const [code, status] of [
      ["authority-permission-missing", 403],
      ["request-invalid", 400],
      ["run-not-found", 404],
    ] as const) {
      const app = createHttpApp(
        makeDependencies({
          getRun: () => {
            if (code === "request-invalid") {
              return Promise.resolve({
                error: {
                  code,
                  message: "The run identifier is invalid.",
                },
                ok: false,
              });
            }
            return Promise.resolve({
              error: { code, message: "unsafe-message" },
              ok: false,
            });
          },
        })
      );
      await assertProblem(
        await app.request("/v1/runs/run-synthetic", {
          headers: { authorization: AUTHORIZATION },
        }),
        status,
        code
      );
    }
  });
});

describe("authentication and routing", () => {
  test("uses an explicitly configured authorization-header limit", async () => {
    const app = createHttpApp(makeDependencies(), {
      maxAuthorizationHeaderBytes: 16,
    });

    await assertProblem(
      await app.request(createRequest()),
      401,
      "authentication-required"
    );
  });

  test("rejects invalid explicit limits at composition time", () => {
    assert.throws(
      () => createHttpApp(makeDependencies(), { maxBodyBytes: 0 }),
      BODY_LIMIT_ERROR_PATTERN
    );
    assert.throws(
      () => createHttpApp(makeDependencies(), { maxImportBytes: 0 }),
      IMPORT_LIMIT_ERROR_PATTERN
    );
    assert.throws(
      () =>
        createHttpApp(makeDependencies(), {
          maxAuthorizationHeaderBytes: 1.5,
        }),
      AUTHORIZATION_LIMIT_ERROR_PATTERN
    );
  });

  test("rejects missing, malformed, and oversized Bearer headers before auth", async () => {
    let authenticationCalls = 0;
    const app = createHttpApp(
      makeDependencies({
        authenticateApiKey: () => {
          authenticationCalls += 1;
          return Promise.resolve({ ok: true, value: actor });
        },
      })
    );

    const invalidHeaders = [
      undefined,
      "bearer token",
      "Bearer",
      "Bearer token with-space",
      "Bearer token,second",
      `Bearer ${"x".repeat(HTTP_ADAPTER_LIMITS.authorizationHeaderBytes)}`,
    ];
    for (const authorization of invalidHeaders) {
      const headers: Record<string, string> = {
        "content-type": JSON_MEDIA_TYPE,
      };
      if (authorization !== undefined) {
        headers.authorization = authorization;
      }
      const response = await app.request(
        createRequest(JSON.stringify(validCreateBody), headers)
      );
      await assertProblem(response, 401, "authentication-required");
    }
    assert.equal(authenticationCalls, 0);
  });

  test("maps a rejected well-formed credential and does not use its message", async () => {
    const app = createHttpApp(
      makeDependencies({
        authenticateApiKey: () =>
          Promise.resolve({
            error: {
              code: "invalid-credential",
              message: "credential-secret-diagnostic",
            },
            ok: false,
          }),
      })
    );
    const response = await app.request(createRequest());
    await assertProblem(response.clone(), 401, "invalid-credential");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.ok(
      !(await response.text()).includes("credential-secret-diagnostic")
    );
  });

  test("distinguishes known methods from routes that are not registered", async () => {
    const app = createHttpApp(makeDependencies());

    const wrongMethod = await app.request("/v1/runs", { method: "GET" });
    await assertProblem(wrongMethod.clone(), 405, "method-not-allowed");
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const wrongItemMethod = await app.request("/v1/runs/run-synthetic", {
      method: "POST",
    });
    await assertProblem(wrongItemMethod.clone(), 405, "method-not-allowed");
    assert.equal(wrongItemMethod.headers.get("allow"), "GET");

    const wrongCompanyCandidatesMethod = await app.request(
      "/v1/dataset-generations/generation-synthetic/company-candidates",
      { method: "POST" }
    );
    await assertProblem(
      wrongCompanyCandidatesMethod.clone(),
      405,
      "method-not-allowed"
    );
    assert.equal(wrongCompanyCandidatesMethod.headers.get("allow"), "GET");

    await assertProblem(
      await app.request("/v1/not-real"),
      404,
      "route-not-found"
    );
  });

  test("rejects invalid correlation identifiers before authentication", async () => {
    let authenticationCalls = 0;
    const app = createHttpApp(
      makeDependencies({
        authenticateApiKey: () => {
          authenticationCalls += 1;
          return Promise.resolve({ ok: true, value: actor });
        },
      })
    );
    const response = await app.request(
      createRequest(JSON.stringify(validCreateBody), {
        ...JSON_HEADERS,
        "x-correlation-id": "contains spaces",
      })
    );

    await assertProblem(response, 400, "request-invalid");
    assert.equal(authenticationCalls, 0);
  });
});

describe("redaction and success-contract enforcement", () => {
  test("redacts thrown internal errors", async () => {
    const app = createHttpApp(
      makeDependencies({
        createRun: () =>
          Promise.reject(
            new Error("postgres://secret-user:secret-password@database")
          ),
      })
    );
    const response = await app.request(createRequest());
    await assertProblem(response.clone(), 500, "internal-error");
    const responseText = await response.text();
    assert.ok(!responseText.includes("secret-user"));
    assert.ok(!responseText.includes("secret-password"));
  });

  test("redacts an invalid create success payload", async () => {
    const invalidRun = {
      ...queuedRun,
      state: "secret-invalid-state",
    } as unknown as CreateRunValue["run"];
    const app = createHttpApp(
      makeDependencies({
        createRun: () =>
          Promise.resolve({
            ok: true,
            value: { replayed: false, run: invalidRun },
          }),
      })
    );
    const response = await app.request(createRequest());
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.ok(!(await response.text()).includes("secret-invalid-state"));
  });

  test("redacts an invalid recipe apply success payload", async () => {
    const invalidApply = {
      ...appliedRecipe,
      counts: { ...appliedRecipe.counts, total: 1 },
    } as unknown as ApplyRecipeValue;
    const app = createHttpApp(
      makeDependencies({
        applyRecipe: () => Promise.resolve({ ok: true, value: invalidApply }),
      })
    );
    const response = await app.request(applyRequest());
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.equal(
      (await response.text()).includes("application-synthetic"),
      false
    );
  });

  test("redacts an invalid capability discovery payload", async () => {
    const invalidCapabilities = {
      ...listedCapabilities,
      capabilities: [
        {
          capabilityId: "documents.secret",
          capabilityVersion: "secret-latest",
        },
      ],
    } as unknown as ListCapabilitiesValue;
    const app = createHttpApp(
      makeDependencies({
        listCapabilities: () =>
          Promise.resolve({ ok: true, value: invalidCapabilities }),
      })
    );
    const response = await app.request(capabilitiesRequest());
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.ok(!(await response.text()).includes("secret-latest"));
  });

  test("redacts an invalid quote success payload", async () => {
    const invalidPlan = {
      ...quotedPlan,
      quote: {
        ...quotedPlan.quote,
        pricingVersion: "secret-invalid-pricing-version",
        upperBound: -1,
      },
    } as unknown as QuoteRunPlanValue["plan"];
    const app = createHttpApp(
      makeDependencies({
        quoteRunPlan: () =>
          Promise.resolve({ ok: true, value: { plan: invalidPlan } }),
      })
    );
    const response = await app.request(quoteRequest());
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.ok(!(await response.text()).includes("secret-invalid-pricing"));
  });

  test("redacts an invalid get success payload", async () => {
    const invalidSnapshot = {
      cost: { reserved: -1, spent: 2, unit: "secret-invalid-unit" },
      run: queuedRun,
    } as unknown as GetRunValue;
    const app = createHttpApp(
      makeDependencies({
        getRun: () => Promise.resolve({ ok: true, value: invalidSnapshot }),
      })
    );
    const response = await app.request("/v1/runs/run-synthetic", {
      headers: { authorization: AUTHORIZATION },
    });
    await assertProblem(response.clone(), 500, "output-contract-violation");
    assert.ok(!(await response.text()).includes("secret-invalid-unit"));
  });
});
