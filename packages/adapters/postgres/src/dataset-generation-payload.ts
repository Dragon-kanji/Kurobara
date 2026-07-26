import {
  capabilityId,
  contentHash,
  createDatasetMaterialization,
  type DatasetGeneration,
  type DatasetGenerationCreation,
  type DatasetGenerationPlan,
  type DatasetMaterialization,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  datasetMaterializationId,
  instant,
  validateDatasetGenerationSnapshot,
  workspaceId,
} from "@kurobara/kernel";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;

export type DatasetGenerationRowIdentity = Readonly<{
  acceptedCount: string;
  aggregateVersion: string;
  callCount: string;
  capabilityId: string;
  capabilityVersion: string;
  costReserved: string;
  costSpent: string;
  costUnit: string;
  createdAt: Date;
  datasetId: string;
  duplicateCount: string;
  generationId: string;
  generationPlanId: string;
  lastPageSequence: string | null;
  lockedProvider: string | null;
  materializationId: string;
  pageCount: string;
  planHash: string;
  queryHash: string;
  rejectedCount: string;
  requestIntentHash: string;
  returnedCount: string;
  schemaHash: string;
  state: string;
  stopReason: string | null;
  stopRequestedAt: Date | null;
  workspaceId: string;
}>;

export type DatasetMaterializationRowIdentity = Readonly<{
  completedAt: Date | null;
  completionReason: string | null;
  contentHash: string | null;
  coverageBasis: string | null;
  coverageStatus: string | null;
  createdAt: Date;
  datasetId: string;
  materializationId: string;
  originId: string;
  originKind: string;
  recordCount: string;
  rejectedCount: string;
  revision: string;
  schemaHash: string;
  state: string;
  workspaceId: string;
}>;

const asRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!(prototype === Object.prototype || prototype === null)) {
    throw new DatabasePayloadError(`${path} must be a plain JSON object.`);
  }
  return value as JsonRecord;
};

const assertOnlyKeys = (
  value: JsonRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (missing !== undefined || extra !== undefined) {
    throw new DatabasePayloadError(
      `${path} does not have its exact canonical field set.`
    );
  }
};

const asString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const asIdentity = (value: unknown, path: string, maximum = 255): string => {
  const parsed = asString(value, path);
  if (parsed.trim() !== parsed || [...parsed].length > maximum) {
    throw new DatabasePayloadError(`${path} must be a bounded identity.`);
  }
  return parsed;
};

const asBoundedText = (value: unknown, path: string, maximum = 255): string => {
  const parsed = asString(value, path);
  if ([...parsed].length > maximum) {
    throw new DatabasePayloadError(`${path} must be bounded text.`);
  }
  return parsed;
};

const asNonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return value as number;
};

const asPositiveInteger = (value: unknown, path: string): number => {
  const parsed = asNonNegativeInteger(value, path);
  if (parsed === 0) {
    throw new DatabasePayloadError(`${path} must be positive.`);
  }
  return parsed;
};

const asNonNegativeNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DatabasePayloadError(`${path} must be non-negative and finite.`);
  }
  return value;
};

const asDatabaseInteger = (value: string, path: string): number => {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new DatabasePayloadError(`${path} is not an unsigned integer.`);
  }
  return asNonNegativeInteger(Number(value), path);
};

const asDatabaseNumber = (value: string, path: string): number => {
  const parsed = Number(value);
  return asNonNegativeNumber(parsed, path);
};

const parseHash = (value: unknown, path: string) => {
  try {
    return contentHash(asString(value, path));
  } catch {
    throw new DatabasePayloadError(`${path} must be a SHA-256 content hash.`);
  }
};

const parseInstant = (value: unknown, path: string) => {
  try {
    return instant(asNonNegativeInteger(value, path));
  } catch {
    throw new DatabasePayloadError(
      `${path} must be an epoch millisecond instant.`
    );
  }
};

const sameOptional = <Value>(left: Value | undefined, right: Value | null) =>
  left === (right ?? undefined);

