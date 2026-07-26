import {
  amountsEqual,
  artifactId,
  attemptId,
  authorizeDatasetGenerationPageEffect,
  contentHash,
  costReservationId,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  datasetGenerationId,
  type IdempotencyKey,
  idempotencyKey,
  instant,
  markDatasetGenerationAmbiguous,
  markDatasetGenerationPageAmbiguous,
  operationKey,
  resultManifestId,
  routingDecisionId,
  runId,
  runPlanId,
  startDatasetGenerationPage,
  stepRunId,
  usageEntryId,
  validateDatasetGenerationPageSnapshot,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationCancellationJournalEntry,
  DatasetGenerationCancellationPersistencePort,
  DatasetGenerationCancellationUnitOfWork,
  DatasetGenerationFirstPagePersistencePort,
  DatasetGenerationFirstPageUnitOfWork,
  DatasetGenerationPageRepository,
  DatasetGenerationPageRunProof,
  DatasetGenerationRunInputRepository,
  RunCreationUnitOfWork,
  RunExecutionUnitOfWork,
  StepParentEffectInput,
  StepParentEffectRepository,
  ValidatedRunInput,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  normalizedJsonEvidence,
  parseArtifact,
  parseContractRef,
  parseNormalizedJsonValue,
  serializeCanonicalJson,
} from "./artifact-payload.ts";
import {
  loadPostgresDatasetGenerationForUpdate,
  updatePostgresDatasetGenerationSnapshot,
} from "./dataset-generation-persistence.ts";
import { createPostgresDatasetGenerationPlanningUnitOfWork } from "./dataset-generation-planning.ts";
import {
  ImmutableRecordConflictError,
  PostgresAdapterError,
} from "./errors.ts";
import { toJsonValue } from "./json.ts";
import { parseRun, parseRunPlan } from "./payload.ts";
import { parseResultManifest } from "./result-manifest-payload.ts";
import {
  parseRunPlanInputRow,
  type RunPlanInputRow,
  runInputValuesMatch,
} from "./run-input-payload.ts";
import {
  parseAttempt,
  parseCostReservation,
  parseRoutingDecision,
  parseStepRun,
  parseUsageEntry,
} from "./step-payload.ts";

type RunCreationUnitOfWorkFactory = (
  sql: postgres.Sql,
  scope: WorkspaceScope
) => RunCreationUnitOfWork;

type RunExecutionUnitOfWorkFactory = (
  sql: postgres.Sql,
  scope: WorkspaceScope
) => RunExecutionUnitOfWork;

type PageRow = Readonly<{
  accepted_count: string | null;
  aggregate_version: string;
  artifact_content_hash: string | null;
  artifact_id: string | null;
  attempt_id: string | null;
  committed_at: Date | null;
  checkpoint_hash: string | null;
  cost_amount: string | null;
  cost_unit: string | null;
  created_at: Date;
  generation_id: string;
  has_more: boolean | null;
  input_content_hash: string;
  input_cursor: string | null;
  input_id: string;
  duplicate_count: string | null;
  next_cursor: string | null;
  operation_key: string | null;
  page_sequence: string;
  payload: unknown;
  provider_key: string | null;
  rejected_count: string | null;
  reservation_id: string | null;
  reserved_amount: string | null;
  result_manifest_hash: string | null;
  result_manifest_id: string | null;
  returned_count: string | null;
  route_key: string | null;
  route_snapshot_hash: string | null;
  routing_decision_id: string | null;
  run_id: string;
  run_plan_id: string;
  source_partition_completed: boolean | null;
  state: string;
  step_run_id: string | null;
  usage_entry_id: string | null;
  workspace_id: string;
}>;

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A generation page transaction cannot cross workspaces."
    );
  }
};

const object = (
  value: unknown,
  subject: string
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} payload must be an object.`
    );
  }
  return value as Readonly<Record<string, unknown>>;
};

const requiredString = (value: unknown, subject: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} must be a non-empty string.`
    );
  }
  return value;
};

const optionalString = (value: unknown, subject: string): string | undefined =>
  value === undefined ? undefined : requiredString(value, subject);

const requiredInteger = (value: unknown, subject: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} must be a non-negative safe integer.`
    );
  }
  return value as number;
};

const optionalInteger = (
  value: unknown,
  subject: string
): number | undefined =>
  value === undefined ? undefined : requiredInteger(value, subject);

const optionalAmount = (
  value: unknown,
  subject: string
): number | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} must be a non-negative finite amount.`
    );
  }
  return value;
};

