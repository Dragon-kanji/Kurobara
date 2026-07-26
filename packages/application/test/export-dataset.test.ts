import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  type Record as DomainRecord,
  datasetId,
  datasetMaterializationId,
  type Field,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactDatasetExportAuthorization,
  ContactDatasetExportPrivacySourcePort,
  ContactPrivacyGuardPort,
  DatasetCodecPort,
  DatasetEncodeInput,
  DatasetImportBatch,
  DatasetImportCompletion,
  DatasetImportDefinition,
  DatasetImportIssue,
  DatasetImportMutationResult,
  DatasetPersistencePort,
  ExportDelivery,
  StoredDataset,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  createContactExportPolicyResolver,
  makeExportDataset,
} from "../src/index.ts";

const CONTACT_PRIVACY_INTERRUPTED_PATTERN =
  /Contact privacy restrictions interrupted/u;
const DATASET_EXPORT_IDEMPOTENCY_KEY_PATTERN = /^dataset-export:[0-9a-f]{64}$/u;

const workspace = workspaceId("workspace-dataset-export");
const actor = {
  actorId: actorId("actor-dataset-export"),
  authenticationMode: "api-key",
  credentialId: "credential-dataset-export",
  permissions: ["datasets:export"],
  workspaceId: workspace,
} as const;
const dataset = {
  datasetId: datasetId("dataset-export"),
  name: "Synthetic organizations",
  workspaceId: workspace,
} as const;
const fields = [
  {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-domain"),
    key: "organization_domain",
    label: "Domain",
    valueType: "string",
    workspaceId: workspace,
  },
  {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-score"),
    key: "observed_at_ms",
    label: "Score",
    valueType: "number",
    workspaceId: workspace,
  },
] as const satisfies readonly Field[];
const records = [
  {
    datasetId: dataset.datasetId,
    recordId: recordId("record-1"),
    values: [
      { fieldId: fields[0].fieldId, value: "one.invalid" },
      { fieldId: fields[1].fieldId, value: 1 },
    ],
    workspaceId: workspace,
  },
  {
    datasetId: dataset.datasetId,
    recordId: recordId("record-2"),
    values: [
      { fieldId: fields[0].fieldId, value: "two.invalid" },
      { fieldId: fields[1].fieldId, value: null },
    ],
    workspaceId: workspace,
  },
] as const satisfies readonly DomainRecord[];

const stored: StoredDataset = {
  dataset,
  fields,
  import: {
    batchCount: 1,
    datasetId: dataset.datasetId,
    errorCount: 0,
    importId: "import-export",
    itemCount: 2,
    recordCount: 2,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt: instant(2),
    completionReason: "source-exhausted",
    contentHash: contentHash(`sha256:${"a".repeat(64)}`),
    coverage: {
      basis: "imported_source",
      status: "complete_for_declared_source",
    },
    createdAt: instant(1),
    datasetId: dataset.datasetId,
    materializationId: datasetMaterializationId(dataset.datasetId),
    origin: { importId: "import-export", kind: "import" },
    recordCount: 2,
    rejectedCount: 0,
    revision: 2,
    schemaHash: contentHash(`sha256:${"b".repeat(64)}`),
    state: "ready",
    workspaceId: workspace,
  },
};

const emptyAsyncIterable = <Value>(): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

class FakeDatasetPersistence implements DatasetPersistencePort {
  complete = true;
  getCalls = 0;
  materializationState: StoredDataset["materialization"]["state"] = "ready";
  recordPulls = 0;
  storedDataset: StoredDataset = stored;
  storedRecords: readonly DomainRecord[] = records;
  visible = true;

  appendImportBatch(
    _scope: WorkspaceScope,
    _importId: string,
    _batch: DatasetImportBatch
  ): Promise<DatasetImportMutationResult> {
    return Promise.resolve({
      conflict: "import-state-conflict",
      status: "conflict",
    });
  }

  beginImport(
    _scope: WorkspaceScope,
    _definition: DatasetImportDefinition
  ): Promise<DatasetImportMutationResult> {
    return Promise.resolve({
      conflict: "import-state-conflict",
      status: "conflict",
    });
  }

  finishImport(
    _scope: WorkspaceScope,
    _importId: string,
    _completion: DatasetImportCompletion
  ): Promise<DatasetImportMutationResult> {
    return Promise.resolve({
      conflict: "import-state-conflict",
      status: "conflict",
    });
  }

  getDataset(): Promise<StoredDataset | undefined> {
    this.getCalls += 1;
    return Promise.resolve(
      this.visible
        ? {
            ...this.storedDataset,
            materialization: {
              ...this.storedDataset.materialization,
              state: this.materializationState,
            },
          }
        : undefined
    );
  }

