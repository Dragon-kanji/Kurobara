import { createHash } from "node:crypto";
import type {
  CapabilityRef,
  ContentHash,
  DatasetGenerationId,
  DatasetGenerationLimits,
  DatasetGenerationPageArtifact,
  DatasetGenerationPlanId,
  DatasetGenerationQueryValue,
  DatasetId,
  Record as DatasetRecord,
  Field,
  WorkspaceId,
} from "@kurobara/kernel";
import {
  contentHash,
  createRecord,
  DATASET_GENERATION_LIMIT_NAMES,
  isAmount,
  snapshotDatasetGenerationQuery,
  usageEntryId,
  validateDatasetFields,
} from "@kurobara/kernel";
import type {
  LeafEffectFinalOutcome,
  LeafEffectPort,
  LeafEffectRequest,
  NormalizedJsonValue,
} from "@kurobara/ports";

export type DeterministicLeafEffectHistory = Readonly<{
  executions: readonly LeafEffectRequest[];
  lookups: readonly LeafEffectRequest[];
}>;

export type DeterministicLeafEffect = Readonly<{
  history(): DeterministicLeafEffectHistory;
  port: LeafEffectPort;
}>;

export type DeterministicDatasetGenerationPageInput = Readonly<{
  capability: CapabilityRef;
  datasetId: DatasetId;
  fields: readonly Field[];
  generationId: DatasetGenerationId;
  generationPlanId: DatasetGenerationPlanId;
  inputCursor: null;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationLimits;
  normalizedQuery: DatasetGenerationQueryValue;
  pageSequence: 1;
  planHash: ContentHash;
  queryHash: ContentHash;
  schemaHash: ContentHash;
  version: "1.0.0";
  workspaceId: WorkspaceId;
}>;

export type DeterministicDatasetGenerationPageConfiguration =
  | Readonly<{ kind: "empty-certain" }>
  | Readonly<{
      hasMore: boolean;
      kind: "records";
      nextCursor: null | string;
      records: readonly DatasetRecord[];
      sourcePartitionCompleted: boolean;
    }>;

export type DeterministicDatasetGenerationPageEffectConfiguration = Readonly<{
  expectedInput: DeterministicDatasetGenerationPageInput;
  page: DeterministicDatasetGenerationPageConfiguration;
  settlementAmount?: number;
}>;

export type DeterministicDatasetGenerationPageEffect = Readonly<{
  history(): DeterministicLeafEffectHistory;
  port: LeafEffectPort;
}>;

const INPUT_KEYS = [
  "version",
  "kind",
  "workspaceId",
  "generationId",
  "generationPlanId",
  "datasetId",
  "pageSequence",
  "inputCursor",
  "planHash",
  "queryHash",
  "schemaHash",
  "capability",
  "normalizedQuery",
  "fields",
  "limits",
] as const;

const FIELD_KEYS = [
  "datasetId",
  "fieldId",
  "key",
  "label",
  "valueType",
  "workspaceId",
] as const;

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const isPlainRecord = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError(
        "The deterministic fixture accepts JSON values only."
      );
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
};

const capabilityIsValid = (value: unknown, expected: CapabilityRef): boolean =>
  isPlainRecord(value) &&
  hasExactKeys(value, ["capabilityId", "capabilityVersion"]) &&
  value.capabilityId === expected.capabilityId &&
  value.capabilityVersion === expected.capabilityVersion;

const limitsAreValid = (
  value: unknown,
  expected: DatasetGenerationLimits
): boolean =>
  isPlainRecord(value) &&
  hasExactKeys(value, DATASET_GENERATION_LIMIT_NAMES) &&
  DATASET_GENERATION_LIMIT_NAMES.every(
    (name) =>
      Number.isSafeInteger(value[name]) &&
      typeof value[name] === "number" &&
      value[name] >= 0 &&
      value[name] === expected[name]
  );

