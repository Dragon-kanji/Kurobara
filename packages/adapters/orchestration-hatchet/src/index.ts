import {
  HatchetClient,
  IdempotencyCollisionError,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { StartLeafAttemptRequest, StartRunRequest } from "@kurobara/ports";

import {
  HATCHET_WORKFLOW_NAME,
  type HatchetRunInput,
  HatchetRunInputSchema,
  parseHatchetRunInput,
  toStartRunRequest,
} from "./boundary.ts";
import {
  HATCHET_LEAF_TASK_NAME,
  type HatchetLeafInput,
  HatchetLeafInputSchema,
  parseHatchetLeafInput,
  toStartLeafAttemptRequest,
} from "./leaf-boundary.ts";
import {
  createHatchetAdapterRuntime,
  type HatchetAdapterRuntime,
  type RemoteRunSummary,
} from "./runtime.ts";
import { unwrapHatchetTaskInput } from "./sdk-boundary.ts";

export type HatchetAdapterConfig = Readonly<{
  apiUrl?: string;
  hostPort?: string;
  idempotencyTtlMilliseconds: number;
  namespace?: string;
  readinessTimeoutMilliseconds: number;
  requestTimeoutMilliseconds: number;
  slots: number;
  tlsStrategy: "none" | "tls";
  token: string;
  workerName: string;
}>;

export type ExecuteKurobaraRun = (request: StartRunRequest) => Promise<void>;
export type ExecuteKurobaraAttempt = (
  request: StartLeafAttemptRequest
) => Promise<void>;

export const createHatchetLeafTaskHandler =
  (executeAttempt: ExecuteKurobaraAttempt) =>
  async (untrustedInput: unknown): Promise<{ status: "completed" }> => {
    const input = parseHatchetLeafInput(untrustedInput);
    await executeAttempt(toStartLeafAttemptRequest(input));
    return { status: "completed" };
  };

export type HatchetOrchestration = HatchetAdapterRuntime;

export class HatchetAdapterConfigurationError extends Error {
  readonly code = "hatchet-adapter-configuration-invalid";

  constructor() {
    super("Hatchet adapter configuration is invalid.");
    this.name = "HatchetAdapterConfigurationError";
  }
}

const isTrimmedWithin = (value: string, maximumLength: number): boolean =>
  value.length > 0 && value.length <= maximumLength && value === value.trim();

const assertConfiguration = (config: HatchetAdapterConfig): void => {
  const identityIsValid =
    isTrimmedWithin(config.token, 32_768) &&
    isTrimmedWithin(config.workerName, 256);
  const numericLimitsAreValid =
    Number.isSafeInteger(config.slots) &&
    config.slots >= 1 &&
    config.slots <= 10_000 &&
    Number.isSafeInteger(config.idempotencyTtlMilliseconds) &&
    config.idempotencyTtlMilliseconds >= 1 &&
    Number.isSafeInteger(config.readinessTimeoutMilliseconds) &&
    config.readinessTimeoutMilliseconds >= 1 &&
    Number.isSafeInteger(config.requestTimeoutMilliseconds) &&
    config.requestTimeoutMilliseconds >= 1;
  const endpointsAreValid =
    (config.apiUrl === undefined || isTrimmedWithin(config.apiUrl, 2048)) &&
    (config.hostPort === undefined || isTrimmedWithin(config.hostPort, 2048)) &&
    (config.namespace === undefined || isTrimmedWithin(config.namespace, 128));

  if (!(identityIsValid && numericLimitsAreValid && endpointsAreValid)) {
    throw new HatchetAdapterConfigurationError();
  }
};

export const createHatchetOrchestration = (
  config: HatchetAdapterConfig,
  execute: ExecuteKurobaraRun,
  executeAttempt: ExecuteKurobaraAttempt = () =>
    Promise.reject(
      new Error("Hatchet leaf attempt execution is not configured.")
    )
): HatchetOrchestration => {
  assertConfiguration(config);

  let client: ReturnType<typeof HatchetClient.init>;
  try {
    client = HatchetClient.init(
      {
        api_url: config.apiUrl,
        host_port: config.hostPort,
        namespace: config.namespace,
        tls_config: { tls_strategy: config.tlsStrategy },
        token: config.token,
      },
      undefined,
      { timeout: config.requestTimeoutMilliseconds }
    );
  } catch {
    throw new HatchetAdapterConfigurationError();
  }

  const task = client.task({
    fn: async (untrustedInput: HatchetRunInput) => {
      const input = parseHatchetRunInput(untrustedInput);
      await execute(toStartRunRequest(input));
      return { status: "completed" };
    },
    idempotency: {
      expression: "input.startKey",
      strategy: "ttl",
      ttlMs: config.idempotencyTtlMilliseconds,
    },
    inputValidator: HatchetRunInputSchema,
    name: HATCHET_WORKFLOW_NAME,
    retries: 0,
  });

  const leafTask = client.task<HatchetLeafInput, { status: "completed" }>({
    fn: createHatchetLeafTaskHandler(executeAttempt),
    idempotency: {
      expression: "input.startKey",
      strategy: "ttl",
      ttlMs: config.idempotencyTtlMilliseconds,
    },
    inputValidator: HatchetLeafInputSchema,
    name: HATCHET_LEAF_TASK_NAME,
    retries: 0,
  });

  return createHatchetAdapterRuntime(
    {
      classifyCollision: (error) =>
        error instanceof IdempotencyCollisionError
          ? error.existingRunExternalId
          : undefined,
      createWorker: async () => {
        const worker = await client.worker(config.workerName, {
          handleKill: false,
          slots: config.slots,
          workflows: [task, leafTask],
        });
        return {
          start: () => worker.start(),
          stop: () => worker.stop(),
          waitUntilReady: (timeoutMilliseconds) =>
            worker.waitUntilReady(timeoutMilliseconds),
        };
      },
      findRuns: async (input): Promise<readonly RemoteRunSummary[]> => {
        const result = await client.runs.list({
          additionalMetadata: input.additionalMetadata,
          includePayloads: true,
          limit: input.limit,
          onlyTasks: true,
          since: input.since,
          workflowNames: [input.workflowName],
        });
        return result.rows.map((row) => ({
          input: unwrapHatchetTaskInput(row.input),
          metadata: row.additionalMetadata,
          orchestrationRunId: row.metadata.id,
        }));
      },
      startLeafRemote: async ({ additionalMetadata, request }) => {
        const reference = await leafTask.runNoWait(request, {
          additionalMetadata,
        });
        return reference.runId;
      },
      startRemote: async ({ additionalMetadata, request }) => {
        const reference = await task.runNoWait(request, {
          additionalMetadata,
        });
        return reference.runId;
      },
    },
    { readinessTimeoutMilliseconds: config.readinessTimeoutMilliseconds }
  );
};