const optionalBoolean = (
  value: unknown,
  subject: string
): boolean | undefined => {
  if (value !== undefined && typeof value !== "boolean") {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} must be a boolean.`
    );
  }
  return value;
};

const pageState = (value: unknown): DatasetGenerationPage["state"] => {
  if (
    value !== "run_created" &&
    value !== "executing" &&
    value !== "committed" &&
    value !== "failed" &&
    value !== "ambiguous"
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The generation page state is invalid."
    );
  }
  return value;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed decoding intentionally validates every optional lifecycle field in one canonical pass.
const parsePagePayload = (value: unknown): DatasetGenerationPage => {
  const item = object(value, "generation page");
  const allowedKeys = new Set([
    "acceptedCount",
    "aggregateVersion",
    "artifactContentHash",
    "artifactId",
    "attemptId",
    "checkpointHash",
    "committedAt",
    "costAmount",
    "costUnit",
    "createdAt",
    "duplicateCount",
    "generationId",
    "hasMore",
    "inputContentHash",
    "inputCursor",
    "inputId",
    "nextCursor",
    "operationKey",
    "pageSequence",
    "providerKey",
    "rejectedCount",
    "reservationId",
    "reservedAmount",
    "resultManifestHash",
    "resultManifestId",
    "returnedCount",
    "routeKey",
    "routeSnapshotHash",
    "routingDecisionId",
    "runId",
    "runPlanId",
    "sourcePartitionCompleted",
    "state",
    "stepRunId",
    "usageEntryId",
    "workspaceId",
  ]);
  const extraKey = Object.keys(item).find((key) => !allowedKeys.has(key));
  if (extraKey !== undefined) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The generation page payload contains unsupported field ${extraKey}.`
    );
  }
  const inputCursor = item.inputCursor;
  if (
    !Number.isSafeInteger(item.pageSequence) ||
    (item.pageSequence as number) < 1 ||
    ((item.pageSequence as number) === 1
      ? inputCursor !== null
      : typeof inputCursor !== "string" || inputCursor.length === 0)
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "A generation page requires an exact sequence and predecessor cursor."
    );
  }
  const nextCursor = item.nextCursor;
  if (
    !(
      nextCursor === undefined ||
      nextCursor === null ||
      typeof nextCursor === "string"
    )
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The generation page next cursor is invalid."
    );
  }
  try {
    const page: DatasetGenerationPage = {
      ...(optionalInteger(item.acceptedCount, "accepted count") === undefined
        ? {}
        : {
            acceptedCount: optionalInteger(
              item.acceptedCount,
              "accepted count"
            ) as number,
          }),
      aggregateVersion: requiredInteger(
        item.aggregateVersion,
        "generation page aggregate version"
      ),
      ...(item.artifactContentHash === undefined
        ? {}
        : {
            artifactContentHash: contentHash(
              requiredString(item.artifactContentHash, "artifact content hash")
            ),
          }),
      ...(item.artifactId === undefined
        ? {}
        : {
            artifactId: artifactId(
              requiredString(item.artifactId, "artifact id")
            ),
          }),
      ...(item.attemptId === undefined
        ? {}
        : {
            attemptId: attemptId(requiredString(item.attemptId, "attempt id")),
          }),
      ...(item.committedAt === undefined
        ? {}
        : {
            committedAt: instant(
              requiredInteger(item.committedAt, "committed at")
            ),
          }),
      ...(item.checkpointHash === undefined
        ? {}
        : {
            checkpointHash: contentHash(
              requiredString(item.checkpointHash, "checkpoint hash")
            ),
          }),
      ...(optionalAmount(item.costAmount, "generation page cost amount") ===
      undefined
        ? {}
        : {
            costAmount: optionalAmount(
              item.costAmount,
              "generation page cost amount"
            ) as number,
          }),
      ...(optionalString(item.costUnit, "generation page cost unit") ===
      undefined
        ? {}
        : {
            costUnit: optionalString(
              item.costUnit,
              "generation page cost unit"
            ) as string,
          }),
      createdAt: instant(
        requiredInteger(item.createdAt, "generation page created at")
      ),
      generationId: datasetGenerationId(
        requiredString(item.generationId, "generation id")
      ),
      ...(optionalBoolean(item.hasMore, "generation page has more") ===
      undefined
        ? {}
        : {
            hasMore: optionalBoolean(
              item.hasMore,
              "generation page has more"
            ) as boolean,
          }),
      inputContentHash: contentHash(
        requiredString(item.inputContentHash, "input content hash")
      ),
      inputCursor: inputCursor as null | string,
      inputId: requiredString(item.inputId, "input id"),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(item.operationKey === undefined
        ? {}
        : {
            operationKey: operationKey(
              requiredString(item.operationKey, "operation key")
            ),
          }),
      pageSequence: requiredInteger(item.pageSequence, "page sequence"),
      ...(optionalString(item.providerKey, "provider key") === undefined
        ? {}
        : {
            providerKey: optionalString(
              item.providerKey,
              "provider key"
            ) as string,
          }),
      ...(optionalInteger(item.duplicateCount, "duplicate count") === undefined
        ? {}
        : {
            duplicateCount: optionalInteger(
              item.duplicateCount,
              "duplicate count"
            ) as number,
          }),
      ...(optionalInteger(item.rejectedCount, "rejected count") === undefined
        ? {}
        : {
            rejectedCount: optionalInteger(
              item.rejectedCount,
              "rejected count"
            ) as number,
          }),
      ...(item.reservationId === undefined
        ? {}
        : {
            reservationId: costReservationId(
              requiredString(item.reservationId, "reservation id")
            ),
          }),
      ...(optionalAmount(item.reservedAmount, "reserved amount") === undefined
        ? {}
        : {
            reservedAmount: optionalAmount(
              item.reservedAmount,
              "reserved amount"
            ) as number,
          }),
      ...(item.resultManifestHash === undefined
        ? {}
        : {
            resultManifestHash: contentHash(
              requiredString(item.resultManifestHash, "result manifest hash")
            ),
          }),
      ...(item.resultManifestId === undefined
        ? {}
        : {
            resultManifestId: resultManifestId(
              requiredString(item.resultManifestId, "result manifest id")
            ),
          }),
      ...(optionalInteger(item.returnedCount, "returned count") === undefined
        ? {}
        : {
            returnedCount: optionalInteger(
              item.returnedCount,
              "returned count"
            ) as number,
          }),
      ...(optionalString(item.routeKey, "route key") === undefined
        ? {}
        : { routeKey: optionalString(item.routeKey, "route key") as string }),
      ...(item.routeSnapshotHash === undefined
        ? {}
        : {
            routeSnapshotHash: contentHash(
              requiredString(item.routeSnapshotHash, "route snapshot hash")
            ),
          }),
      ...(item.routingDecisionId === undefined
        ? {}
        : {
            routingDecisionId: routingDecisionId(
              requiredString(item.routingDecisionId, "routing decision id")
            ),
          }),
      runId: runId(requiredString(item.runId, "run id")),
      runPlanId: runPlanId(requiredString(item.runPlanId, "run plan id")),
      ...(optionalBoolean(
        item.sourcePartitionCompleted,
        "source partition completed"
      ) === undefined
        ? {}
        : {
            sourcePartitionCompleted: optionalBoolean(
              item.sourcePartitionCompleted,
              "source partition completed"
            ) as boolean,
          }),
      state: pageState(item.state),
      ...(item.stepRunId === undefined
        ? {}
        : {
            stepRunId: stepRunId(requiredString(item.stepRunId, "step run id")),
          }),
      ...(item.usageEntryId === undefined
        ? {}
        : {
            usageEntryId: usageEntryId(
              requiredString(item.usageEntryId, "usage entry id")
            ),
          }),
      workspaceId: workspaceId(
        requiredString(item.workspaceId, "workspace id")
      ),
    };
    const validated = validateDatasetGenerationPageSnapshot(page);
    if (!validated.ok) {
      throw new PostgresAdapterError(
        "database-payload-invalid",
        validated.error.message
      );
    }
    return validated.value;
  } catch (error) {
    if (error instanceof PostgresAdapterError) {
      throw error;
    }
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The generation page contains an invalid durable identifier."
    );
  }
};

const databaseOptionalNumber = (value: string | null): number | undefined => {
  if (value === null) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A generation page numeric identity is invalid."
    );
  }
  return parsed;
};

const sameOptional = <Value>(left: Value | undefined, right: Value | null) =>
  left === (right ?? undefined);