  isFieldSetComplete(): Promise<boolean> {
    return Promise.resolve(this.complete);
  }

  resetImport(): Promise<DatasetImportMutationResult> {
    return Promise.resolve({
      conflict: "import-state-conflict",
      status: "conflict",
    });
  }

  streamImportIssues(): AsyncIterable<DatasetImportIssue> {
    return emptyAsyncIterable<DatasetImportIssue>();
  }

  async *streamRecords() {
    await Promise.resolve();
    for (const record of this.storedRecords) {
      this.recordPulls += 1;
      yield record;
    }
  }
}

class FakeContactExportPrivacySource
  implements ContactDatasetExportPrivacySourcePort
{
  authorization: ContactDatasetExportAuthorization | undefined;
  failure = false;
  private configuredSubjects:
    | ContactDatasetExportAuthorization["records"][number]["subjects"]
    | undefined;

  get subjects() {
    return this.configuredSubjects;
  }

  set subjects(subjects:
    | ContactDatasetExportAuthorization["records"][number]["subjects"]
    | undefined) {
    this.configuredSubjects = subjects;
    this.authorization =
      subjects === undefined
        ? undefined
        : {
            providerKeys:
              subjects.length === 0
                ? []
                : [
                    subjects.find(
                      (subject) => subject.kind === "provider-subject"
                    )?.providerKey ?? "synthetic-fixture",
                  ],
            records:
              subjects.length === 0
                ? []
                : records.map((record) => ({
                    observations: {
                      "contact-identity": instant(1000),
                      employment: instant(1000),
                      "professional-social-profile": instant(1000),
                    },
                    recordId: record.recordId,
                    subjects,
                  })),
            source: {
              capability: {
                capabilityId: "contacts.discover" as never,
                capabilityVersion: "1.0.0",
              },
              generationId: "generation-contact-export" as never,
              generationPlanId: "generation-plan-contact-export" as never,
              kind: "generated-dataset",
              planHash: contentHash(`sha256:${"c".repeat(64)}`),
            },
          };
  }

  loadAuthorization(): Promise<
    Awaited<
      ReturnType<ContactDatasetExportPrivacySourcePort["loadAuthorization"]>
    >
  > {
    if (this.failure) {
      return Promise.reject(new Error("synthetic privacy source failure"));
    }
    return Promise.resolve(this.authorization);
  }
}

class SequencedContactPrivacyGuard implements ContactPrivacyGuardPort {
  calls = 0;
  private readonly decisions: readonly boolean[];

  constructor(decisions: readonly boolean[]) {
    this.decisions = decisions;
  }

  allows(): Promise<boolean> {
    const decision = this.decisions[this.calls] ?? false;
    this.calls += 1;
    return Promise.resolve(decision);
  }
}

const passthroughContactDelivery: NonNullable<
  Parameters<typeof makeExportDataset>[0]["contactPrivacy"]["prepareDelivery"]
> = (request) => {
  if (!("source" in request.exported)) {
    throw new Error("Expected a generated Contact dataset export.");
  }
  const delivery: ExportDelivery = {
    deliveryId: "delivery-contact-export-test",
    intentHash: contentHash(`sha256:${"d".repeat(64)}`),
    manifest: {
      applicationId: null,
      contentHash: request.exported.contentHash,
      contentLength: request.exported.contentLength,
      dataClasses: request.privacy.facts.requestedData.map(
        ({ dataClass }) => dataClass
      ),
      datasetId: request.exported.dataset.datasetId,
      fieldIds: request.exported.fields.map((field) => field.fieldId),
      format: request.exported.format,
      manifestVersion: "2.0.0",
      observedExpiries: request.privacy.facts.requestedData.flatMap(
        ({ dataClass, observedAt }) =>
          observedAt === undefined
            ? []
            : [
                {
                  dataClass,
                  expiresAt: instant(observedAt + 10_000),
                  observedAt,
                },
              ]
      ),
      ownerActorId: request.actor.actorId,
      policyPurpose: {
        policyExpiresAt: request.privacy.policy.expiresAt,
        policyVersion: request.privacy.policy.version,
        purposeRef: request.privacy.facts.purposeRef ?? "synthetic-purpose",
        territory: request.privacy.facts.territory ?? "ES",
      },
      providerRights: request.providerRights,
      recipeId: null,
      recipeRevision: null,
      source: request.exported.source,
      workspaceId: request.actor.workspaceId,
    },
    preparedAt: instant(1500),
    state: "prepared",
  };
  return Promise.resolve({
    ok: true,
    value: { delivery, events: request.exported.events },
  });
};

