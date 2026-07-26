import type {
  LeafOrchestrationPort,
  OrchestrationPort,
  StartLeafAttemptRequest,
  StartRunRequest,
} from "@kurobara/ports";

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

export type FakeStartScenario =
  | Readonly<{ status: "accepted"; orchestrationRunId: string }>
  | Readonly<{ status: "already-started"; orchestrationRunId: string }>
  | Readonly<{ status: "outcome-unknown"; reason: string }>
  | Readonly<{
      status: "definitely-rejected";
      reason: string;
      retryable: boolean;
    }>;

export type FakeLookupScenario =
  | Readonly<{ status: "found"; orchestrationRunId: string }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{ status: "outcome-unknown"; reason: string }>;

export type FakeLeafStartScenario =
  | Readonly<{ status: "accepted"; externalExecutionId: string }>
  | Readonly<{ status: "already-started"; externalExecutionId: string }>
  | Readonly<{ status: "outcome-unknown"; reason: string }>
  | Readonly<{
      status: "definitely-rejected";
      reason: string;
      retryable: boolean;
    }>;

export type FakeLeafLookupScenario =
  | Readonly<{ status: "found"; externalExecutionId: string }>
  | Readonly<{ status: "not-found"; proofId: string }>
  | Readonly<{ status: "outcome-unknown"; reason: string }>;

export type ExecuteFakeLeafAttempt = (
  request: StartLeafAttemptRequest
) => Promise<void>;

export type FakeOrchestrationOptions = Readonly<{
  executeAttempt?: ExecuteFakeLeafAttempt;
  leafLookupScenarios?: Readonly<Record<string, FakeLeafLookupScenario>>;
  leafStartScenarios?: Readonly<Record<string, FakeLeafStartScenario>>;
  lookupScenarios?: Readonly<Record<string, FakeLookupScenario>>;
  startScenarios?: Readonly<Record<string, FakeStartScenario>>;
}>;

export type FakeOrchestrationCallHistory = Readonly<{
  leafExecutions: readonly StartLeafAttemptRequest[];
  leafLookups: readonly StartLeafAttemptRequest[];
  leafStarts: readonly StartLeafAttemptRequest[];
  lookups: readonly StartRunRequest[];
  starts: readonly StartRunRequest[];
}>;

export type FakeOrchestration = Readonly<{
  history(): FakeOrchestrationCallHistory;
  leafPort: LeafOrchestrationPort;
  port: OrchestrationPort;
}>;

const copyRequest = (request: StartRunRequest): StartRunRequest =>
  Object.freeze({ ...request });

const copyLeafRequest = (
  request: StartLeafAttemptRequest
): StartLeafAttemptRequest => Object.freeze({ ...request });

const assertNever = (value: never): never => {
  throw new Error(`Unexpected fake orchestration scenario: ${String(value)}`);
};

const sameRequest = (left: StartRunRequest, right: StartRunRequest): boolean =>
  left.eventId === right.eventId &&
  left.runId === right.runId &&
  left.startKey === right.startKey &&
  left.workspaceId === right.workspaceId;

const sameLeafRequest = (
  left: StartLeafAttemptRequest,
  right: StartLeafAttemptRequest
): boolean =>
  left.attemptId === right.attemptId &&
  left.eventId === right.eventId &&
  left.runId === right.runId &&
  left.startKey === right.startKey &&
  left.stepRunId === right.stepRunId &&
  left.workspaceId === right.workspaceId;

const defaultRunId = (startKey: string): string => `fake:${startKey}`;
const defaultLeafExecutionId = (startKey: string): string =>
  `fake-leaf:${startKey}`;
const defaultLeafNotFoundProofId = (startKey: string): string =>
  `fake-leaf:not-found:${startKey}`;

const copyStartResult = (scenario: FakeStartScenario): StartRunResult => {
  switch (scenario.status) {
    case "accepted":
    case "already-started":
      return {
        orchestrationRunId: scenario.orchestrationRunId,
        status: scenario.status,
      };
    case "definitely-rejected":
      return {
        reason: scenario.reason,
        retryable: scenario.retryable,
        status: scenario.status,
      };
    case "outcome-unknown":
      return { reason: scenario.reason, status: scenario.status };
    default:
      return assertNever(scenario);
  }
};

const copyLookupResult = (scenario: FakeLookupScenario): FindRunResult => ({
  ...scenario,
});

const copyLeafStartResult = (
  scenario: FakeLeafStartScenario
): StartLeafResult => ({ ...scenario });

const copyLeafLookupResult = (
  scenario: FakeLeafLookupScenario
): FindLeafResult => ({ ...scenario });