const fieldsAreValid = (
  value: unknown,
  expected: readonly Field[],
  datasetId: DatasetId,
  workspaceId: WorkspaceId
): boolean => {
  if (
    !Array.isArray(value) ||
    value.some(
      (field) =>
        !(isPlainRecord(field) && hasExactKeys(field, FIELD_KEYS)) ||
        field.datasetId !== datasetId ||
        field.workspaceId !== workspaceId
    )
  ) {
    return false;
  }
  const dataset = {
    datasetId,
    name: "Deterministic dataset generation fixture",
    workspaceId,
  };
  return (
    validateDatasetFields(dataset, value as unknown as readonly Field[]).ok &&
    canonicalize(value) === canonicalize(expected)
  );
};

const inputIsValid = (
  value: unknown,
  expected: DeterministicDatasetGenerationPageInput
): value is DeterministicDatasetGenerationPageInput => {
  if (!(isPlainRecord(value) && hasExactKeys(value, INPUT_KEYS))) {
    return false;
  }
  const query = snapshotDatasetGenerationQuery(value.normalizedQuery);
  return (
    value.version === "1.0.0" &&
    value.kind === "dataset-generation-page-input" &&
    value.workspaceId === expected.workspaceId &&
    value.generationId === expected.generationId &&
    value.generationPlanId === expected.generationPlanId &&
    value.datasetId === expected.datasetId &&
    value.pageSequence === 1 &&
    value.pageSequence === expected.pageSequence &&
    value.inputCursor === null &&
    value.planHash === expected.planHash &&
    value.queryHash === expected.queryHash &&
    value.schemaHash === expected.schemaHash &&
    typeof value.planHash === "string" &&
    CONTENT_HASH_PATTERN.test(value.planHash) &&
    typeof value.queryHash === "string" &&
    CONTENT_HASH_PATTERN.test(value.queryHash) &&
    typeof value.schemaHash === "string" &&
    CONTENT_HASH_PATTERN.test(value.schemaHash) &&
    capabilityIsValid(value.capability, expected.capability) &&
    query.ok &&
    canonicalize(query.value) === canonicalize(expected.normalizedQuery) &&
    fieldsAreValid(
      value.fields,
      expected.fields,
      expected.datasetId,
      expected.workspaceId
    ) &&
    limitsAreValid(value.limits, expected.limits) &&
    canonicalize(value) === canonicalize(expected)
  );
};

const canonicalContentHash = (value: unknown): ContentHash =>
  contentHash(
    `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`
  );

const recordContentHash = (record: DatasetRecord): ContentHash =>
  canonicalContentHash(record);

const snapshotRecord = (record: DatasetRecord): DatasetRecord =>
  Object.freeze({
    datasetId: record.datasetId,
    recordId: record.recordId,
    values: Object.freeze(
      record.values.map((value) => Object.freeze({ ...value }))
    ),
    workspaceId: record.workspaceId,
  });

const buildPageArtifact = (
  configuration: DeterministicDatasetGenerationPageEffectConfiguration
): DatasetGenerationPageArtifact => {
  if (configuration.page.kind === "empty-certain") {
    return Object.freeze({
      hasMore: false,
      items: Object.freeze([]),
      nextCursor: null,
      sourcePartitionCompleted: true,
      version: "1.0.0",
    });
  }
  return Object.freeze({
    hasMore: configuration.page.hasMore,
    items: Object.freeze(
      configuration.page.records.map((record) => {
        const snapshot = snapshotRecord(record);
        return Object.freeze({
          contentHash: recordContentHash(snapshot),
          record: snapshot,
        });
      })
    ),
    nextCursor: configuration.page.nextCursor,
    sourcePartitionCompleted: configuration.page.sourcePartitionCompleted,
    version: "1.0.0",
  });
};