const parsePageRow = (row: PageRow): DatasetGenerationPage => {
  const page = parsePagePayload(row.payload);
  if (
    page.workspaceId !== row.workspace_id ||
    page.generationId !== row.generation_id ||
    page.pageSequence !== Number(row.page_sequence) ||
    page.state !== row.state ||
    page.aggregateVersion !== Number(row.aggregate_version) ||
    page.runPlanId !== row.run_plan_id ||
    page.inputId !== row.input_id ||
    page.inputContentHash !== row.input_content_hash ||
    page.inputCursor !== row.input_cursor ||
    page.runId !== row.run_id ||
    page.createdAt !== row.created_at.getTime() ||
    !sameOptional(page.stepRunId, row.step_run_id) ||
    !sameOptional(page.attemptId, row.attempt_id) ||
    !sameOptional(page.operationKey, row.operation_key) ||
    !sameOptional(page.routingDecisionId, row.routing_decision_id) ||
    !sameOptional(page.routeKey, row.route_key) ||
    !sameOptional(page.providerKey, row.provider_key) ||
    !sameOptional(page.routeSnapshotHash, row.route_snapshot_hash) ||
    !sameOptional(page.reservationId, row.reservation_id) ||
    page.reservedAmount !== databaseOptionalNumber(row.reserved_amount) ||
    !sameOptional(page.costUnit, row.cost_unit) ||
    !sameOptional(page.artifactId, row.artifact_id) ||
    !sameOptional(page.artifactContentHash, row.artifact_content_hash) ||
    !sameOptional(page.resultManifestId, row.result_manifest_id) ||
    !sameOptional(page.resultManifestHash, row.result_manifest_hash) ||
    !sameOptional(page.usageEntryId, row.usage_entry_id) ||
    page.costAmount !== databaseOptionalNumber(row.cost_amount) ||
    page.returnedCount !== databaseOptionalNumber(row.returned_count) ||
    (page.nextCursor === undefined
      ? row.next_cursor !== null
      : page.nextCursor !== row.next_cursor) ||
    page.hasMore !== (row.has_more ?? undefined) ||
    page.sourcePartitionCompleted !==
      (row.source_partition_completed ?? undefined) ||
    page.committedAt !== (row.committed_at?.getTime() ?? undefined) ||
    page.acceptedCount !== databaseOptionalNumber(row.accepted_count) ||
    !sameOptional(page.checkpointHash, row.checkpoint_hash) ||
    page.duplicateCount !== databaseOptionalNumber(row.duplicate_count) ||
    page.rejectedCount !== databaseOptionalNumber(row.rejected_count)
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A generation page payload conflicts with its relational identity."
    );
  }
  return page;
};

const pageSelect = (sql: postgres.Sql) => sql`
  workspace_id,
  generation_id,
  page_sequence::text AS page_sequence,
  state,
  aggregate_version::text AS aggregate_version,
  run_plan_id,
  input_id,
  input_content_hash,
  input_cursor,
  run_id,
  step_run_id,
  attempt_id,
  operation_key,
  routing_decision_id,
  route_key,
  provider_key,
  route_snapshot_hash,
  reservation_id,
  reserved_amount::text AS reserved_amount,
  cost_unit,
  artifact_id,
  artifact_content_hash,
  result_manifest_id,
  result_manifest_hash,
  usage_entry_id,
  cost_amount::text AS cost_amount,
  returned_count::text AS returned_count,
  next_cursor,
  has_more,
  source_partition_completed,
  payload,
  created_at,
  committed_at
  , accepted_count::text AS accepted_count
  , duplicate_count::text AS duplicate_count
  , rejected_count::text AS rejected_count
  , checkpoint_hash
`;

const loadPageForUpdate = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  generationIdValue: DatasetGenerationPage["generationId"],
  pageSequence: number
): Promise<DatasetGenerationPage | undefined> => {
  const rows = await sql<readonly PageRow[]>`
    SELECT ${pageSelect(sql)}
    FROM kurobara_core.dataset_generation_pages
    WHERE workspace_id = ${scope.workspaceId}
      AND generation_id = ${generationIdValue}
      AND page_sequence = ${pageSequence}
    FOR UPDATE
  `;
  return rows[0] === undefined ? undefined : parsePageRow(rows[0]);
};

const findGenerationPageByRun = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  runIdValue: StepParentEffectInput["run"]["runId"]
): Promise<
  | Readonly<{
      generationId: DatasetGenerationPage["generationId"];
      pageSequence: number;
    }>
  | undefined
> => {
  const rows = await sql<
    readonly { generation_id: string; page_sequence: string }[]
  >`
    SELECT generation_id, page_sequence::text AS page_sequence
    FROM kurobara_core.dataset_generation_pages
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${runIdValue}
  `;
  return rows[0] === undefined
    ? undefined
    : {
        generationId: datasetGenerationId(rows[0].generation_id),
        pageSequence: Number(rows[0].page_sequence),
      };
};

const insertRunInput = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  runPlan: Parameters<DatasetGenerationRunInputRepository["insert"]>[1],
  input: ValidatedRunInput
): Promise<void> => {
  const parsedPlan = parseRunPlan(toJsonValue(runPlan));
  const parsedInput = parseRunPlanInputRow({
    classification: input.classification,
    content_hash: input.contentHash,
    contract: toJsonValue(input.contract),
    finalized_at: new Date(input.finalizedAt),
    input_id: input.inputId,
    media_type: input.mediaType,
    normalized_payload: toJsonValue(input.value),
    run_plan_id: runPlan.runPlanId,
    size_bytes: String(input.sizeBytes),
    validated_at: new Date(input.validatedAt),
    validator_version: input.validatorVersion,
    workspace_id: scope.workspaceId,
  });
  if (
    parsedPlan.workspaceId !== scope.workspaceId ||
    parsedInput.contentHash !== parsedPlan.normalizedInputHash ||
    parsedInput.contract.catalogFingerprint !==
      parsedPlan.inputContract.catalogFingerprint ||
    parsedInput.contract.catalogVersion !==
      parsedPlan.inputContract.catalogVersion ||
    parsedInput.contract.schemaFingerprint !==
      parsedPlan.inputContract.schemaFingerprint ||
    parsedInput.contract.schemaId !== parsedPlan.inputContract.schemaId ||
    parsedInput.contract.schemaVersion !==
      parsedPlan.inputContract.schemaVersion
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The generation page Run input does not match its immutable RunPlan."
    );
  }
  const inserted = await sql<readonly { input_id: string }[]>`
    INSERT INTO kurobara_core.run_plan_inputs (
      workspace_id,
      run_plan_id,
      input_id,
      content_hash,
      contract,
      normalized_payload,
      classification,
      media_type,
      size_bytes,
      validator_version,
      validated_at,
      finalized_at
    ) VALUES (
      ${scope.workspaceId},
      ${runPlan.runPlanId},
      ${parsedInput.inputId},
      ${parsedInput.contentHash},
      ${sql.json(toJsonValue(parsedInput.contract))},
      ${sql.json(toJsonValue(parsedInput.value))},
      ${parsedInput.classification},
      ${parsedInput.mediaType},
      ${parsedInput.sizeBytes},
      ${parsedInput.validatorVersion},
      ${new Date(parsedInput.validatedAt)},
      ${new Date(parsedInput.finalizedAt)}
    )
    ON CONFLICT DO NOTHING
    RETURNING input_id
  `;
  if (inserted.length === 1) {
    return;
  }
  const rows = await sql<readonly RunPlanInputRow[]>`
    SELECT
      workspace_id,
      run_plan_id,
      input_id,
      content_hash,
      contract,
      normalized_payload,
      classification,
      media_type,
      size_bytes::text AS size_bytes,
      validator_version,
      validated_at,
      finalized_at
    FROM kurobara_core.run_plan_inputs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_plan_id = ${runPlan.runPlanId}
  `;
  const stored =
    rows[0] === undefined ? undefined : parseRunPlanInputRow(rows[0]);
  if (
    stored === undefined ||
    stored.inputId !== parsedInput.inputId ||
    stored.contentHash !== parsedInput.contentHash ||
    stored.classification !== parsedInput.classification ||
    stored.mediaType !== parsedInput.mediaType ||
    stored.sizeBytes !== parsedInput.sizeBytes ||
    stored.validatorVersion !== parsedInput.validatorVersion ||
    stored.validatedAt !== parsedInput.validatedAt ||
    stored.finalizedAt !== parsedInput.finalizedAt ||
    serializeCanonicalJson(stored.contract) !==
      serializeCanonicalJson(parsedInput.contract) ||
    !runInputValuesMatch(stored.value, parsedInput.value)
  ) {
    throw new ImmutableRecordConflictError("generation page Run input");
  }
};

