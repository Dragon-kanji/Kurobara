import type {
  DatasetGenerationCreation,
  DatasetGenerationId,
  DomainResult,
  FieldValueType,
  ScalarValue,
  WorkspaceId,
} from "@kurobara/kernel";
import { fail, succeed } from "@kurobara/kernel";
import type {
  DatasetGenerationPersistencePort,
  DatasetRecordPage,
  DatasetRecordPageEntry,
  DatasetRecordPageQueryPort,
} from "@kurobara/ports";

export const MAX_GENERATED_CANDIDATE_PAGE_SIZE = 100;

export type ReadyGenerationCandidatePageFailureCode =
  | "dataset-generation-not-found"
  | "dataset-generation-not-ready"
  | "dataset-record-invalid"
  | "dataset-schema-invalid"
  | "request-invalid";

export type ReadyGenerationCandidatePageFailure = Readonly<{
  code: ReadyGenerationCandidatePageFailureCode;
  message: string;
}>;

export type ListedCandidate<Candidate> = Readonly<{
  candidate: Candidate;
  ordinal: number;
}>;

export type ReadyGenerationCandidatePageSuccess<Candidate> = Readonly<{
  generation: DatasetGenerationCreation["generation"];
  items: readonly ListedCandidate<Candidate>[];
  materialization: DatasetGenerationCreation["materialization"];
  page: Readonly<{
    afterOrdinal: number;
    hasMore: boolean;
    limit: number;
    nextAfterOrdinal: null | number;
  }>;
}>;

export type ReadyGenerationCandidatePageRequest = Readonly<{
  afterOrdinal: number;
  generationId: DatasetGenerationId;
  limit: number;
  workspaceId: WorkspaceId;
}>;

export type ReadyGenerationCandidatePageDependencies = Readonly<{
  generations: DatasetGenerationPersistencePort;
  records: DatasetRecordPageQueryPort;
}>;

export type GeneratedCandidateProjection<Candidate> = Readonly<{
  capabilityId: string;
  capabilityVersion: string;
  fields: Readonly<Record<string, FieldValueType>>;
  label: string;
  project: (
    entry: DatasetRecordPageEntry,
    fields: ReadonlyMap<string, string>
  ) => Candidate | undefined;
}>;

const invalid = (
  code: ReadyGenerationCandidatePageFailureCode,
  message: string
): DomainResult<never, ReadyGenerationCandidatePageFailure> =>
  fail({ code, message });

const requestIsValid = (
  request: ReadyGenerationCandidatePageRequest,
  maxPageSize: number
): boolean =>
  Number.isSafeInteger(request.afterOrdinal) &&
  request.afterOrdinal >= 0 &&
  Number.isSafeInteger(request.limit) &&
  request.limit >= 1 &&
  request.limit <= maxPageSize;

const generationIsReady = (
  creation: DatasetGenerationCreation,
  request: ReadyGenerationCandidatePageRequest,
  projection: GeneratedCandidateProjection<unknown>
): boolean => {
  const { generation, materialization } = creation;
  const completionProofMatches =
    (materialization.completionReason === "caps-reached" &&
      materialization.coverage?.status === "bounded") ||
    (materialization.completionReason === "source-completed" &&
      materialization.coverage?.status === "complete_for_declared_source");
  return (
    generation.workspaceId === request.workspaceId &&
    materialization.workspaceId === request.workspaceId &&
    generation.capability.capabilityId === projection.capabilityId &&
    generation.capability.capabilityVersion === projection.capabilityVersion &&
    materialization.origin.kind === "generation" &&
    materialization.origin.generationId === generation.generationId &&
    generation.datasetId === materialization.datasetId &&
    generation.materializationId === materialization.materializationId &&
    generation.state === "completed" &&
    materialization.state === "ready" &&
    materialization.contentHash !== undefined &&
    materialization.completedAt !== undefined &&
    materialization.completionReason !== undefined &&
    materialization.coverage?.basis === "locked_provider_route" &&
    completionProofMatches
  );
};

const pageIsConsistent = (
  creation: DatasetGenerationCreation,
  page: DatasetRecordPage | undefined,
  request: ReadyGenerationCandidatePageRequest
): page is DatasetRecordPage => {
  const remaining = creation.materialization.recordCount - request.afterOrdinal;
  const expectedItemCount = Math.min(request.limit, remaining);
  const expectedHasMore = remaining > request.limit;
  return (
    page !== undefined &&
    page.dataset.datasetId === creation.generation.datasetId &&
    page.dataset.workspaceId === request.workspaceId &&
    page.materialization.materializationId ===
      creation.materialization.materializationId &&
    page.materialization.datasetId === creation.materialization.datasetId &&
    page.materialization.workspaceId === request.workspaceId &&
    page.materialization.state === "ready" &&
    page.materialization.revision === creation.materialization.revision &&
    page.materialization.recordCount === creation.materialization.recordCount &&
    page.materialization.schemaHash === creation.materialization.schemaHash &&
    page.materialization.contentHash === creation.materialization.contentHash &&
    page.items.length === expectedItemCount &&
    page.hasMore === expectedHasMore
  );
};