const contactPrivacy = (
  subjects = new FakeContactExportPrivacySource(),
  guard: ContactPrivacyGuardPort = new SequencedContactPrivacyGuard([true])
) => ({
  clock: { now: () => Promise.resolve(instant(1500)) },
  guard,
  policy: createContactExportPolicyResolver({
    maxRetentionMilliseconds: {
      employment: 10_000,
    },
    policyTtlMilliseconds: 10_000,
    policyVersion: "operator-policy-test",
    providerRights: {
      "apollo-people-search": {
        mode: "synthetic-fixture",
        ttlMilliseconds: 10_000,
        version: "provider-rights-test",
      },
      "synthetic-fixture": {
        mode: "synthetic-fixture",
        ttlMilliseconds: 10_000,
        version: "provider-rights-test",
      },
    },
    purposeRef: "synthetic-purpose",
    territory: "ES",
  }),
  prepareDelivery: passthroughContactDelivery,
  requiredPermission: "contacts:export",
  subjects,
});

const observingCodec = (
  format: "csv" | "jsonl",
  observed: DatasetEncodeInput[]
): DatasetCodecPort => ({
  codecVersion: "1.0.0",
  decode: () => emptyAsyncIterable(),
  async *encode(input) {
    observed.push(input);
    for await (const record of input.records) {
      yield {
        bytes: new TextEncoder().encode(record.recordId),
        type: "chunk",
      };
    }
  },
  format,
});

test("preserves requested field order and relays record backpressure", async () => {
  const persistence = new FakeDatasetPersistence();
  const observed: DatasetEncodeInput[] = [];
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", observed),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });
  const result = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    fieldIds: [fields[1].fieldId, fields[0].fieldId],
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, true);
  assert.equal(persistence.recordPulls, 2);
  assert.deepEqual(
    result.ok ? result.value.fields.map((field) => field.fieldId) : [],
    [fields[1].fieldId, fields[0].fieldId]
  );
  if (result.ok) {
    for await (const event of result.value.events) {
      assert.equal(event.type, "chunk");
      break;
    }
  }
  assert.equal(persistence.recordPulls, 4);
  assert.deepEqual(
    observed[0]?.fields.map((field) => field.fieldId),
    [fields[1].fieldId, fields[0].fieldId]
  );
});

test("preflights sparse CSV before emitting a header", async () => {
  const persistence = new FakeDatasetPersistence();
  persistence.complete = false;
  const observed: DatasetEncodeInput[] = [];
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", observed),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });
  const result = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    format: "csv",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "sparse-csv-unsupported"
  );
  assert.equal(observed.length, 0);
  assert.equal(persistence.recordPulls, 0);
});

test("rejects a dataset whose materialization is not ready", async () => {
  const persistence = new FakeDatasetPersistence();
  persistence.materializationState = "building";
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "dataset-not-ready");
  assert.equal(persistence.recordPulls, 0);
});

test("derives dataset scope from the authenticated actor", async () => {
  const persistence = new FakeDatasetPersistence();
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });
  const result = await exportDataset({
    actor: {
      ...actor,
      workspaceId: workspaceId("workspace-other"),
    },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "dataset-not-found");
});

test("rejects missing authority and invalid field selection", async () => {
  const persistence = new FakeDatasetPersistence();
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });
  const denied = await exportDataset({
    actor: { ...actor, permissions: [] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });
  const duplicated = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    fieldIds: [fields[0].fieldId, fields[0].fieldId],
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(
    denied.ok ? undefined : denied.error.code,
    "authority-permission-missing"
  );
  assert.equal(
    duplicated.ok ? undefined : duplicated.error.code,
    "field-selection-invalid"
  );
});

test("rejects a miswired codec registry before dataset I/O", async () => {
  const persistence = new FakeDatasetPersistence();
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("csv", []),
    },
    contactPrivacy: contactPrivacy(),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "codec-configuration-invalid"
  );
  assert.equal(persistence.getCalls, 0);
});

test("requires explicit Contact export authority before privacy evaluation", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [
    {
      kind: "provider-subject",
      providerKey: "apollo-people-search",
      value: "person-synthetic",
    },
  ];
  const guard = new SequencedContactPrivacyGuard([true]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects, guard),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "authority-permission-missing"
  );
  assert.equal(guard.calls, 0);
  assert.equal(persistence.recordPulls, 0);
});