const insertPage = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  page: DatasetGenerationPage
): Promise<void> => {
  if (
    page.workspaceId !== scope.workspaceId ||
    page.pageSequence < 1 ||
    page.state !== "run_created" ||
    page.aggregateVersion !== 1
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A new generation page must be an exact initial page snapshot in this workspace."
    );
  }
  await sql`
    INSERT INTO kurobara_core.dataset_generation_pages (
      workspace_id,
      generation_id,
      page_sequence,
      state,
      aggregate_version,
      run_plan_id,
      input_id,
      input_content_hash,
      input_cursor,
      run_id,
      payload,
      created_at
    ) VALUES (
      ${scope.workspaceId},
      ${page.generationId},
      ${page.pageSequence},
      ${page.state},
      ${page.aggregateVersion},
      ${page.runPlanId},
      ${page.inputId},
      ${page.inputContentHash},
      ${page.inputCursor},
      ${page.runId},
      ${sql.json(toJsonValue(page))},
      ${new Date(page.createdAt)}
    )
  `;
};

const nullablePageEffectColumns = (page: DatasetGenerationPage) => ({
  attemptId: page.attemptId ?? null,
  costUnit: page.costUnit ?? null,
  operationKey: page.operationKey ?? null,
  providerKey: page.providerKey ?? null,
  reservationId: page.reservationId ?? null,
  reservedAmount: page.reservedAmount ?? null,
  routeKey: page.routeKey ?? null,
  routeSnapshotHash: page.routeSnapshotHash ?? null,
  routingDecisionId: page.routingDecisionId ?? null,
  stepRunId: page.stepRunId ?? null,
});

const nullablePageResultColumns = (page: DatasetGenerationPage) => ({
  acceptedCount: page.acceptedCount ?? null,
  artifactContentHash: page.artifactContentHash ?? null,
  artifactId: page.artifactId ?? null,
  checkpointHash: page.checkpointHash ?? null,
  costAmount: page.costAmount ?? null,
  duplicateCount: page.duplicateCount ?? null,
  hasMore: page.hasMore ?? null,
  nextCursor: page.nextCursor ?? null,
  rejectedCount: page.rejectedCount ?? null,
  resultManifestHash: page.resultManifestHash ?? null,
  resultManifestId: page.resultManifestId ?? null,
  returnedCount: page.returnedCount ?? null,
  sourcePartitionCompleted: page.sourcePartitionCompleted ?? null,
  usageEntryId: page.usageEntryId ?? null,
});

const updatePage = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  expectedAggregateVersion: number,
  page: DatasetGenerationPage
): Promise<void> => {
  const effect = nullablePageEffectColumns(page);
  const result = nullablePageResultColumns(page);
  const committedAt =
    page.committedAt === undefined ? null : new Date(page.committedAt);
  const updated = await sql<readonly { generation_id: string }[]>`
    UPDATE kurobara_core.dataset_generation_pages
    SET
      state = ${page.state},
      aggregate_version = ${page.aggregateVersion},
      step_run_id = ${effect.stepRunId},
      attempt_id = ${effect.attemptId},
      operation_key = ${effect.operationKey},
      routing_decision_id = ${effect.routingDecisionId},
      route_key = ${effect.routeKey},
      provider_key = ${effect.providerKey},
      route_snapshot_hash = ${effect.routeSnapshotHash},
      reservation_id = ${effect.reservationId},
      reserved_amount = ${effect.reservedAmount},
      cost_unit = ${effect.costUnit},
      artifact_id = ${result.artifactId},
      artifact_content_hash = ${result.artifactContentHash},
      result_manifest_id = ${result.resultManifestId},
      result_manifest_hash = ${result.resultManifestHash},
      usage_entry_id = ${result.usageEntryId},
      cost_amount = ${result.costAmount},
      returned_count = ${result.returnedCount},
      accepted_count = ${result.acceptedCount},
      duplicate_count = ${result.duplicateCount},
      rejected_count = ${result.rejectedCount},
      next_cursor = ${result.nextCursor},
      has_more = ${result.hasMore},
      source_partition_completed = ${result.sourcePartitionCompleted},
      checkpoint_hash = ${result.checkpointHash},
      payload = ${sql.json(toJsonValue(page))},
      committed_at = ${committedAt}
    WHERE workspace_id = ${scope.workspaceId}
      AND generation_id = ${page.generationId}
      AND page_sequence = ${page.pageSequence}
      AND aggregate_version = ${expectedAggregateVersion}
    RETURNING generation_id
  `;
  if (updated.length !== 1) {
    throw new PostgresAdapterError(
      "dataset-generation-page-conflict",
      "The generation page no longer has the expected aggregate version."
    );
  }
};

type ProofRow = Readonly<{
  artifact: unknown | null;
  artifact_classification: string | null;
  artifact_content_hash: string | null;
  artifact_contract: unknown | null;
  artifact_finalized_at: Date | null;
  artifact_id: string | null;
  artifact_kind: string | null;
  artifact_media_type: string | null;
  artifact_normalized_payload: unknown | null;
  artifact_operation_key: string | null;
  artifact_retention_policy: string | null;
  artifact_size_bytes: string | null;
  artifact_state: string | null;
  artifact_validated_at: Date | null;
  artifact_validator_version: string | null;
  attempt: unknown | null;
  manifest: unknown | null;
  reservation: unknown | null;
  routing_decision: unknown | null;
  run: unknown;
  run_plan: unknown;
  step_run: unknown | null;
  usage: unknown | null;
}>;

