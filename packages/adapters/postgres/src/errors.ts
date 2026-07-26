export class PostgresAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "PostgresAdapterError";
  }
}

export class DatabasePayloadError extends PostgresAdapterError {
  constructor(message: string) {
    super("database-payload-invalid", message);
    this.name = "DatabasePayloadError";
  }
}

export class ImmutableRecordConflictError extends PostgresAdapterError {
  constructor(record: string) {
    super(
      "immutable-record-conflict",
      `The stored ${record} conflicts with the immutable input.`
    );
    this.name = "ImmutableRecordConflictError";
  }
}

export class PlanningDefaultsConflictError extends PostgresAdapterError {
  constructor(expectedRevision: number | null, actualRevision: number | null) {
    super(
      "planning-defaults-conflict",
      `Planning defaults revision conflict: expected ${expectedRevision ?? "none"}, found ${actualRevision ?? "none"}.`
    );
    this.name = "PlanningDefaultsConflictError";
  }
}

export class OutboxLeaseConflictError extends PostgresAdapterError {
  constructor(messageId: string) {
    super(
      "outbox-lease-conflict",
      `Outbox message ${messageId} is no longer claimed by this worker.`
    );
    this.name = "OutboxLeaseConflictError";
  }
}

export class OrchestrationBindingConflictError extends PostgresAdapterError {
  constructor(messageId: string) {
    super(
      "orchestration-binding-conflict",
      `The orchestration binding for outbox message ${messageId} cannot perform that transition.`
    );
    this.name = "OrchestrationBindingConflictError";
  }
}

export class RunAggregateConflictError extends PostgresAdapterError {
  constructor(runId: string) {
    super(
      "run-aggregate-conflict",
      `Run ${runId} no longer has the expected aggregate version.`
    );
    this.name = "RunAggregateConflictError";
  }
}
