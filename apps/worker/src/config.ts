export type WorkerEnvironment = "development" | "production" | "test";

export type WorkerMigrationMode = "apply" | "verify";

export type HatchetWorkerConfig = Readonly<{
  apiUrl: string;
  hostPort: string;
  idempotencyTtlMilliseconds: number;
  namespace: string;
  slots: number;
  tlsStrategy: "none" | "tls";
  token: string;
  workerId: string;
}>;

export type OutboxDispatcherConfig = Readonly<{
  claimLeaseMs: number;
  dispatcherId: string;
  maxAttempts: number;
  pollIntervalMs: number;
  retryDelayMs: number;
}>;

export type DagSchedulerConfig = Readonly<{
  pollIntervalMs: number;
}>;

export type DatasetGenerationSchedulerConfig = Readonly<{
  claimLeaseMs: number;
  pollIntervalMs: number;
  schedulerId: string;
}>;

export type RouteSchedulerConfig = Readonly<{
  pollIntervalMs: number;
  retryDelayMs: number;
  schedulerId: string;
}>;

export type LeafEffectAdapter = "configured-providers" | "deterministic-local";

export type RunOrchestrationReconcilerConfig = Readonly<{
  batchSize: number;
  claimLeaseMs: number;
  lookupTimeoutMs: number;
  maxAttempts: number;
  operatorId: string;
  pollIntervalMs: number;
  retryDelayMs: number;
}>;

export type LeafEffectReconcilerConfig = Readonly<{
  batchSize: number;
  claimLeaseMs: number;
  initialDelayMs: number;
  maxAttempts: number;
  operationTimeoutMs: number;
  operatorId: string;
  pollIntervalMs: number;
  retryDelayMs: number;
}>;

export type WorkerProcessConfig = Readonly<{
  dagScheduler: DagSchedulerConfig;
  databaseUrl: string;
  datasetGenerationScheduler: DatasetGenerationSchedulerConfig;
  dispatcher: OutboxDispatcherConfig;
  environment: WorkerEnvironment;
  hatchet: HatchetWorkerConfig;
  leafDispatcher: OutboxDispatcherConfig;
  leafEffectAdapter: LeafEffectAdapter;
  leafEffectReconciler: LeafEffectReconcilerConfig;
  migrationMode: WorkerMigrationMode;
  readinessTimeoutMs: number;
  reconciler: RunOrchestrationReconcilerConfig;
  routeScheduler: RouteSchedulerConfig;
  shutdownTimeoutMs: number;
}>;

