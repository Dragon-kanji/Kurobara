import type {
  LeafOrchestrationPort,
  OrchestrationPort,
  StartLeafAttemptRequest,
  StartRunRequest,
} from "@kurobara/ports";

import {
  HATCHET_WORKFLOW_NAME,
  type HatchetRunInput,
  inputMatches,
  metadataFor,
  metadataMatches,
  toHatchetRunInput,
} from "./boundary.ts";
import {
  HATCHET_LEAF_TASK_NAME,
  type HatchetLeafInput,
  leafInputMatches,
  leafMetadataFor,
  leafMetadataMatches,
  toHatchetLeafInput,
} from "./leaf-boundary.ts";

type StartRunResult = Awaited<ReturnType<OrchestrationPort["startRun"]>>;
type FindRunResult = Awaited<
  ReturnType<OrchestrationPort["findRunByStartKey"]>
>;
type StartLeafResult = Awaited<
  ReturnType<LeafOrchestrationPort["startAttempt"]>
>;
type FindLeafResult = Awaited<
  ReturnType<LeafOrchestrationPort["findAttemptByStartKey"]>
>;

export type RemoteRunSummary = Readonly<{
  input: unknown;
  metadata: unknown;
  orchestrationRunId: string;
}>;

export type HatchetWorkerHandle = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilReady(timeoutMilliseconds?: number): Promise<void>;
}>;

export type HatchetRuntimeDependencies = Readonly<{
  classifyCollision(error: unknown): string | undefined;
  createWorker(): Promise<HatchetWorkerHandle>;
  findRuns(input: {
    additionalMetadata: Readonly<Record<string, string>>;
    limit: number;
    since: Date;
    workflowName: string;
  }): Promise<readonly RemoteRunSummary[]>;
  startRemote(input: {
    additionalMetadata: Readonly<Record<string, string>>;
    request: HatchetRunInput;
  }): Promise<string>;
  startLeafRemote(input: {
    additionalMetadata: Readonly<Record<string, string>>;
    request: HatchetLeafInput;
  }): Promise<string>;
}>;

export type HatchetWorkerService = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilReady(timeoutMilliseconds?: number): Promise<void>;
  waitForFailure(): Promise<never>;
}>;

export type HatchetAdapterRuntime = Readonly<{
  leafPort: LeafOrchestrationPort;
  port: OrchestrationPort;
  worker: HatchetWorkerService;
}>;

export type HatchetAdapterRuntimeOptions = Readonly<{
  readinessTimeoutMilliseconds: number;
}>;

const isUsableRunId = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= 256 &&
  value === value.trim();

const rejectedStart = (): StartRunResult => ({
  reason: "invalid-orchestration-request",
  retryable: false,
  status: "definitely-rejected",
});

const unknownStart = (): StartRunResult => ({
  reason: "hatchet-start-outcome-unknown",
  status: "outcome-unknown",
});

const unknownLookup = (
  reason = "hatchet-lookup-outcome-unknown"
): FindRunResult => ({ reason, status: "outcome-unknown" });

const rejectedLeafStart = (): StartLeafResult => ({
  reason: "invalid-leaf-orchestration-request",
  retryable: false,
  status: "definitely-rejected",
});

const unknownLeafStart = (): StartLeafResult => ({
  reason: "hatchet-leaf-start-outcome-unknown",
  status: "outcome-unknown",
});

const unknownLeafLookup = (
  reason = "hatchet-leaf-lookup-outcome-unknown"
): FindLeafResult => ({ reason, status: "outcome-unknown" });