test("fails closed before encoding when Contact delivery policy is unavailable", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [
    {
      kind: "provider-subject",
      providerKey: "apollo-people-search",
      value: "person-synthetic",
    },
  ];
  const guard = new SequencedContactPrivacyGuard([true]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: {
      clock: { now: () => Promise.resolve(instant(1500)) },
      guard,
      requiredPermission: "contacts:export",
      subjects,
    },
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "contact-export-policy-unavailable"
  );
  assert.equal(guard.calls, 1);
  assert.equal(persistence.recordPulls, 0);
});

test("exports an empty Contact dataset without invoking the tombstone guard", async () => {
  const persistence = new FakeDatasetPersistence();
  persistence.storedRecords = [];
  persistence.storedDataset = {
    ...stored,
    materialization: { ...stored.materialization, recordCount: 0 },
  };
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [];
  const guard = new SequencedContactPrivacyGuard([]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects, guard),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const denied = await exportDataset({
    actor,
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });
  const allowed = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(
    denied.ok ? undefined : denied.error.code,
    "authority-permission-missing"
  );
  assert.equal(allowed.ok, true);
  if (allowed.ok) {
    for await (const _event of allowed.value.events) {
      assert.fail("An empty Contact dataset must not emit record chunks.");
    }
  }
  assert.equal(guard.calls, 0);
  assert.equal(persistence.recordPulls, 0);
});

test("blocks a tombstoned Contact dataset before constructing its stream", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [
    { kind: "email", value: "contact@example.invalid" },
    {
      kind: "provider-subject",
      providerKey: "apollo-people-search",
      value: "person-synthetic",
    },
  ];
  const guard = new SequencedContactPrivacyGuard([false]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects, guard),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "contact-privacy-restricted"
  );
  assert.equal(guard.calls, 1);
  assert.equal(persistence.recordPulls, 0);
});

test("revalidates Contact privacy immediately before the first export chunk", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [
    {
      kind: "provider-subject",
      providerKey: "apollo-people-search",
      value: "person-synthetic",
    },
  ];
  const guard = new SequencedContactPrivacyGuard([
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects, guard),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    await assert.rejects(async () => {
      for await (const _event of result.value.events) {
        // The JIT privacy check must fail before the application releases bytes.
      }
    }, CONTACT_PRIVACY_INTERRUPTED_PATTERN);
  }
  assert.equal(guard.calls, 7);
  assert.equal(persistence.recordPulls, 2);
});

test("stops a Contact export when privacy changes between chunks", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.subjects = [
    {
      kind: "provider-subject",
      providerKey: "apollo-people-search",
      value: "person-synthetic",
    },
  ];
  const guard = new SequencedContactPrivacyGuard([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects, guard),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    const iterator = result.value.events[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    await assert.rejects(iterator.next(), CONTACT_PRIVACY_INTERRUPTED_PATTERN);
  }
  assert.equal(guard.calls, 11);
  assert.equal(persistence.recordPulls, 4);
});

test("fails closed when restricted Contact lineage cannot be read", async () => {
  const persistence = new FakeDatasetPersistence();
  const subjects = new FakeContactExportPrivacySource();
  subjects.failure = true;
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: contactPrivacy(subjects),
    datasets: persistence,
    requiredPermission: "datasets:export",
  });

  const result = await exportDataset({
    actor: { ...actor, permissions: ["datasets:export", "contacts:export"] },
    datasetId: dataset.datasetId,
    format: "jsonl",
    maxRecordBytes: 4096,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "contact-privacy-check-failed"
  );
  assert.equal(persistence.recordPulls, 0);
});