export class WorkerConfigError extends Error {
  readonly name = "WorkerConfigError";
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const PROCESS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const parseEnvironment = (rawValue: string | undefined): WorkerEnvironment => {
  const value = rawValue ?? "development";
  if (value === "development" || value === "production" || value === "test") {
    return value;
  }
  throw new WorkerConfigError(
    "NODE_ENV must be one of development, production, or test."
  );
};

const parseBoundedInteger = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: string,
  maximum: number
): number => {
  const rawValue = environment[name] ?? defaultValue;
  if (!POSITIVE_INTEGER.test(rawValue)) {
    throw new WorkerConfigError(`${name} must be a positive integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new WorkerConfigError(`${name} must be at most ${maximum}.`);
  }
  return value;
};

const required = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumLength: number
): string => {
  const value = environment[name];
  if (
    value === undefined ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new WorkerConfigError(
      `${name} must be configured without surrounding whitespace and contain at most ${maximumLength} characters.`
    );
  }
  return value;
};

const parseDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const value = required(environment, "KUROBARA_DATABASE_URL", 4096);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new WorkerConfigError(
      "KUROBARA_DATABASE_URL must be a valid PostgreSQL URL."
    );
  }
  return value;
};

const parseHttpUrl = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string => {
  const value = required(environment, name, 2048);
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error("unsupported URL");
    }
  } catch {
    throw new WorkerConfigError(
      `${name} must be an HTTP(S) URL without embedded credentials or a fragment.`
    );
  }
  return value;
};

const parseProcessId = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string => {
  const value = required(environment, name, 128);
  if (!PROCESS_ID.test(value)) {
    throw new WorkerConfigError(
      `${name} must use only letters, digits, dot, underscore, colon, or hyphen.`
    );
  }
  return value;
};

const parseDatasetGenerationSchedulerId = (
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const value =
    environment.KUROBARA_DATASET_GENERATION_SCHEDULER_ID ??
    `${required(environment, "KUROBARA_WORKER_ID", 128)}:dataset-generation`;
  if (value.length > 128 || !PROCESS_ID.test(value)) {
    throw new WorkerConfigError(
      "KUROBARA_DATASET_GENERATION_SCHEDULER_ID must use at most 128 letters, digits, dot, underscore, colon, or hyphen."
    );
  }
  return value;
};

const parseNamespace = (
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const value = required(environment, "HATCHET_CLIENT_NAMESPACE", 64);
  if (!NAMESPACE.test(value)) {
    throw new WorkerConfigError(
      "HATCHET_CLIENT_NAMESPACE must use only letters, digits, underscore, or hyphen."
    );
  }
  return value;
};

const parseTlsStrategy = (
  environment: Readonly<Record<string, string | undefined>>
): HatchetWorkerConfig["tlsStrategy"] => {
  const value = required(environment, "HATCHET_CLIENT_TLS_STRATEGY", 16);
  if (value === "none" || value === "tls") {
    return value;
  }
  throw new WorkerConfigError(
    "HATCHET_CLIENT_TLS_STRATEGY must be none or tls."
  );
};

const parseMigrationMode = (
  environment: Readonly<Record<string, string | undefined>>,
  runtimeEnvironment: WorkerEnvironment
): WorkerMigrationMode => {
  const value =
    environment.KUROBARA_DATABASE_MIGRATION_MODE ??
    (runtimeEnvironment === "production" ? "verify" : "apply");
  if (value === "apply" || value === "verify") {
    return value;
  }
  throw new WorkerConfigError(
    "KUROBARA_DATABASE_MIGRATION_MODE must be apply or verify."
  );
};

const parseLeafEffectAdapter = (
  environment: Readonly<Record<string, string | undefined>>
): LeafEffectAdapter => {
  const value = required(environment, "KUROBARA_LEAF_EFFECT_ADAPTER", 64);
  if (value === "configured-providers" || value === "deterministic-local") {
    return value;
  }
  throw new WorkerConfigError(
    "KUROBARA_LEAF_EFFECT_ADAPTER must be configured-providers or deterministic-local."
  );
};

export const parseWorkerProcessConfig = (
  environment: Readonly<Record<string, string | undefined>>
): WorkerProcessConfig => {
  const runtimeEnvironment = parseEnvironment(environment.NODE_ENV);
  const reconcilerClaimLeaseMs = parseBoundedInteger(
    environment,
    "KUROBARA_RECONCILER_CLAIM_LEASE_MS",
    "30000",
    300_000
  );
  const reconcilerLookupTimeoutMs = parseBoundedInteger(
    environment,
    "KUROBARA_RECONCILER_LOOKUP_TIMEOUT_MS",
    "10000",
    150_000
  );
  if (reconcilerLookupTimeoutMs * 2 > reconcilerClaimLeaseMs) {
    throw new WorkerConfigError(
      "KUROBARA_RECONCILER_LOOKUP_TIMEOUT_MS must be no greater than half of KUROBARA_RECONCILER_CLAIM_LEASE_MS."
    );
  }
  const leafEffectReconcilerClaimLeaseMs = parseBoundedInteger(
    environment,
    "KUROBARA_LEAF_EFFECT_RECONCILER_CLAIM_LEASE_MS",
    "30000",
    300_000
  );
  const leafEffectReconcilerOperationTimeoutMs = parseBoundedInteger(
    environment,
    "KUROBARA_LEAF_EFFECT_RECONCILER_OPERATION_TIMEOUT_MS",
    "10000",
    150_000
  );
  if (
    leafEffectReconcilerOperationTimeoutMs * 2 >
    leafEffectReconcilerClaimLeaseMs
  ) {
    throw new WorkerConfigError(
      "KUROBARA_LEAF_EFFECT_RECONCILER_OPERATION_TIMEOUT_MS must be no greater than half of KUROBARA_LEAF_EFFECT_RECONCILER_CLAIM_LEASE_MS."
    );
  }
  const shutdownTimeoutMs = parseBoundedInteger(
    environment,
    "KUROBARA_SHUTDOWN_TIMEOUT_MS",
    "10000",
    120_000
  );
  if (shutdownTimeoutMs < 1000) {
    throw new WorkerConfigError(
      "KUROBARA_SHUTDOWN_TIMEOUT_MS must be at least 1000."
    );
  }
  return {
    dagScheduler: {
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS",
        "250",
        60_000
      ),
    },
    databaseUrl: parseDatabaseUrl(environment),
    datasetGenerationScheduler: {
      claimLeaseMs: parseBoundedInteger(
        environment,
        "KUROBARA_DATASET_GENERATION_CLAIM_LEASE_MS",
        "30000",
        300_000
      ),
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_DATASET_GENERATION_POLL_INTERVAL_MS",
        "250",
        60_000
      ),
      schedulerId: parseDatasetGenerationSchedulerId(environment),
    },
    dispatcher: {
      claimLeaseMs: parseBoundedInteger(
        environment,
        "KUROBARA_OUTBOX_CLAIM_LEASE_MS",
        "30000",
        300_000
      ),
      dispatcherId: parseProcessId(environment, "KUROBARA_DISPATCHER_ID"),
      maxAttempts: parseBoundedInteger(
        environment,
        "KUROBARA_OUTBOX_MAX_ATTEMPTS",
        "10",
        100
      ),
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_OUTBOX_POLL_INTERVAL_MS",
        "250",
        60_000
      ),
      retryDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_OUTBOX_RETRY_DELAY_MS",
        "5000",
        3_600_000
      ),
    },
    environment: runtimeEnvironment,
    hatchet: {
      apiUrl: parseHttpUrl(environment, "HATCHET_CLIENT_API_URL"),
      hostPort: required(environment, "HATCHET_CLIENT_HOST_PORT", 255),
      idempotencyTtlMilliseconds: parseBoundedInteger(
        environment,
        "KUROBARA_HATCHET_IDEMPOTENCY_TTL_MS",
        "86400000",
        604_800_000
      ),
      namespace: parseNamespace(environment),
      slots: parseBoundedInteger(
        environment,
        "KUROBARA_HATCHET_WORKER_SLOTS",
        "8",
        10_000
      ),
      tlsStrategy: parseTlsStrategy(environment),
      token: required(environment, "HATCHET_CLIENT_TOKEN", 8192),
      workerId: parseProcessId(environment, "KUROBARA_WORKER_ID"),
    },
    leafDispatcher: {
      claimLeaseMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_OUTBOX_CLAIM_LEASE_MS",
        "30000",
        300_000
      ),
      dispatcherId: parseProcessId(environment, "KUROBARA_LEAF_DISPATCHER_ID"),
      maxAttempts: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_OUTBOX_MAX_ATTEMPTS",
        "10",
        100
      ),
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_OUTBOX_POLL_INTERVAL_MS",
        "250",
        60_000
      ),
      retryDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_OUTBOX_RETRY_DELAY_MS",
        "5000",
        3_600_000
      ),
    },
    leafEffectAdapter: parseLeafEffectAdapter(environment),
    leafEffectReconciler: {
      batchSize: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_BATCH_SIZE",
        "10",
        100
      ),
      claimLeaseMs: leafEffectReconcilerClaimLeaseMs,
      initialDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_INITIAL_DELAY_MS",
        "60000",
        3_600_000
      ),
      maxAttempts: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_MAX_ATTEMPTS",
        "10",
        100
      ),
      operationTimeoutMs: leafEffectReconcilerOperationTimeoutMs,
      operatorId: parseProcessId(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_ID"
      ),
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_POLL_INTERVAL_MS",
        "5000",
        60_000
      ),
      retryDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_LEAF_EFFECT_RECONCILER_RETRY_DELAY_MS",
        "60000",
        86_400_000
      ),
    },
    migrationMode: parseMigrationMode(environment, runtimeEnvironment),
    readinessTimeoutMs: parseBoundedInteger(
      environment,
      "KUROBARA_WORKER_READINESS_TIMEOUT_MS",
      "15000",
      120_000
    ),
    reconciler: {
      batchSize: parseBoundedInteger(
        environment,
        "KUROBARA_RECONCILER_BATCH_SIZE",
        "10",
        100
      ),
      claimLeaseMs: reconcilerClaimLeaseMs,
      lookupTimeoutMs: reconcilerLookupTimeoutMs,
      maxAttempts: parseBoundedInteger(
        environment,
        "KUROBARA_RECONCILER_MAX_ATTEMPTS",
        "10",
        100
      ),
      operatorId: parseProcessId(environment, "KUROBARA_RECONCILER_ID"),
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_RECONCILER_POLL_INTERVAL_MS",
        "5000",
        60_000
      ),
      retryDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_RECONCILER_RETRY_DELAY_MS",
        "60000",
        86_400_000
      ),
    },
    routeScheduler: {
      pollIntervalMs: parseBoundedInteger(
        environment,
        "KUROBARA_ROUTE_SCHEDULER_POLL_INTERVAL_MS",
        "250",
        60_000
      ),
      retryDelayMs: parseBoundedInteger(
        environment,
        "KUROBARA_ROUTE_SCHEDULER_RETRY_DELAY_MS",
        "5000",
        86_400_000
      ),
      schedulerId: parseProcessId(environment, "KUROBARA_ROUTE_SCHEDULER_ID"),
    },
    shutdownTimeoutMs,
  };
};