const readRunProof = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  page: DatasetGenerationPage
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed proof decoding validates the full Run, route, settlement, artifact, and manifest chain.
): Promise<DatasetGenerationPageRunProof> => {
  const rows = await sql<readonly ProofRow[]>`
    SELECT
      run.run,
      run_plan.plan AS run_plan,
      step.step_run,
      attempt.attempt,
      decision.decision AS routing_decision,
      reservation.reservation,
      usage.entry AS usage,
      artifact.artifact,
      artifact.contract AS artifact_contract,
      artifact.normalized_payload AS artifact_normalized_payload,
      artifact.artifact_id,
      artifact.content_hash AS artifact_content_hash,
      artifact.operation_key AS artifact_operation_key,
      artifact.classification AS artifact_classification,
      artifact.kind AS artifact_kind,
      artifact.media_type AS artifact_media_type,
      artifact.retention_policy AS artifact_retention_policy,
      artifact.size_bytes::text AS artifact_size_bytes,
      artifact.state AS artifact_state,
      artifact.validator_version AS artifact_validator_version,
      artifact.validated_at AS artifact_validated_at,
      artifact.finalized_at AS artifact_finalized_at,
      manifest.manifest
    FROM kurobara_core.runs AS run
    JOIN kurobara_core.run_plans AS run_plan
      ON run_plan.workspace_id = run.workspace_id
      AND run_plan.run_plan_id = run.run_plan_id
    LEFT JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = run.workspace_id
      AND step.run_id = run.run_id
      AND step.node_key = 'page'
    LEFT JOIN kurobara_core.step_attempts AS attempt
      ON attempt.workspace_id = step.workspace_id
      AND attempt.step_run_id = step.step_run_id
      AND attempt.attempt_id = ${page.attemptId ?? null}
    LEFT JOIN kurobara_core.routing_decisions AS decision
      ON decision.workspace_id = attempt.workspace_id
      AND decision.step_run_id = attempt.step_run_id
      AND decision.routing_decision_id = attempt.routing_decision_id
    LEFT JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = attempt.workspace_id
      AND reservation.attempt_id = attempt.attempt_id
      AND reservation.reservation_id = attempt.reservation_id
    LEFT JOIN kurobara_core.usage_ledger_entries AS usage
      ON usage.workspace_id = reservation.workspace_id
      AND usage.reservation_id = reservation.reservation_id
    LEFT JOIN kurobara_core.run_output_artifacts AS artifact
      ON artifact.workspace_id = attempt.workspace_id
      AND artifact.attempt_id = attempt.attempt_id
    LEFT JOIN kurobara_core.run_result_manifests AS manifest
      ON manifest.workspace_id = run.workspace_id
      AND manifest.run_id = run.run_id
    WHERE run.workspace_id = ${scope.workspaceId}
      AND run.run_id = ${page.runId}
      AND run.run_plan_id = ${page.runPlanId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The generation page lost its canonical Run binding."
    );
  }
  const run = parseRun(row.run);
  const runPlan = parseRunPlan(row.run_plan);
  if (row.step_run === null) {
    return run.state === "queued" || run.state === "running"
      ? { status: "pending" }
      : (() => {
          throw new PostgresAdapterError(
            "database-identity-mismatch",
            "A terminal page Run is missing its mono-step proof."
          );
        })();
  }
  const stepRun = parseStepRun(row.step_run);
  const terminalAttempt = stepRun.attempts.at(-1);
  if (stepRun.state === "ambiguous" || terminalAttempt?.state === "ambiguous") {
    return {
      ...(terminalAttempt === undefined
        ? {}
        : { attemptId: terminalAttempt.attemptId }),
      status: "ambiguous",
      stepRunId: stepRun.stepRunId,
    };
  }
  if (
    run.state !== "completed" ||
    stepRun.state !== "succeeded" ||
    terminalAttempt?.state !== "succeeded"
  ) {
    if (
      run.state === "queued" ||
      run.state === "running" ||
      stepRun.state === "pending" ||
      stepRun.state === "ready" ||
      stepRun.state === "active" ||
      terminalAttempt?.state === "prepared" ||
      terminalAttempt?.state === "claimed" ||
      terminalAttempt?.state === "in_flight"
    ) {
      return { status: "pending" };
    }
    if (
      run.state === "failed" ||
      run.state === "cancelled" ||
      stepRun.state === "failed" ||
      stepRun.state === "cancelled"
    ) {
      return {
        reason:
          run.state === "cancelled" || stepRun.state === "cancelled"
            ? "page-run-cancelled"
            : "page-run-failed",
        status: "failed",
      };
    }
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The terminal generation page Run is not a successful or ambiguous proof."
    );
  }
  if (
    row.attempt === null ||
    row.routing_decision === null ||
    row.reservation === null ||
    row.usage === null ||
    row.artifact === null ||
    row.artifact_normalized_payload === null ||
    row.manifest === null
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A successful page Run is missing durable route, settlement, artifact, or manifest evidence."
    );
  }
  const attempt = parseAttempt(row.attempt);
  const routingDecision = parseRoutingDecision(row.routing_decision);
  const reservation = parseCostReservation(row.reservation);
  const usage = parseUsageEntry(row.usage);
  const artifact = parseArtifact(row.artifact);
  const artifactValue = parseNormalizedJsonValue(
    row.artifact_normalized_payload,
    "generationPage.artifact"
  );
  const artifactEvidence = normalizedJsonEvidence(artifactValue);
  const artifactContract = parseContractRef(
    row.artifact_contract,
    "generationPage.artifact.contract"
  );
  const manifest = parseResultManifest(row.manifest);
  const artifactSize = Number(row.artifact_size_bytes);
  if (
    attempt.attemptId !== terminalAttempt.attemptId ||
    attempt.stepRunId !== stepRun.stepRunId ||
    attempt.routingDecisionId !== routingDecision.routingDecisionId ||
    attempt.costReservationId !== reservation.reservationId ||
    attempt.operationKey !== reservation.operationKey ||
    attempt.operationKey !== usage.operationKey ||
    attempt.operationKey !== artifact.operationKey ||
    reservation.state !== "settled" ||
    reservation.attemptId !== attempt.attemptId ||
    reservation.stepRunId !== stepRun.stepRunId ||
    reservation.runId !== run.runId ||
    reservation.usageEntryId !== usage.usageEntryId ||
    !amountsEqual(reservation.settledAmount, usage.amount) ||
    usage.attemptId !== attempt.attemptId ||
    usage.reservationId !== reservation.reservationId ||
    usage.runId !== run.runId ||
    routingDecision.runId !== run.runId ||
    routingDecision.stepRunId !== stepRun.stepRunId ||
    artifact.runId !== run.runId ||
    artifact.stepRunId !== stepRun.stepRunId ||
    artifact.attemptId !== attempt.attemptId ||
    artifact.artifactId !== row.artifact_id ||
    artifact.contentHash !== row.artifact_content_hash ||
    artifact.contentHash !== artifactEvidence.contentHash ||
    artifact.sizeBytes !== artifactEvidence.sizeBytes ||
    artifact.sizeBytes !== artifactSize ||
    artifact.classification !== row.artifact_classification ||
    artifact.kind !== row.artifact_kind ||
    artifact.mediaType !== row.artifact_media_type ||
    artifact.retentionPolicy !== row.artifact_retention_policy ||
    artifact.state !== row.artifact_state ||
    artifact.validatorVersion !== row.artifact_validator_version ||
    artifact.validatedAt !== row.artifact_validated_at?.getTime() ||
    artifact.finalizedAt !== row.artifact_finalized_at?.getTime() ||
    serializeCanonicalJson(artifact.contract) !==
      serializeCanonicalJson(artifactContract) ||
    manifest.runId !== run.runId ||
    manifest.runPlanId !== runPlan.runPlanId ||
    manifest.workspaceId !== scope.workspaceId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The successful page Run proof is internally inconsistent."
    );
  }
  return {
    artifact,
    artifactValue,
    attempt,
    manifest,
    routingDecision,
    run,
    runPlan,
    status: "succeeded",
    stepRun,
    usage,
  };
};

const createPageRepository = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): DatasetGenerationPageRepository => ({
  appendRecordsAndLineage: async (scope, input) => {
    assertScope(transactionScope, scope);
    if (input.records.length !== input.lineage.length) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "Generated records require one exact lineage row each."
      );
    }
    for (let index = 0; index < input.records.length; index += 1) {
      const write = input.records[index];
      const lineage = input.lineage[index];
      if (
        write === undefined ||
        lineage === undefined ||
        write.candidatePosition < 1 ||
        lineage.candidatePosition !== write.candidatePosition ||
        lineage.recordOrdinal !== write.recordOrdinal ||
        lineage.recordId !== write.record.recordId ||
        write.record.workspaceId !== scope.workspaceId
      ) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "Generated record and lineage ordering must be exact."
        );
      }
      await sql`
        INSERT INTO kurobara_core.dataset_records (
          workspace_id,
          dataset_id,
          record_id,
          import_id,
          batch_sequence,
          item_number,
          record_number,
          content_hash,
          record,
          materialization_id,
          record_ordinal,
          generation_id,
          page_sequence,
          candidate_position
        ) VALUES (
          ${scope.workspaceId},
          ${write.record.datasetId},
          ${write.record.recordId},
          NULL,
          NULL,
          NULL,
          NULL,
          ${write.contentHash},
          ${sql.json(toJsonValue(write.record))},
          ${write.record.datasetId},
          ${write.recordOrdinal},
          ${write.generationId},
          ${write.pageSequence},
          ${write.candidatePosition}
        )
      `;
      await sql`
        INSERT INTO kurobara_core.dataset_generation_record_lineage (
          workspace_id,
          dataset_id,
          record_id,
          generation_id,
          page_sequence,
          candidate_position,
          run_id,
          step_run_id,
          attempt_id,
          operation_key,
          routing_decision_id,
          reservation_id,
          artifact_id,
          result_manifest_id,
          usage_entry_id,
          provider_key,
          provider_subject_id,
          source_dataset_id,
          source_record_id
        ) VALUES (
          ${scope.workspaceId},
          ${write.record.datasetId},
          ${lineage.recordId},
          ${lineage.generationId},
          ${lineage.pageSequence},
          ${lineage.candidatePosition},
          ${lineage.runId},
          ${lineage.stepRunId},
          ${lineage.attemptId},
          ${lineage.operationKey},
          ${lineage.routingDecisionId},
          ${lineage.reservationId},
          ${lineage.artifactId},
          ${lineage.resultManifestId},
          ${lineage.usageEntryId},
          ${lineage.providerIdentity?.providerKey ?? null},
          ${lineage.providerIdentity?.providerSubjectId ?? null},
          ${lineage.source?.datasetId ?? null},
          ${lineage.source?.recordId ?? null}
        )
      `;
    }
  },
  computeMaterializationContentHash: async (scope, generationIdValue) => {
    assertScope(transactionScope, scope);
    const rows = await sql<readonly { content_hash: string }[]>`
      SELECT kurobara_core.dataset_materialization_content_hash(
        generation.workspace_id,
        generation.dataset_id
      ) AS content_hash
      FROM kurobara_core.dataset_generations AS generation
      WHERE generation.workspace_id = ${scope.workspaceId}
        AND generation.generation_id = ${generationIdValue}
    `;
    const value = rows[0]?.content_hash;
    if (value === undefined) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "The generated materialization content hash cannot be proven."
      );
    }
    return contentHash(value);
  },
  findExistingContentHashes: async (scope, generationIdValue, hashes) => {
    assertScope(transactionScope, scope);
    if (hashes.length === 0) {
      return [];
    }
    const rows = await sql<readonly { content_hash: string }[]>`
      SELECT record.content_hash
      FROM kurobara_core.dataset_records AS record
      WHERE record.workspace_id = ${scope.workspaceId}
        AND record.generation_id = ${generationIdValue}
        AND record.content_hash = ANY(${hashes as readonly string[]})
    `;
    return rows.map((row) => contentHash(row.content_hash));
  },
  getGenerationForUpdate: (scope, generationIdValue) => {
    assertScope(transactionScope, scope);
    return loadPostgresDatasetGenerationForUpdate(
      sql,
      scope,
      generationIdValue
    );
  },
  getPageForUpdate: (scope, generationIdValue, pageSequence) => {
    assertScope(transactionScope, scope);
    return loadPageForUpdate(sql, scope, generationIdValue, pageSequence);
  },
  insertPage: (scope, page) => {
    assertScope(transactionScope, scope);
    return insertPage(sql, scope, page);
  },
  readRunProof: (scope, page) => {
    assertScope(transactionScope, scope);
    return readRunProof(sql, scope, page);
  },
  updateGeneration: (scope, input) => {
    assertScope(transactionScope, scope);
    return updatePostgresDatasetGenerationSnapshot(sql, scope, input);
  },
  updatePage: (scope, expectedVersion, page) => {
    assertScope(transactionScope, scope);
    return updatePage(sql, scope, expectedVersion, page);
  },
});

export const createPostgresDatasetGenerationFirstPagePersistence = (
  sql: postgres.Sql,
  runUnitOfWorkFactory: RunCreationUnitOfWorkFactory
): DatasetGenerationFirstPagePersistencePort => ({
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationFirstPageUnitOfWork) => Promise<Value>
  ): Promise<Value> => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const unitOfWork: DatasetGenerationFirstPageUnitOfWork = {
        ...runUnitOfWorkFactory(transactionSql, scope),
        generationPages: createPageRepository(transactionSql, scope),
        generationPlans: createPostgresDatasetGenerationPlanningUnitOfWork(
          transactionSql,
          scope
        ).generationPlans,
        runInputs: {
          insert: (operationScope, runPlan, input) => {
            assertScope(scope, operationScope);
            return insertRunInput(transactionSql, scope, runPlan, input);
          },
        },
      };
      return work(unitOfWork);
    });
    return result as unknown as Value;
  },
});

export const createPostgresDatasetGenerationCancellationPersistence = (
  sql: postgres.Sql,
  runExecutionUnitOfWorkFactory: RunExecutionUnitOfWorkFactory
): DatasetGenerationCancellationPersistencePort => ({
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (
      unitOfWork: DatasetGenerationCancellationUnitOfWork
    ) => Promise<Value>
  ): Promise<Value> => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      return work({
        ...runExecutionUnitOfWorkFactory(transactionSql, scope),
        generationCancellationJournal: {
          find: async (
            operationScope: WorkspaceScope,
            commandKey: IdempotencyKey
          ) => {
            assertScope(scope, operationScope);
            const lockKey = [
              "dataset-generation-cancel",
              scope.workspaceId,
              commandKey,
            ].join("\u001f");
            await transactionSql`
              SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))
            `;
            const rows = await transactionSql<
              readonly {
                command_hash: string;
                generation_id: string;
                idempotency_key: string;
                requested_at: Date;
              }[]
            >`
              SELECT
                generation_id,
                idempotency_key,
                command_hash,
                requested_at
              FROM kurobara_core.dataset_generation_cancellation_journal
              WHERE workspace_id = ${scope.workspaceId}
                AND idempotency_key = ${commandKey}
            `;
            const row = rows[0];
            return row === undefined
              ? undefined
              : {
                  commandHash: contentHash(row.command_hash),
                  generationId: datasetGenerationId(row.generation_id),
                  idempotencyKey: idempotencyKey(row.idempotency_key),
                  requestedAt: instant(row.requested_at.getTime()),
                };
          },
          insert: async (
            operationScope: WorkspaceScope,
            entry: DatasetGenerationCancellationJournalEntry
          ) => {
            assertScope(scope, operationScope);
            await transactionSql`
              INSERT INTO kurobara_core.dataset_generation_cancellation_journal (
                workspace_id,
                idempotency_key,
                generation_id,
                command_hash,
                requested_at
              ) VALUES (
                ${scope.workspaceId},
                ${entry.idempotencyKey},
                ${entry.generationId},
                ${entry.commandHash},
                ${new Date(entry.requestedAt)}
              )
            `;
          },
        },
        generationPages: createPageRepository(transactionSql, scope),
        generationPlans: createPostgresDatasetGenerationPlanningUnitOfWork(
          transactionSql,
          scope
        ).generationPlans,
      });
    });
    return result as unknown as Value;
  },
});

const routeMatches = (
  plan: DatasetGenerationPlan,
  input: StepParentEffectInput
): boolean => {
  const route = plan.routeSnapshots.find(
    (candidate) => candidate.routeKey === input.attempt.routeKey
  );
  const runRoute = input.plan.routeSnapshots?.find(
    (candidate) => candidate.routeKey === input.attempt.routeKey
  );
  if (route === undefined || runRoute === undefined) {
    return false;
  }
  const routeHash = normalizedJsonEvidence(
    parseNormalizedJsonValue(
      toJsonValue({
        candidate: runRoute,
        planHash: input.plan.planHash,
        runId: input.run.runId,
        stepRunId: input.stepRun.stepRunId,
      }),
      "generationPage.routeSnapshot"
    )
  ).contentHash;
  return (
    runRoute.nodeKey === "page" &&
    route.routeKey === runRoute.routeKey &&
    route.effectAdapterKey === runRoute.effectAdapterKey &&
    route.capability.capabilityId === runRoute.capability.capabilityId &&
    route.capability.capabilityVersion ===
      runRoute.capability.capabilityVersion &&
    route.factsHash === runRoute.factsHash &&
    route.pricingVersion === runRoute.pricingVersion &&
    route.reservationUnit === runRoute.reservationUnit &&
    (runRoute.reservableUpperBound < route.reservableUpperBound ||
      amountsEqual(
        route.reservableUpperBound,
        runRoute.reservableUpperBound
      )) &&
    input.attempt.routeSnapshotHash === routeHash
  );
};

const loadDecisionAndReservation = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: StepParentEffectInput
) => {
  const rows = await sql<
    readonly { decision: unknown; reservation: unknown }[]
  >`
    SELECT decision.decision, reservation.reservation
    FROM kurobara_core.routing_decisions AS decision
    JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = decision.workspace_id
      AND reservation.attempt_id = ${input.attempt.attemptId}
      AND reservation.reservation_id = ${input.attempt.costReservationId}
    WHERE decision.workspace_id = ${scope.workspaceId}
      AND decision.run_id = ${input.run.runId}
      AND decision.step_run_id = ${input.stepRun.stepRunId}
      AND decision.routing_decision_id = ${input.attempt.routingDecisionId}
    FOR UPDATE OF reservation
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        decision: parseRoutingDecision(row.decision),
        reservation: parseCostReservation(row.reservation),
      };
};

