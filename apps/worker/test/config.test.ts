import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkerProcessConfig, WorkerConfigError } from "../src/config.ts";

const TOKEN_PATTERN = /synthetic-token/u;

const validEnvironment = (): Record<string, string | undefined> => ({
  HATCHET_CLIENT_API_URL: "http://127.0.0.1:8080",
  HATCHET_CLIENT_HOST_PORT: "127.0.0.1:7070",
  HATCHET_CLIENT_NAMESPACE: "kurobara-test",
  HATCHET_CLIENT_TLS_STRATEGY: "none",
  HATCHET_CLIENT_TOKEN: "synthetic-token",
  KUROBARA_DATABASE_URL: "postgres://local@127.0.0.1:5432/kurobara",
  KUROBARA_DISPATCHER_ID: "dispatcher-test",
  KUROBARA_LEAF_DISPATCHER_ID: "leaf-dispatcher-test",
  KUROBARA_LEAF_EFFECT_ADAPTER: "deterministic-local",
  KUROBARA_LEAF_EFFECT_RECONCILER_ID: "effect-reconciler-test",
  KUROBARA_RECONCILER_ID: "reconciler-test",
  KUROBARA_ROUTE_SCHEDULER_ID: "route-scheduler-test",
  KUROBARA_WORKER_ID: "worker-test",
  NODE_ENV: "test",
});

test("parses a complete bounded worker configuration", () => {
  assert.deepEqual(parseWorkerProcessConfig(validEnvironment()), {
    dagScheduler: {
      pollIntervalMs: 250,
    },
    databaseUrl: "postgres://local@127.0.0.1:5432/kurobara",
    datasetGenerationScheduler: {
      claimLeaseMs: 30_000,
      pollIntervalMs: 250,
      schedulerId: "worker-test:dataset-generation",
    },
    dispatcher: {
      claimLeaseMs: 30_000,
      dispatcherId: "dispatcher-test",
      maxAttempts: 10,
      pollIntervalMs: 250,
      retryDelayMs: 5000,
    },
    environment: "test",
    hatchet: {
      apiUrl: "http://127.0.0.1:8080",
      hostPort: "127.0.0.1:7070",
      idempotencyTtlMilliseconds: 86_400_000,
      namespace: "kurobara-test",
      slots: 8,
      tlsStrategy: "none",
      token: "synthetic-token",
      workerId: "worker-test",
    },
    leafDispatcher: {
      claimLeaseMs: 30_000,
      dispatcherId: "leaf-dispatcher-test",
      maxAttempts: 10,
      pollIntervalMs: 250,
      retryDelayMs: 5000,
    },
    leafEffectAdapter: "deterministic-local",
    leafEffectReconciler: {
      batchSize: 10,
      claimLeaseMs: 30_000,
      initialDelayMs: 60_000,
      maxAttempts: 10,
      operationTimeoutMs: 10_000,
      operatorId: "effect-reconciler-test",
      pollIntervalMs: 5000,
      retryDelayMs: 60_000,
    },
    migrationMode: "apply",
    readinessTimeoutMs: 15_000,
    reconciler: {
      batchSize: 10,
      claimLeaseMs: 30_000,
      lookupTimeoutMs: 10_000,
      maxAttempts: 10,
      operatorId: "reconciler-test",
      pollIntervalMs: 5000,
      retryDelayMs: 60_000,
    },
    routeScheduler: {
      pollIntervalMs: 250,
      retryDelayMs: 5000,
      schedulerId: "route-scheduler-test",
    },
    shutdownTimeoutMs: 10_000,
  });
});

test("defaults production to migration verification", () => {
  const environment = validEnvironment();
  environment.NODE_ENV = "production";

  assert.equal(parseWorkerProcessConfig(environment).migrationMode, "verify");
});

test("rejects missing Hatchet credentials without echoing a secret", () => {
  const environment = validEnvironment();
  environment.HATCHET_CLIENT_TOKEN = undefined;

  assert.throws(
    () => parseWorkerProcessConfig(environment),
    (error: unknown) => {
      assert.equal(error instanceof WorkerConfigError, true);
      assert.doesNotMatch(String(error), TOKEN_PATTERN);
      return true;
    }
  );
});

test("rejects invalid and excessive dispatcher limits", () => {
  const invalid = validEnvironment();
  invalid.KUROBARA_OUTBOX_MAX_ATTEMPTS = "0";
  assert.throws(() => parseWorkerProcessConfig(invalid), WorkerConfigError);

  const excessive = validEnvironment();
  excessive.KUROBARA_OUTBOX_CLAIM_LEASE_MS = "300001";
  assert.throws(() => parseWorkerProcessConfig(excessive), WorkerConfigError);
});