export const createHatchetAdapterRuntime = (
  dependencies: HatchetRuntimeDependencies,
  options: HatchetAdapterRuntimeOptions
): HatchetAdapterRuntime => {
  let workerPromise: Promise<HatchetWorkerHandle> | undefined;
  let startupPromise: Promise<void> | undefined;
  let workerRunPromise: Promise<void> | undefined;
  let workerRunFailed = false;
  let rejectFailure: (error: unknown) => void = () => undefined;
  let stopping = false;
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failurePromise.catch(() => undefined);

  const getWorker = (): Promise<HatchetWorkerHandle> => {
    workerPromise ??= dependencies.createWorker();
    return workerPromise;
  };

  const monitorWorkerRun = async (run: Promise<void>): Promise<void> => {
    try {
      await run;
    } catch {
      // The lifecycle reports both unexpected resolution and rejection alike.
    }
    if (!stopping) {
      workerRunFailed = true;
      rejectFailure(new Error("Hatchet worker exited unexpectedly."));
    }
  };

  const startWorker = async (): Promise<void> => {
    try {
      const handle = await getWorker();
      workerRunPromise = handle.start();
      monitorWorkerRun(workerRunPromise).catch(() => undefined);
      await handle.waitUntilReady(options.readinessTimeoutMilliseconds);
      if (workerRunFailed) {
        throw new Error("Hatchet worker failed during startup.");
      }
    } catch {
      throw new Error("Hatchet worker failed during startup.");
    }
  };

  const worker: HatchetWorkerService = {
    start: () => {
      startupPromise ??= startWorker();
      return startupPromise;
    },
    stop: async () => {
      if (workerPromise === undefined) {
        return;
      }
      stopping = true;
      try {
        const handle = await workerPromise;
        await handle.stop();
        if (workerRunPromise !== undefined) {
          await workerRunPromise;
        }
      } catch {
        throw new Error("Hatchet worker failed during shutdown.");
      }
      if (workerRunFailed) {
        throw new Error("Hatchet worker exited unexpectedly.");
      }
    },
    waitForFailure: () => failurePromise,
    waitUntilReady: async (timeoutMilliseconds) => {
      if (startupPromise === undefined) {
        throw new Error("Hatchet worker has not been started.");
      }
      const handle = await getWorker();
      try {
        await handle.waitUntilReady(
          timeoutMilliseconds ?? options.readinessTimeoutMilliseconds
        );
        if (workerRunFailed) {
          throw new Error("Hatchet worker exited unexpectedly.");
        }
      } catch {
        throw new Error("Hatchet worker readiness check failed.");
      }
    },
  };

  const findRunByStartKey = async (
    request: StartRunRequest
  ): Promise<FindRunResult> => {
    let input: HatchetRunInput;
    try {
      input = toHatchetRunInput(request);
    } catch {
      return unknownLookup("invalid-orchestration-request");
    }

    const expectedMetadata = metadataFor(input);
    let rows: readonly RemoteRunSummary[];
    try {
      rows = await dependencies.findRuns({
        additionalMetadata: expectedMetadata,
        limit: 2,
        since: new Date(0),
        workflowName: HATCHET_WORKFLOW_NAME,
      });
    } catch {
      return unknownLookup();
    }

    const exact = rows.filter(
      (row) =>
        isUsableRunId(row.orchestrationRunId) &&
        metadataMatches(row.metadata, expectedMetadata) &&
        inputMatches(row.input, input)
    );

    if (rows.length === 0) {
      return { status: "not-found" };
    }
    if (exact.length !== rows.length) {
      return unknownLookup("hatchet-lookup-filter-mismatch");
    }
    if (exact.length !== 1) {
      return unknownLookup("hatchet-lookup-cardinality-violation");
    }

    const match = exact[0];
    if (match === undefined) {
      return unknownLookup("hatchet-lookup-cardinality-violation");
    }
    return {
      orchestrationRunId: match.orchestrationRunId,
      status: "found",
    };
  };

  const findAttemptByStartKey = async (
    request: StartLeafAttemptRequest
  ): Promise<FindLeafResult> => {
    let input: HatchetLeafInput;
    try {
      input = toHatchetLeafInput(request);
    } catch {
      return unknownLeafLookup("invalid-leaf-orchestration-request");
    }

    const expectedMetadata = leafMetadataFor(input);
    let rows: readonly RemoteRunSummary[];
    try {
      rows = await dependencies.findRuns({
        additionalMetadata: expectedMetadata,
        limit: 2,
        since: new Date(0),
        workflowName: HATCHET_LEAF_TASK_NAME,
      });
    } catch {
      return unknownLeafLookup();
    }

    const exact = rows.filter(
      (row) =>
        isUsableRunId(row.orchestrationRunId) &&
        leafMetadataMatches(row.metadata, expectedMetadata) &&
        leafInputMatches(row.input, input)
    );

    if (rows.length === 0) {
      return unknownLeafLookup("hatchet-leaf-start-not-visible");
    }
    if (exact.length !== rows.length) {
      return unknownLeafLookup("hatchet-leaf-lookup-filter-mismatch");
    }
    if (exact.length !== 1) {
      return unknownLeafLookup("hatchet-leaf-lookup-cardinality-violation");
    }

    const match = exact[0];
    if (match === undefined) {
      return unknownLeafLookup("hatchet-leaf-lookup-cardinality-violation");
    }
    return {
      externalExecutionId: match.orchestrationRunId,
      status: "found",
    };
  };

  const port: OrchestrationPort = {
    adapterKey: "orchestration-hatchet",
    findRunByStartKey,
    startRun: async (request: StartRunRequest): Promise<StartRunResult> => {
      let input: HatchetRunInput;
      try {
        input = toHatchetRunInput(request);
      } catch {
        return rejectedStart();
      }

      try {
        const orchestrationRunId = await dependencies.startRemote({
          additionalMetadata: metadataFor(input),
          request: input,
        });
        if (!isUsableRunId(orchestrationRunId)) {
          return unknownStart();
        }
        return { orchestrationRunId, status: "accepted" };
      } catch (error: unknown) {
        const existingRunId = dependencies.classifyCollision(error);
        if (isUsableRunId(existingRunId)) {
          const existing = await findRunByStartKey(request);
          if (
            existing.status === "found" &&
            existing.orchestrationRunId === existingRunId
          ) {
            return {
              orchestrationRunId: existingRunId,
              status: "already-started",
            };
          }
        }
        return unknownStart();
      }
    },
  };

  const leafPort: LeafOrchestrationPort = {
    adapterKey: "orchestration-hatchet",
    findAttemptByStartKey,
    startAttempt: async (
      request: StartLeafAttemptRequest
    ): Promise<StartLeafResult> => {
      let input: HatchetLeafInput;
      try {
        input = toHatchetLeafInput(request);
      } catch {
        return rejectedLeafStart();
      }

      try {
        const externalExecutionId = await dependencies.startLeafRemote({
          additionalMetadata: leafMetadataFor(input),
          request: input,
        });
        if (!isUsableRunId(externalExecutionId)) {
          return unknownLeafStart();
        }
        return { externalExecutionId, status: "accepted" };
      } catch (error: unknown) {
        const existingExecutionId = dependencies.classifyCollision(error);
        if (isUsableRunId(existingExecutionId)) {
          const existing = await findAttemptByStartKey(request);
          if (
            existing.status === "found" &&
            existing.externalExecutionId === existingExecutionId
          ) {
            return {
              externalExecutionId: existingExecutionId,
              status: "already-started",
            };
          }
        }
        return unknownLeafStart();
      }
    },
  };

  return Object.freeze({ leafPort, port, worker });
};