export const parseDatasetMaterializationPayload = (
  value: unknown,
  identity?: DatasetMaterializationRowIdentity
): DatasetMaterialization => {
  const item = asRecord(value, "dataset materialization");
  assertOnlyKeys(
    item,
    "dataset materialization",
    [
      "createdAt",
      "datasetId",
      "materializationId",
      "origin",
      "recordCount",
      "rejectedCount",
      "revision",
      "schemaHash",
      "state",
      "workspaceId",
    ],
    ["completedAt", "completionReason", "contentHash", "coverage"]
  );
  const originItem = asRecord(item.origin, "dataset materialization.origin");
  const originKind = asString(
    originItem.kind,
    "dataset materialization.origin.kind"
  );
  const origin = (() => {
    if (originKind === "import") {
      assertOnlyKeys(originItem, "dataset materialization.origin", [
        "importId",
        "kind",
      ]);
      return {
        importId: asBoundedText(
          originItem.importId,
          "dataset materialization.origin.importId"
        ),
        kind: "import" as const,
      };
    }
    if (originKind === "generation") {
      assertOnlyKeys(originItem, "dataset materialization.origin", [
        "generationId",
        "kind",
      ]);
      return {
        generationId: datasetGenerationId(
          asIdentity(
            originItem.generationId,
            "dataset materialization.origin.generationId"
          )
        ),
        kind: "generation" as const,
      };
    }
    throw new DatabasePayloadError(
      "dataset materialization.origin.kind is invalid."
    );
  })();
  const state = asString(item.state, "dataset materialization.state");
  if (
    state !== "building" &&
    state !== "ready" &&
    state !== "failed" &&
    state !== "cancelled" &&
    state !== "ambiguous"
  ) {
    throw new DatabasePayloadError("dataset materialization.state is invalid.");
  }
  const coverage = ((): DatasetMaterialization["coverage"] => {
    if (item.coverage === undefined) {
      return;
    }
    const coverageItem = asRecord(
      item.coverage,
      "dataset materialization.coverage"
    );
    assertOnlyKeys(coverageItem, "dataset materialization.coverage", [
      "basis",
      "status",
    ]);
    const basis = asString(
      coverageItem.basis,
      "dataset materialization.coverage.basis"
    );
    const status = asString(
      coverageItem.status,
      "dataset materialization.coverage.status"
    );
    if (basis !== "imported_source" && basis !== "locked_provider_route") {
      throw new DatabasePayloadError(
        "dataset materialization.coverage.basis is invalid."
      );
    }
    if (
      status !== "complete_for_declared_source" &&
      status !== "bounded" &&
      status !== "unknown"
    ) {
      throw new DatabasePayloadError(
        "dataset materialization.coverage.status is invalid."
      );
    }
    return { basis, status };
  })();
  let parsed: DatasetMaterialization;
  try {
    parsed = {
      ...(item.completedAt === undefined
        ? {}
        : {
            completedAt: parseInstant(
              item.completedAt,
              "dataset materialization.completedAt"
            ),
          }),
      ...(item.completionReason === undefined
        ? {}
        : {
            completionReason: asBoundedText(
              item.completionReason,
              "dataset materialization.completionReason",
              128
            ),
          }),
      ...(item.contentHash === undefined
        ? {}
        : {
            contentHash: parseHash(
              item.contentHash,
              "dataset materialization.contentHash"
            ),
          }),
      ...(coverage === undefined ? {} : { coverage }),
      createdAt: parseInstant(
        item.createdAt,
        "dataset materialization.createdAt"
      ),
      datasetId: datasetId(
        asBoundedText(item.datasetId, "dataset materialization.datasetId")
      ),
      materializationId: datasetMaterializationId(
        asBoundedText(
          item.materializationId,
          "dataset materialization.materializationId"
        )
      ),
      origin,
      recordCount: asNonNegativeInteger(
        item.recordCount,
        "dataset materialization.recordCount"
      ),
      rejectedCount: asNonNegativeInteger(
        item.rejectedCount,
        "dataset materialization.rejectedCount"
      ),
      revision: asPositiveInteger(
        item.revision,
        "dataset materialization.revision"
      ),
      schemaHash: parseHash(
        item.schemaHash,
        "dataset materialization.schemaHash"
      ),
      state,
      workspaceId: workspaceId(
        asBoundedText(item.workspaceId, "dataset materialization.workspaceId")
      ),
    };
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError("The dataset materialization is invalid.");
  }
  const validated = createDatasetMaterialization(parsed);
  if (!validated.ok) {
    throw new DatabasePayloadError(validated.error.message);
  }
  if (identity !== undefined) {
    const identityOriginId =
      parsed.origin.kind === "import"
        ? parsed.origin.importId
        : parsed.origin.generationId;
    if (
      parsed.workspaceId !== identity.workspaceId ||
      parsed.materializationId !== identity.materializationId ||
      parsed.datasetId !== identity.datasetId ||
      parsed.schemaHash !== identity.schemaHash ||
      parsed.origin.kind !== identity.originKind ||
      identityOriginId !== identity.originId ||
      parsed.state !== identity.state ||
      parsed.revision !== asDatabaseInteger(identity.revision, "revision") ||
      parsed.recordCount !==
        asDatabaseInteger(identity.recordCount, "record count") ||
      parsed.rejectedCount !==
        asDatabaseInteger(identity.rejectedCount, "rejected count") ||
      parsed.createdAt !== identity.createdAt.getTime() ||
      !sameOptional(
        parsed.completedAt,
        identity.completedAt?.getTime() ?? null
      ) ||
      !sameOptional(parsed.completionReason, identity.completionReason) ||
      !sameOptional(parsed.contentHash, identity.contentHash) ||
      !sameOptional(parsed.coverage?.basis, identity.coverageBasis) ||
      !sameOptional(parsed.coverage?.status, identity.coverageStatus)
    ) {
      throw new DatabasePayloadError(
        "The dataset materialization payload conflicts with its relational identity."
      );
    }
  }
  return validated.value;
};

