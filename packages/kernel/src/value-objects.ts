type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
};

export type ActorId = Brand<string, "ActorId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type AttemptId = Brand<string, "AttemptId">;
export type CapabilityId = Brand<string, "CapabilityId">;
export type CellResultId = Brand<string, "CellResultId">;
export type CostReservationId = Brand<string, "CostReservationId">;
export type ContentHash = Brand<string, "ContentHash">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type DatasetId = Brand<string, "DatasetId">;
export type DatasetGenerationId = Brand<string, "DatasetGenerationId">;
export type DatasetGenerationPlanId = Brand<string, "DatasetGenerationPlanId">;
export type DatasetMaterializationId = Brand<
  string,
  "DatasetMaterializationId"
>;
export type EnrichmentRecipeId = Brand<string, "EnrichmentRecipeId">;
export type EventId = Brand<string, "EventId">;
export type FieldId = Brand<string, "FieldId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type Instant = Brand<number, "Instant">;
export type OperationKey = Brand<string, "OperationKey">;
export type OutboxMessageId = Brand<string, "OutboxMessageId">;
export type RecordId = Brand<string, "RecordId">;
export type RoutingDecisionId = Brand<string, "RoutingDecisionId">;
export type ResultManifestId = Brand<string, "ResultManifestId">;
export type RunId = Brand<string, "RunId">;
export type RunPlanId = Brand<string, "RunPlanId">;
export type StepRunId = Brand<string, "StepRunId">;
export type UsageEntryId = Brand<string, "UsageEntryId">;
export type WorkflowSpecId = Brand<string, "WorkflowSpecId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;

export class InvalidValueObjectError extends Error {
  readonly code = "invalid-value-object";
  readonly valueObject: string;

  constructor(valueObject: string, message: string) {
    super(`${valueObject}: ${message}`);
    this.name = "InvalidValueObjectError";
    this.valueObject = valueObject;
  }
}

const nonEmpty = <Name extends string>(
  value: string,
  name: Name
): Brand<string, Name> => {
  if (value.trim().length === 0) {
    throw new InvalidValueObjectError(name, "must not be empty");
  }

  return value as Brand<string, Name>;
};

const boundedProductIdentity = <Name extends string>(
  value: string,
  name: Name
): Brand<string, Name> => {
  const identity = nonEmpty(value, name);
  if (codePointLength(value) > 255) {
    throw new InvalidValueObjectError(name, "must not exceed 255 characters");
  }
  return identity;
};

export const actorId = (value: string): ActorId => nonEmpty(value, "ActorId");
export const artifactId = (value: string): ArtifactId =>
  nonEmpty(value, "ArtifactId");
export const attemptId = (value: string): AttemptId =>
  nonEmpty(value, "AttemptId");
export const capabilityId = (value: string): CapabilityId =>
  nonEmpty(value, "CapabilityId");
export const cellResultId = (value: string): CellResultId =>
  boundedProductIdentity(value, "CellResultId");
export const costReservationId = (value: string): CostReservationId =>
  nonEmpty(value, "CostReservationId");
export const correlationId = (value: string): CorrelationId =>
  nonEmpty(value, "CorrelationId");
export const datasetId = (value: string): DatasetId =>
  boundedProductIdentity(value, "DatasetId");
export const datasetGenerationId = (value: string): DatasetGenerationId =>
  boundedProductIdentity(value, "DatasetGenerationId");
export const datasetGenerationPlanId = (
  value: string
): DatasetGenerationPlanId =>
  boundedProductIdentity(value, "DatasetGenerationPlanId");
export const datasetMaterializationId = (
  value: string
): DatasetMaterializationId =>
  boundedProductIdentity(value, "DatasetMaterializationId");
export const enrichmentRecipeId = (value: string): EnrichmentRecipeId =>
  boundedProductIdentity(value, "EnrichmentRecipeId");
export const eventId = (value: string): EventId => nonEmpty(value, "EventId");
export const fieldId = (value: string): FieldId =>
  boundedProductIdentity(value, "FieldId");
export const idempotencyKey = (value: string): IdempotencyKey =>
  nonEmpty(value, "IdempotencyKey");
export const operationKey = (value: string): OperationKey =>
  nonEmpty(value, "OperationKey");
export const outboxMessageId = (value: string): OutboxMessageId =>
  nonEmpty(value, "OutboxMessageId");
export const recordId = (value: string): RecordId =>
  boundedProductIdentity(value, "RecordId");
export const routingDecisionId = (value: string): RoutingDecisionId =>
  nonEmpty(value, "RoutingDecisionId");
export const resultManifestId = (value: string): ResultManifestId =>
  nonEmpty(value, "ResultManifestId");
export const runId = (value: string): RunId => nonEmpty(value, "RunId");
export const runPlanId = (value: string): RunPlanId =>
  nonEmpty(value, "RunPlanId");
export const stepRunId = (value: string): StepRunId =>
  nonEmpty(value, "StepRunId");
export const usageEntryId = (value: string): UsageEntryId =>
  nonEmpty(value, "UsageEntryId");
export const workflowSpecId = (value: string): WorkflowSpecId =>
  nonEmpty(value, "WorkflowSpecId");
export const workspaceId = (value: string): WorkspaceId =>
  nonEmpty(value, "WorkspaceId");

export const contentHash = (value: string): ContentHash => {
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw new InvalidValueObjectError(
      "ContentHash",
      "must use the form sha256:<64 lowercase hexadecimal characters>"
    );
  }

  return value as ContentHash;
};

export const instant = (epochMilliseconds: number): Instant => {
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new InvalidValueObjectError(
      "Instant",
      "must be a non-negative safe integer in Unix epoch milliseconds"
    );
  }

  return epochMilliseconds as Instant;
};