test("binds Contact delivery idempotency to the exact expiring policy snapshot", async () => {
  const persistence = new FakeDatasetPersistence();
  const contactFields = [
    {
      datasetId: dataset.datasetId,
      fieldId: fieldId("field-display-name"),
      key: "display_name",
      label: "Display name",
      valueType: "string",
      workspaceId: workspace,
    },
    {
      datasetId: dataset.datasetId,
      fieldId: fieldId("field-job-title"),
      key: "job_title",
      label: "Job title",
      valueType: "string",
      workspaceId: workspace,
    },
  ] as const satisfies readonly Field[];
  persistence.storedDataset = {
    ...stored,
    fields: contactFields,
    materialization: { ...stored.materialization, recordCount: 1 },
  };
  persistence.storedRecords = [
    {
      datasetId: dataset.datasetId,
      recordId: recordId("contact-record-1"),
      values: [
        { fieldId: contactFields[0].fieldId, value: "Synthetic Contact" },
        { fieldId: contactFields[1].fieldId, value: "Director" },
      ],
      workspaceId: workspace,
    },
  ];
  const privacySource = new FakeContactExportPrivacySource();
  privacySource.authorization = {
    providerKeys: ["prospeo"],
    records: [
      {
        observations: {
          "contact-identity": instant(1000),
          employment: instant(1000),
        },
        recordId: recordId("contact-record-1"),
        subjects: [
          {
            kind: "provider-subject",
            providerKey: "prospeo",
            value: "synthetic-contact-1",
          },
        ],
      },
    ],
    source: {
      capability: {
        capabilityId: "contacts.discover" as never,
        capabilityVersion: "1.0.0",
      },
      generationId: "generation-contact-export" as never,
      generationPlanId: "generation-plan-contact-export" as never,
      kind: "generated-dataset",
      planHash: contentHash(`sha256:${"c".repeat(64)}`),
    },
  };
  const requests: Parameters<
    NonNullable<
      Parameters<
        typeof makeExportDataset
      >[0]["contactPrivacy"]["prepareDelivery"]
    >
  >[0][] = [];
  let now = 1500;
  const prepareDelivery = (
    request: (typeof requests)[number]
  ): Promise<
    Awaited<
      ReturnType<
        NonNullable<
          Parameters<
            typeof makeExportDataset
          >[0]["contactPrivacy"]["prepareDelivery"]
        >
      >
    >
  > => {
    requests.push(request);
    if (!("source" in request.exported)) {
      throw new Error("Expected a generated Contact dataset export.");
    }
    const delivery: ExportDelivery = {
      deliveryId: `delivery-${requests.length}`,
      intentHash: contentHash(`sha256:${"d".repeat(64)}`),
      manifest: {
        applicationId: null,
        contentHash: request.exported.contentHash,
        contentLength: request.exported.contentLength,
        dataClasses: request.privacy.facts.requestedData.map(
          ({ dataClass }) => dataClass
        ),
        datasetId: request.exported.dataset.datasetId,
        fieldIds: request.exported.fields.map((field) => field.fieldId),
        format: request.exported.format,
        manifestVersion: "2.0.0",
        observedExpiries: request.privacy.facts.requestedData.flatMap(
          ({ dataClass, observedAt }) =>
            observedAt === undefined
              ? []
              : [
                  {
                    dataClass,
                    expiresAt: instant(observedAt + 10_000),
                    observedAt,
                  },
                ]
        ),
        ownerActorId: request.actor.actorId,
        policyPurpose: {
          policyExpiresAt: request.privacy.policy.expiresAt,
          policyVersion: request.privacy.policy.version,
          purposeRef: request.privacy.facts.purposeRef ?? "synthetic-purpose",
          territory: request.privacy.facts.territory ?? "ES",
        },
        providerRights: request.providerRights,
        recipeId: null,
        recipeRevision: null,
        source: request.exported.source,
        workspaceId: request.actor.workspaceId,
      },
      preparedAt: instant(now),
      state: "prepared",
    };
    return Promise.resolve({
      ok: true,
      value: { delivery, events: request.exported.events },
    });
  };
  const exportDataset = makeExportDataset({
    codecs: {
      csv: observingCodec("csv", []),
      jsonl: observingCodec("jsonl", []),
    },
    contactPrivacy: {
      clock: { now: () => Promise.resolve(instant(now)) },
      guard: new SequencedContactPrivacyGuard(
        Array.from({ length: 20 }, () => true)
      ),
      policy: createContactExportPolicyResolver({
        maxRetentionMilliseconds: {
          "contact-identity": 10_000,
          employment: 10_000,
        },
        policyTtlMilliseconds: 2000,
        policyVersion: "operator-policy-v1",
        providerRights: {
          prospeo: {
            mode: "synthetic-fixture",
            ttlMilliseconds: 1000,
            version: "provider-rights-v1",
          },
        },
        purposeRef: "synthetic-purpose",
        territory: "ES",
      }),
      prepareDelivery,
      requiredPermission: "contacts:export",
      subjects: privacySource,
    },
    datasets: persistence,
    requiredPermission: "datasets:export",
  });
  const request = {
    actor: {
      ...actor,
      permissions: ["contacts:export", "datasets:export"],
    },
    datasetId: dataset.datasetId,
    format: "jsonl" as const,
    maxRecordBytes: 4096,
  };

  const first = await exportDataset(request);
  now = 1600;
  const second = await exportDataset(request);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.idempotencyKey, requests[1]?.idempotencyKey);
  assert.match(
    requests[0]?.idempotencyKey ?? "",
    DATASET_EXPORT_IDEMPOTENCY_KEY_PATTERN
  );
  assert.equal(
    (requests[0]?.idempotencyKey ?? "").includes("synthetic-contact-1"),
    false
  );
});