const parseGenerationPayload = (
  value: unknown,
  identity?: DatasetGenerationRowIdentity
): DatasetGeneration => {
  const item = asRecord(value, "dataset generation");
  assertOnlyKeys(
    item,
    "dataset generation",
    [
      "aggregateVersion",
      "capability",
      "cost",
      "counters",
      "createdAt",
      "datasetId",
      "generationId",
      "generationPlanId",
      "materializationId",
      "planHash",
      "queryHash",
      "requestIntentHash",
      "schemaHash",
      "state",
      "workspaceId",
    ],
    ["lastPageSequence", "lockedProvider", "stop"]
  );
  const capability = asRecord(item.capability, "dataset generation.capability");
  assertOnlyKeys(capability, "dataset generation.capability", [
    "capabilityId",
    "capabilityVersion",
  ]);
  const cost = asRecord(item.cost, "dataset generation.cost");
  assertOnlyKeys(cost, "dataset generation.cost", [
    "reserved",
    "spent",
    "unit",
  ]);
  const counters = asRecord(item.counters, "dataset generation.counters");
  assertOnlyKeys(counters, "dataset generation.counters", [
    "accepted",
    "calls",
    "duplicates",
    "pages",
    "rejected",
    "returned",
  ]);
  const state = asString(item.state, "dataset generation.state");
  if (
    state !== "planned" &&
    state !== "running" &&
    state !== "stopping" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "cancelled" &&
    state !== "ambiguous"
  ) {
    throw new DatabasePayloadError("dataset generation.state is invalid.");
  }
  const stop = (() => {
    if (item.stop === undefined) {
      return;
    }
    const value = asRecord(item.stop, "dataset generation.stop");
    assertOnlyKeys(value, "dataset generation.stop", ["reason", "requestedAt"]);
    if (value.reason !== "requested") {
      throw new DatabasePayloadError(
        "dataset generation.stop.reason is invalid."
      );
    }
    return {
      reason: "requested" as const,
      requestedAt: parseInstant(
        value.requestedAt,
        "dataset generation.stop.requestedAt"
      ),
    };
  })();
  let parsed: DatasetGeneration;
  try {
    parsed = {
      aggregateVersion: asPositiveInteger(
        item.aggregateVersion,
        "dataset generation.aggregateVersion"
      ),
      capability: {
        capabilityId: capabilityId(
          asBoundedText(
            capability.capabilityId,
            "dataset generation.capability.capabilityId"
          )
        ),
        capabilityVersion: asBoundedText(
          capability.capabilityVersion,
          "dataset generation.capability.capabilityVersion"
        ),
      },
      cost: {
        reserved: asNonNegativeNumber(
          cost.reserved,
          "dataset generation.cost.reserved"
        ),
        spent: asNonNegativeNumber(cost.spent, "dataset generation.cost.spent"),
        unit: asBoundedText(cost.unit, "dataset generation.cost.unit", 64),
      },
      counters: {
        accepted: asNonNegativeInteger(
          counters.accepted,
          "dataset generation.counters.accepted"
        ),
        calls: asNonNegativeInteger(
          counters.calls,
          "dataset generation.counters.calls"
        ),
        duplicates: asNonNegativeInteger(
          counters.duplicates,
          "dataset generation.counters.duplicates"
        ),
        pages: asNonNegativeInteger(
          counters.pages,
          "dataset generation.counters.pages"
        ),
        rejected: asNonNegativeInteger(
          counters.rejected,
          "dataset generation.counters.rejected"
        ),
        returned: asNonNegativeInteger(
          counters.returned,
          "dataset generation.counters.returned"
        ),
      },
      createdAt: parseInstant(item.createdAt, "dataset generation.createdAt"),
      datasetId: datasetId(
        asBoundedText(item.datasetId, "dataset generation.datasetId")
      ),
      generationId: datasetGenerationId(
        asIdentity(item.generationId, "dataset generation.generationId")
      ),
      generationPlanId: datasetGenerationPlanId(
        asIdentity(item.generationPlanId, "dataset generation.generationPlanId")
      ),
      ...(item.lastPageSequence === undefined
        ? {}
        : {
            lastPageSequence: asPositiveInteger(
              item.lastPageSequence,
              "dataset generation.lastPageSequence"
            ),
          }),
      ...(item.lockedProvider === undefined
        ? {}
        : {
            lockedProvider: asBoundedText(
              item.lockedProvider,
              "dataset generation.lockedProvider"
            ),
          }),
      materializationId: datasetMaterializationId(
        asBoundedText(
          item.materializationId,
          "dataset generation.materializationId"
        )
      ),
      planHash: parseHash(item.planHash, "dataset generation.planHash"),
      queryHash: parseHash(item.queryHash, "dataset generation.queryHash"),
      requestIntentHash: parseHash(
        item.requestIntentHash,
        "dataset generation.requestIntentHash"
      ),
      schemaHash: parseHash(item.schemaHash, "dataset generation.schemaHash"),
      state,
      ...(stop === undefined ? {} : { stop }),
      workspaceId: workspaceId(
        asBoundedText(item.workspaceId, "dataset generation.workspaceId")
      ),
    };
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError("The dataset generation is invalid.");
  }
  if (
    identity !== undefined &&
    (parsed.workspaceId !== identity.workspaceId ||
      parsed.generationId !== identity.generationId ||
      parsed.generationPlanId !== identity.generationPlanId ||
      !sameOptional(
        parsed.lastPageSequence,
        identity.lastPageSequence === null
          ? null
          : asDatabaseInteger(identity.lastPageSequence, "last page sequence")
      ) ||
      !sameOptional(parsed.lockedProvider, identity.lockedProvider) ||
      parsed.datasetId !== identity.datasetId ||
      parsed.materializationId !== identity.materializationId ||
      parsed.planHash !== identity.planHash ||
      parsed.queryHash !== identity.queryHash ||
      parsed.schemaHash !== identity.schemaHash ||
      parsed.requestIntentHash !== identity.requestIntentHash ||
      parsed.capability.capabilityId !== identity.capabilityId ||
      parsed.capability.capabilityVersion !== identity.capabilityVersion ||
      parsed.state !== identity.state ||
      !sameOptional(parsed.stop?.reason, identity.stopReason) ||
      !sameOptional(
        parsed.stop?.requestedAt,
        identity.stopRequestedAt?.getTime() ?? null
      ) ||
      parsed.aggregateVersion !==
        asDatabaseInteger(identity.aggregateVersion, "aggregate version") ||
      parsed.counters.accepted !==
        asDatabaseInteger(identity.acceptedCount, "accepted count") ||
      parsed.counters.calls !==
        asDatabaseInteger(identity.callCount, "call count") ||
      parsed.counters.duplicates !==
        asDatabaseInteger(identity.duplicateCount, "duplicate count") ||
      parsed.counters.pages !==
        asDatabaseInteger(identity.pageCount, "page count") ||
      parsed.counters.rejected !==
        asDatabaseInteger(identity.rejectedCount, "rejected count") ||
      parsed.counters.returned !==
        asDatabaseInteger(identity.returnedCount, "returned count") ||
      parsed.cost.reserved !==
        asDatabaseNumber(identity.costReserved, "reserved cost") ||
      parsed.cost.spent !==
        asDatabaseNumber(identity.costSpent, "spent cost") ||
      parsed.cost.unit !== identity.costUnit ||
      parsed.createdAt !== identity.createdAt.getTime())
  ) {
    throw new DatabasePayloadError(
      "The dataset generation payload conflicts with its relational identity."
    );
  }
  return parsed;
};

export const parseDatasetGenerationCreation = (
  generationPayload: unknown,
  materializationPayload: unknown,
  plan: DatasetGenerationPlan,
  generationIdentity?: DatasetGenerationRowIdentity,
  materializationIdentity?: DatasetMaterializationRowIdentity
): DatasetGenerationCreation => {
  const creation = {
    generation: parseGenerationPayload(generationPayload, generationIdentity),
    materialization: parseDatasetMaterializationPayload(
      materializationPayload,
      materializationIdentity
    ),
  };
  const validated = validateDatasetGenerationSnapshot(creation, plan);
  if (!validated.ok) {
    throw new DatabasePayloadError(validated.error.message);
  }
  return validated.value;
};