const validatePageConfiguration = (
  configuration: DeterministicDatasetGenerationPageEffectConfiguration
): void => {
  if (!inputIsValid(configuration.expectedInput, configuration.expectedInput)) {
    throw new RangeError(
      "The deterministic generation effect requires a valid exact expected input."
    );
  }
  if (
    configuration.settlementAmount !== undefined &&
    !isAmount(configuration.settlementAmount)
  ) {
    throw new RangeError(
      "The deterministic generation effect requires a valid settlement amount."
    );
  }
  if (configuration.page.kind === "empty-certain") {
    return;
  }
  const cursorIsValid = configuration.page.hasMore
    ? typeof configuration.page.nextCursor === "string" &&
      configuration.page.nextCursor.trim().length > 0 &&
      !configuration.page.sourcePartitionCompleted
    : configuration.page.nextCursor === null &&
      configuration.page.sourcePartitionCompleted;
  if (configuration.page.records.length === 0 || !cursorIsValid) {
    throw new RangeError(
      "A deterministic records page must be non-empty and have a coherent cursor."
    );
  }
  const dataset = {
    datasetId: configuration.expectedInput.datasetId,
    name: "Deterministic dataset generation fixture",
    workspaceId: configuration.expectedInput.workspaceId,
  };
  const recordsAreValid = configuration.page.records.every(
    (record) =>
      createRecord(dataset, configuration.expectedInput.fields, record).ok
  );
  const recordIds = new Set(
    configuration.page.records.map((record) => record.recordId)
  );
  if (
    !recordsAreValid ||
    recordIds.size !== configuration.page.records.length
  ) {
    throw new RangeError(
      "Every deterministic page record must be unique and match the expected dataset schema and scope."
    );
  }
};

const cloneRequest = (request: LeafEffectRequest): LeafEffectRequest =>
  Object.freeze({
    ...request,
    ...(request.runInput === undefined
      ? {}
      : {
          runInput: Object.freeze({
            ...request.runInput,
            value: structuredClone(request.runInput.value),
          }),
        }),
  });

const validateRequest = (request: LeafEffectRequest): void => {
  if (
    request.reservationUnit.trim().length === 0 ||
    !isAmount(request.reservedAmount)
  ) {
    throw new RangeError(
      "The deterministic effect requires a valid reserved amount and unit."
    );
  }
};

const defaultOutputFor = (request: LeafEffectRequest): NormalizedJsonValue => ({
  adapter: "deterministic-local",
  attempt_id: request.attemptId,
  operation_key: request.operationKey,
  run_id: request.runId,
  status: "succeeded",
  step_run_id: request.stepRunId,
});

const resultFor = (
  request: LeafEffectRequest,
  outputFor: (
    request: LeafEffectRequest
  ) => NormalizedJsonValue | undefined = () => undefined
) => ({
  output: outputFor(request) ?? defaultOutputFor(request),
  settlement: {
    amount: 0,
    kind: "settle" as const,
    unit: request.reservationUnit,
    usageEntryId: usageEntryId(`usage:deterministic:${request.attemptId}`),
  },
  status: "succeeded" as const,
});

export const createDeterministicLeafEffect = (
  options: Readonly<{
    outputFor?: (request: LeafEffectRequest) => NormalizedJsonValue | undefined;
  }> = {}
): DeterministicLeafEffect => {
  const executions: LeafEffectRequest[] = [];
  const lookups: LeafEffectRequest[] = [];
  const executedAttempts = new Set<string>();
  return Object.freeze({
    history: () =>
      Object.freeze({
        executions: Object.freeze(executions.map(cloneRequest)),
        lookups: Object.freeze(lookups.map(cloneRequest)),
      }),
    port: {
      adapterKey: "deterministic-local",
      execute: (request) =>
        Promise.resolve().then(() => {
          validateRequest(request);
          executions.push(cloneRequest(request));
          executedAttempts.add(request.attemptId);
          return resultFor(request, options.outputFor);
        }),
      lookup: (request) =>
        Promise.resolve().then(() => {
          validateRequest(request);
          lookups.push(cloneRequest(request));
          const proofId = `deterministic:${request.attemptId}`;
          return executedAttempts.has(request.attemptId)
            ? {
                outcome: resultFor(request, options.outputFor),
                proofId,
                status: "found" as const,
              }
            : { proofId, status: "not-found" as const };
        }),
    },
  });
};