test("rejects invalid and excessive DAG scheduler limits", () => {
  const invalid = validEnvironment();
  invalid.KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS = "0";
  assert.throws(() => parseWorkerProcessConfig(invalid), WorkerConfigError);

  const excessive = validEnvironment();
  excessive.KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS = "60001";
  assert.throws(() => parseWorkerProcessConfig(excessive), WorkerConfigError);
});

test("bounds dataset generation scheduler leases, polling, and identity", () => {
  const invalidLease = validEnvironment();
  invalidLease.KUROBARA_DATASET_GENERATION_CLAIM_LEASE_MS = "0";
  assert.throws(
    () => parseWorkerProcessConfig(invalidLease),
    WorkerConfigError
  );

  const invalidPoll = validEnvironment();
  invalidPoll.KUROBARA_DATASET_GENERATION_POLL_INTERVAL_MS = "60001";
  assert.throws(() => parseWorkerProcessConfig(invalidPoll), WorkerConfigError);

  const invalidIdentity = validEnvironment();
  invalidIdentity.KUROBARA_DATASET_GENERATION_SCHEDULER_ID = "bad identity";
  assert.throws(
    () => parseWorkerProcessConfig(invalidIdentity),
    WorkerConfigError
  );
});

test("requires a bounded route scheduler identity and timing", () => {
  const missingId = validEnvironment();
  missingId.KUROBARA_ROUTE_SCHEDULER_ID = undefined;
  assert.throws(() => parseWorkerProcessConfig(missingId), WorkerConfigError);

  const invalidPoll = validEnvironment();
  invalidPoll.KUROBARA_ROUTE_SCHEDULER_POLL_INTERVAL_MS = "0";
  assert.throws(() => parseWorkerProcessConfig(invalidPoll), WorkerConfigError);

  const excessiveRetry = validEnvironment();
  excessiveRetry.KUROBARA_ROUTE_SCHEDULER_RETRY_DELAY_MS = "86400001";
  assert.throws(
    () => parseWorkerProcessConfig(excessiveRetry),
    WorkerConfigError
  );
});

test("requires an explicit supported leaf effect adapter", () => {
  const missing = validEnvironment();
  missing.KUROBARA_LEAF_EFFECT_ADAPTER = undefined;
  assert.throws(() => parseWorkerProcessConfig(missing), WorkerConfigError);

  const unsupported = validEnvironment();
  unsupported.KUROBARA_LEAF_EFFECT_ADAPTER = "provider-not-installed";
  assert.throws(() => parseWorkerProcessConfig(unsupported), WorkerConfigError);
});

test("admits configured providers without retaining credentials", () => {
  const environment = {
    ...validEnvironment(),
    EXA_API_KEY: "synthetic-provider-secret",
    KUROBARA_LEAF_EFFECT_ADAPTER: "configured-providers",
  };

  const parsed = parseWorkerProcessConfig(environment);

  assert.equal(parsed.leafEffectAdapter, "configured-providers");
  assert.equal(JSON.stringify(parsed).includes(environment.EXA_API_KEY), false);
});

test("rejects invalid and excessive reconciler limits", () => {
  const invalid = validEnvironment();
  invalid.KUROBARA_RECONCILER_BATCH_SIZE = "0";
  assert.throws(() => parseWorkerProcessConfig(invalid), WorkerConfigError);

  const excessive = validEnvironment();
  excessive.KUROBARA_RECONCILER_RETRY_DELAY_MS = "86400001";
  assert.throws(() => parseWorkerProcessConfig(excessive), WorkerConfigError);

  const unsafeLeaseMargin = validEnvironment();
  unsafeLeaseMargin.KUROBARA_RECONCILER_LOOKUP_TIMEOUT_MS = "15001";
  assert.throws(
    () => parseWorkerProcessConfig(unsafeLeaseMargin),
    WorkerConfigError
  );

  const unsafeShutdownBudget = validEnvironment();
  unsafeShutdownBudget.KUROBARA_SHUTDOWN_TIMEOUT_MS = "999";
  assert.throws(
    () => parseWorkerProcessConfig(unsafeShutdownBudget),
    WorkerConfigError
  );
});

test("rejects an unsafe leaf effect recovery timeout", () => {
  const environment = validEnvironment();
  environment.KUROBARA_LEAF_EFFECT_RECONCILER_OPERATION_TIMEOUT_MS = "15001";

  assert.throws(() => parseWorkerProcessConfig(environment), WorkerConfigError);
});

test("rejects URLs with the wrong protocol or embedded credentials", () => {
  const database = validEnvironment();
  database.KUROBARA_DATABASE_URL = "https://example.invalid/db";
  assert.throws(() => parseWorkerProcessConfig(database), WorkerConfigError);

  const hatchet = validEnvironment();
  hatchet.HATCHET_CLIENT_API_URL = "https://user:secret@example.invalid";
  assert.throws(() => parseWorkerProcessConfig(hatchet), WorkerConfigError);
});