export const createFakeOrchestration = (
  options: FakeOrchestrationOptions = {}
): FakeOrchestration => {
  const leafExecutions: StartLeafAttemptRequest[] = [];
  const leafLookups: StartLeafAttemptRequest[] = [];
  const leafStarts: StartLeafAttemptRequest[] = [];
  const lookups: StartRunRequest[] = [];
  const starts: StartRunRequest[] = [];
  const acceptedByStartKey = new Map<
    string,
    Readonly<{ orchestrationRunId: string; request: StartRunRequest }>
  >();
  const acceptedLeafByStartKey = new Map<
    string,
    Readonly<{
      externalExecutionId: string;
      request: StartLeafAttemptRequest;
    }>
  >();

  const port: OrchestrationPort = {
    adapterKey: "orchestration-fake",
    findRunByStartKey: (request) => {
      const copied = copyRequest(request);
      lookups.push(copied);

      const configured = options.lookupScenarios?.[request.startKey];
      if (configured !== undefined) {
        return Promise.resolve(copyLookupResult(configured));
      }

      const accepted = acceptedByStartKey.get(request.startKey);
      if (accepted === undefined || !sameRequest(accepted.request, request)) {
        return Promise.resolve({ status: "not-found" });
      }

      return Promise.resolve({
        orchestrationRunId: accepted.orchestrationRunId,
        status: "found" as const,
      });
    },
    startRun: (request) => {
      const copied = copyRequest(request);
      starts.push(copied);

      const existing = acceptedByStartKey.get(request.startKey);
      if (existing !== undefined) {
        if (!sameRequest(existing.request, request)) {
          return Promise.resolve({
            reason: "start-key-conflict",
            retryable: false,
            status: "definitely-rejected" as const,
          });
        }

        return Promise.resolve({
          orchestrationRunId: existing.orchestrationRunId,
          status: "already-started" as const,
        });
      }

      const configured = options.startScenarios?.[request.startKey];
      if (configured?.status === "outcome-unknown") {
        return Promise.resolve(copyStartResult(configured));
      }
      if (configured?.status === "definitely-rejected") {
        return Promise.resolve(copyStartResult(configured));
      }

      const orchestrationRunId =
        configured?.orchestrationRunId ?? defaultRunId(request.startKey);
      acceptedByStartKey.set(request.startKey, {
        orchestrationRunId,
        request: copied,
      });

      return Promise.resolve({
        orchestrationRunId,
        status: configured?.status ?? "accepted",
      });
    },
  };

  const leafPort: LeafOrchestrationPort = {
    adapterKey: "orchestration-fake",
    findAttemptByStartKey: (request) => {
      const copied = copyLeafRequest(request);
      leafLookups.push(copied);

      const configured = options.leafLookupScenarios?.[request.startKey];
      if (configured !== undefined) {
        return Promise.resolve(copyLeafLookupResult(configured));
      }

      const accepted = acceptedLeafByStartKey.get(request.startKey);
      if (accepted === undefined) {
        return Promise.resolve({
          proofId: defaultLeafNotFoundProofId(request.startKey),
          status: "not-found" as const,
        });
      }
      if (!sameLeafRequest(accepted.request, request)) {
        return Promise.resolve({
          reason: "start-key-conflict",
          status: "outcome-unknown" as const,
        });
      }

      return Promise.resolve({
        externalExecutionId: accepted.externalExecutionId,
        status: "found" as const,
      });
    },
    startAttempt: async (request) => {
      const copied = copyLeafRequest(request);
      leafStarts.push(copied);

      const existing = acceptedLeafByStartKey.get(request.startKey);
      if (existing !== undefined) {
        if (!sameLeafRequest(existing.request, request)) {
          return {
            reason: "start-key-conflict",
            retryable: false,
            status: "definitely-rejected" as const,
          };
        }

        return {
          externalExecutionId: existing.externalExecutionId,
          status: "already-started" as const,
        };
      }

      const configured = options.leafStartScenarios?.[request.startKey];
      if (
        configured?.status === "outcome-unknown" ||
        configured?.status === "definitely-rejected"
      ) {
        return copyLeafStartResult(configured);
      }

      const externalExecutionId =
        configured?.externalExecutionId ??
        defaultLeafExecutionId(request.startKey);
      acceptedLeafByStartKey.set(request.startKey, {
        externalExecutionId,
        request: copied,
      });

      if (configured?.status !== "already-started") {
        leafExecutions.push(copied);
        try {
          await options.executeAttempt?.(copied);
        } catch {
          return {
            reason: "fake-leaf-callback-outcome-unknown",
            status: "outcome-unknown" as const,
          };
        }
      }

      return {
        externalExecutionId,
        status: configured?.status ?? "accepted",
      };
    },
  };

  return Object.freeze({
    history: () =>
      Object.freeze({
        leafExecutions: Object.freeze(leafExecutions.map(copyLeafRequest)),
        leafLookups: Object.freeze(leafLookups.map(copyLeafRequest)),
        leafStarts: Object.freeze(leafStarts.map(copyLeafRequest)),
        lookups: Object.freeze(lookups.map(copyRequest)),
        starts: Object.freeze(starts.map(copyRequest)),
      }),
    leafPort,
    port,
  });
};