const effectIdentityMatches = (
  page: DatasetGenerationPage,
  input: StepParentEffectInput,
  evidence: NonNullable<Awaited<ReturnType<typeof loadDecisionAndReservation>>>
): boolean => {
  const { attempt, run, stepRun } = input;
  const { decision, reservation } = evidence;
  return (
    page.runId === run.runId &&
    page.runPlanId === input.plan.runPlanId &&
    run.runPlanId === page.runPlanId &&
    run.workspaceId === page.workspaceId &&
    stepRun.runId === run.runId &&
    stepRun.nodeKey === "page" &&
    attempt.stepRunId === stepRun.stepRunId &&
    attempt.routingDecisionId === decision.routingDecisionId &&
    attempt.costReservationId === reservation.reservationId &&
    attempt.operationKey === reservation.operationKey &&
    attempt.operationKey === page.operationKey &&
    attempt.routeKey === decision.routeKey &&
    attempt.effectAdapterKey === decision.effectAdapterKey &&
    attempt.routeSnapshotHash === decision.routeSnapshotHash &&
    amountsEqual(attempt.reservedAmount, decision.reservedAmount) &&
    attempt.reservationUnit === decision.reservationUnit &&
    decision.runId === run.runId &&
    decision.stepRunId === stepRun.stepRunId &&
    reservation.state === "reserved" &&
    reservation.runId === run.runId &&
    reservation.stepRunId === stepRun.stepRunId &&
    reservation.attemptId === attempt.attemptId &&
    amountsEqual(reservation.amount, attempt.reservedAmount) &&
    reservation.unit === attempt.reservationUnit
  );
};