const exactFieldMap = (
  creation: DatasetGenerationCreation,
  page: DatasetRecordPage,
  expectedFields: Readonly<Record<string, FieldValueType>>
): ReadonlyMap<string, string> | undefined => {
  const expectedKeys = Object.keys(expectedFields);
  if (page.fields.length !== expectedKeys.length) {
    return;
  }
  const byId = new Map<string, string>();
  const seenKeys = new Set<string>();
  for (const field of page.fields) {
    if (
      !Object.hasOwn(expectedFields, field.key) ||
      field.datasetId !== creation.generation.datasetId ||
      field.workspaceId !== creation.generation.workspaceId ||
      expectedFields[field.key] !== field.valueType ||
      byId.has(field.fieldId) ||
      seenKeys.has(field.key)
    ) {
      return;
    }
    byId.set(field.fieldId, field.key);
    seenKeys.add(field.key);
  }
  return seenKeys.size === expectedKeys.length ? byId : undefined;
};

/** Maps one exact persisted record without accepting unknown or duplicate fields. */
export const generatedRecordValues = (
  entry: DatasetRecordPageEntry,
  fields: ReadonlyMap<string, string>
): ReadonlyMap<string, ScalarValue> | undefined => {
  if (entry.record.values.length !== fields.size) {
    return;
  }
  const values = new Map<string, ScalarValue>();
  for (const value of entry.record.values) {
    const key = fields.get(value.fieldId);
    if (key === undefined || values.has(key)) {
      return;
    }
    values.set(key, value.value);
  }
  return values.size === fields.size ? values : undefined;
};

export const readReadyGenerationCandidatePage = async <Candidate>(
  dependencies: ReadyGenerationCandidatePageDependencies,
  request: ReadyGenerationCandidatePageRequest,
  projection: GeneratedCandidateProjection<Candidate>,
  maxPageSize = MAX_GENERATED_CANDIDATE_PAGE_SIZE
): Promise<
  DomainResult<
    ReadyGenerationCandidatePageSuccess<Candidate>,
    ReadyGenerationCandidatePageFailure
  >
> => {
  if (!requestIsValid(request, maxPageSize)) {
    return invalid("request-invalid", "The requested page is invalid.");
  }
  const scope = { workspaceId: request.workspaceId } as const;
  const creation = await dependencies.generations.get(
    scope,
    request.generationId
  );
  if (creation === undefined) {
    return invalid(
      "dataset-generation-not-found",
      "The dataset generation does not exist in this workspace."
    );
  }
  if (!generationIsReady(creation, request, projection)) {
    return invalid(
      "dataset-generation-not-ready",
      `${projection.label} candidates are available only from a ready ${projection.capabilityId} generation.`
    );
  }
  const { generation, materialization } = creation;
  if (request.afterOrdinal > materialization.recordCount) {
    return invalid(
      "request-invalid",
      "The requested page starts after the materialized record range."
    );
  }
  const page = await dependencies.records.listPage(scope, {
    afterOrdinal: request.afterOrdinal,
    datasetId: generation.datasetId,
    limit: request.limit,
    materializationId: materialization.materializationId,
  });
  if (!pageIsConsistent(creation, page, request)) {
    return invalid(
      "dataset-generation-not-ready",
      "The ready materialization could not be read consistently."
    );
  }
  const fieldMap = exactFieldMap(creation, page, projection.fields);
  if (fieldMap === undefined) {
    return invalid(
      "dataset-schema-invalid",
      `The generated ${projection.label.toLowerCase()} dataset schema is invalid.`
    );
  }
  let previousOrdinal = request.afterOrdinal;
  const items: ListedCandidate<Candidate>[] = [];
  for (const entry of page.items) {
    const candidate = projection.project(entry, fieldMap);
    if (
      candidate === undefined ||
      entry.record.datasetId !== generation.datasetId ||
      entry.record.workspaceId !== request.workspaceId ||
      !Number.isSafeInteger(entry.ordinal) ||
      entry.ordinal !== previousOrdinal + 1 ||
      entry.ordinal > materialization.recordCount
    ) {
      return invalid(
        "dataset-record-invalid",
        `A generated ${projection.label.toLowerCase()} record violates the public projection.`
      );
    }
    previousOrdinal = entry.ordinal;
    items.push({ candidate, ordinal: entry.ordinal });
  }
  if (page.hasMore && previousOrdinal === request.afterOrdinal) {
    return invalid(
      "dataset-record-invalid",
      `A generated ${projection.label.toLowerCase()} page did not advance its cursor.`
    );
  }
  return succeed({
    generation: structuredClone(generation),
    items,
    materialization: structuredClone(materialization),
    page: {
      afterOrdinal: request.afterOrdinal,
      hasMore: page.hasMore,
      limit: request.limit,
      nextAfterOrdinal: page.hasMore ? (items.at(-1)?.ordinal ?? null) : null,
    },
  });
};