const validateDatasetGenerationPageRequest = (
  request: LeafEffectRequest,
  configuration: DeterministicDatasetGenerationPageEffectConfiguration
): void => {
  validateRequest(request);
  const runInput = request.runInput;
  if (
    runInput === undefined ||
    request.workspaceId !== configuration.expectedInput.workspaceId ||
    runInput.classification !== "internal" ||
    runInput.mediaType !== "application/json" ||
    runInput.inputId.trim().length === 0 ||
    runInput.validatorVersion.trim().length === 0 ||
    !CONTENT_HASH_PATTERN.test(runInput.contentHash) ||
    runInput.contentHash !== canonicalContentHash(runInput.value) ||
    !Number.isSafeInteger(runInput.sizeBytes) ||
    runInput.sizeBytes !==
      Buffer.byteLength(canonicalize(runInput.value), "utf8") ||
    !Number.isSafeInteger(runInput.finalizedAt) ||
    !Number.isSafeInteger(runInput.validatedAt) ||
    !inputIsValid(runInput.value, configuration.expectedInput)
  ) {
    throw new RangeError(
      "The deterministic generation effect requires its exact validated generation page input."
    );
  }
  const settlementAmount = configuration.settlementAmount ?? 0;
  if (settlementAmount > request.reservedAmount) {
    throw new RangeError(
      "The deterministic generation settlement cannot exceed the reservation."
    );
  }
};

const pageResultFor = (
  request: LeafEffectRequest,
  artifact: DatasetGenerationPageArtifact,
  settlementAmount: number
): LeafEffectFinalOutcome =>
  Object.freeze({
    output: artifact,
    settlement: Object.freeze({
      amount: settlementAmount,
      kind: "settle" as const,
      unit: request.reservationUnit,
      usageEntryId: usageEntryId(
        `usage:deterministic-dataset-generation-page:${request.attemptId}`
      ),
    }),
    status: "succeeded" as const,
  });

type StoredPageExecution = Readonly<{
  fingerprint: string;
  outcome: LeafEffectFinalOutcome;
}>;

/**
 * Dedicated zero-network fixture for the internal first dataset-generation
 * page contract. It deliberately does not alter the generic deterministic
 * leaf effect above.
 */
export const createDeterministicDatasetGenerationPageEffect = (
  configuration: DeterministicDatasetGenerationPageEffectConfiguration
): DeterministicDatasetGenerationPageEffect => {
  validatePageConfiguration(configuration);
  const artifact = buildPageArtifact(configuration);
  const settlementAmount = configuration.settlementAmount ?? 0;
  const executions: LeafEffectRequest[] = [];
  const lookups: LeafEffectRequest[] = [];
  const executedAttempts = new Map<string, StoredPageExecution>();

  const validateStoredRequest = (
    request: LeafEffectRequest
  ): StoredPageExecution | undefined => {
    const stored = executedAttempts.get(request.attemptId);
    if (stored !== undefined && stored.fingerprint !== canonicalize(request)) {
      throw new RangeError(
        "A deterministic generation attempt cannot be replayed with divergent identities."
      );
    }
    return stored;
  };

  return Object.freeze({
    history: () =>
      Object.freeze({
        executions: Object.freeze(executions.map(cloneRequest)),
        lookups: Object.freeze(lookups.map(cloneRequest)),
      }),
    port: {
      adapterKey: "deterministic-dataset-generation-page",
      execute: (request) =>
        Promise.resolve().then(() => {
          validateDatasetGenerationPageRequest(request, configuration);
          executions.push(cloneRequest(request));
          const stored = validateStoredRequest(request);
          if (stored !== undefined) {
            return stored.outcome;
          }
          const outcome = pageResultFor(request, artifact, settlementAmount);
          executedAttempts.set(
            request.attemptId,
            Object.freeze({
              fingerprint: canonicalize(request),
              outcome,
            })
          );
          return outcome;
        }),
      lookup: (request) =>
        Promise.resolve().then(() => {
          validateDatasetGenerationPageRequest(request, configuration);
          lookups.push(cloneRequest(request));
          const stored = validateStoredRequest(request);
          const proofId = `deterministic-dataset-generation-page:${request.attemptId}`;
          return stored === undefined
            ? { proofId, status: "not-found" as const }
            : {
                outcome: stored.outcome,
                proofId,
                status: "found" as const,
              };
        }),
    },
  });
};