export const createPostgresDatasetGenerationParentEffects = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): StepParentEffectRepository => ({
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization deliberately keeps all durable identity checks inside the effect-threshold transaction.
  authorize: async (scope, input) => {
    assertScope(transactionScope, scope);
    const parent = await findGenerationPageByRun(sql, scope, input.run.runId);
    if (parent === undefined) {
      return { status: "not-parented" };
    }
    const generation = await loadPostgresDatasetGenerationForUpdate(
      sql,
      scope,
      parent.generationId
    );
    const page = await loadPageForUpdate(
      sql,
      scope,
      parent.generationId,
      parent.pageSequence
    );
    if (generation === undefined || page === undefined) {
      return {
        code: "generation-page-proof-missing",
        message: "The parent generation page lost its durable binding.",
        status: "denied",
      };
    }
    const evidence = await loadDecisionAndReservation(sql, scope, input);
    if (evidence === undefined) {
      return {
        code: "generation-page-route-proof-missing",
        message: "The generation page route or reservation is not durable.",
        status: "denied",
      };
    }
    const storedPlan = await createPostgresDatasetGenerationPlanningUnitOfWork(
      sql,
      scope
    ).generationPlans.get(scope, generation.generation.generationPlanId);
    if (
      storedPlan === undefined ||
      !routeMatches(storedPlan.plan, input) ||
      (page.state !== "run_created" && page.state !== "executing")
    ) {
      return {
        code: "generation-page-route-proof-invalid",
        message:
          "The generation page route is not the exact admitted durable route.",
        status: "denied",
      };
    }
    const started =
      page.state === "run_created"
        ? startDatasetGenerationPage(page, {
            attemptId: input.attempt.attemptId,
            costUnit: input.attempt.reservationUnit,
            operationKey: input.attempt.operationKey,
            providerKey: evidence.decision.effectAdapterKey,
            reservationId: input.attempt.costReservationId,
            reservedAmount: input.attempt.reservedAmount,
            routeKey: input.attempt.routeKey,
            routeSnapshotHash: input.attempt.routeSnapshotHash,
            routingDecisionId: input.attempt.routingDecisionId,
            stepRunId: input.stepRun.stepRunId,
          })
        : { ok: true as const, value: page };
    if (!started.ok) {
      return {
        code: started.error.code,
        message: started.error.message,
        status: "denied",
      };
    }
    const expectedPage = started.value;
    if (!effectIdentityMatches(expectedPage, input, evidence)) {
      return {
        code: "generation-page-effect-identity-invalid",
        message: "The generation page effect identity is inconsistent.",
        status: "denied",
      };
    }
    if (page.state === "executing") {
      return serializeCanonicalJson(page) ===
        serializeCanonicalJson(expectedPage)
        ? { status: "replayed" }
        : {
            code: "generation-page-effect-replay-conflict",
            message:
              "The generation page effect replay diverges from durable state.",
            status: "denied",
          };
    }
    const authorized = authorizeDatasetGenerationPageEffect(
      generation,
      storedPlan.plan,
      {
        now: input.now,
        pageSequence: page.pageSequence,
        reservedAmount: input.attempt.reservedAmount,
        unit: input.attempt.reservationUnit,
      }
    );
    if (!authorized.ok) {
      return {
        code: authorized.error.code,
        message: authorized.error.message,
        status: "denied",
      };
    }
    await updatePostgresDatasetGenerationSnapshot(sql, scope, {
      expectedGenerationVersion: generation.generation.aggregateVersion,
      expectedMaterializationRevision: generation.materialization.revision,
      value: authorized.value,
    });
    await updatePage(sql, scope, page.aggregateVersion, expectedPage);
    return { status: "authorized" };
  },
  markAmbiguous: async (scope, input) => {
    assertScope(transactionScope, scope);
    const parent = await findGenerationPageByRun(sql, scope, input.run.runId);
    if (parent === undefined) {
      return { status: "not-parented" };
    }
    const generation = await loadPostgresDatasetGenerationForUpdate(
      sql,
      scope,
      parent.generationId
    );
    const page = await loadPageForUpdate(
      sql,
      scope,
      parent.generationId,
      parent.pageSequence
    );
    if (generation === undefined || page === undefined) {
      return {
        code: "generation-page-proof-missing",
        message: "The parent generation page lost its durable binding.",
        status: "denied",
      };
    }
    if (page.state === "ambiguous") {
      return { status: "replayed" };
    }
    if (
      page.state !== "executing" ||
      page.runId !== input.run.runId ||
      page.stepRunId !== input.stepRun.stepRunId ||
      page.attemptId !== input.attempt.attemptId ||
      page.operationKey !== input.attempt.operationKey
    ) {
      return {
        code: "generation-page-ambiguity-conflict",
        message: "Only the exact executing page can become ambiguous.",
        status: "denied",
      };
    }
    const storedPlan = await createPostgresDatasetGenerationPlanningUnitOfWork(
      sql,
      scope
    ).generationPlans.get(scope, generation.generation.generationPlanId);
    if (storedPlan === undefined) {
      return {
        code: "generation-plan-not-found",
        message: "The immutable generation plan is unavailable.",
        status: "denied",
      };
    }
    const ambiguous = markDatasetGenerationAmbiguous(
      generation,
      storedPlan.plan
    );
    if (!ambiguous.ok) {
      return {
        code: ambiguous.error.code,
        message: ambiguous.error.message,
        status: "denied",
      };
    }
    const markedPage = markDatasetGenerationPageAmbiguous(page);
    if (!markedPage.ok) {
      return {
        code: markedPage.error.code,
        message: markedPage.error.message,
        status: "denied",
      };
    }
    const ambiguousPage = markedPage.value;
    await updatePostgresDatasetGenerationSnapshot(sql, scope, {
      expectedGenerationVersion: generation.generation.aggregateVersion,
      expectedMaterializationRevision: generation.materialization.revision,
      value: ambiguous.value,
    });
    await updatePage(sql, scope, page.aggregateVersion, ambiguousPage);
    return { status: "authorized" };
  },
});
