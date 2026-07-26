import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { createHatchetOrchestration } from "@kurobara/adapter-orchestration-hatchet";
import { eventId, runId, workspaceId } from "@kurobara/kernel";
import type { StartRunRequest } from "@kurobara/ports";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required by the Hatchet integration test.`);
  }
  return value;
};

const IDEMPOTENCY_TTL_MILLISECONDS = 120_000;
const qualificationPhase = requiredEnvironment("KUROBARA_HATCHET_PHASE");
if (qualificationPhase !== "prepare" && qualificationPhase !== "verify") {
  throw new Error("KUROBARA_HATCHET_PHASE must be prepare or verify.");
}

type QualificationState = Readonly<{
  createdAtMilliseconds: number;
  orchestrationRunId: string;
  request: Readonly<{
    eventId: string;
    runId: string;
    startKey: string;
    workspaceId: string;
  }>;
  suffix: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseState = (value: unknown): QualificationState => {
  if (!(isRecord(value) && isRecord(value.request))) {
    throw new Error("Hatchet restart qualification state is invalid.");
  }
  const request = value.request;
  const createdAtMilliseconds = value.createdAtMilliseconds;
  const orchestrationRunId = value.orchestrationRunId;
  const suffix = value.suffix;
  const requestEventId = request.eventId;
  const requestRunId = request.runId;
  const requestStartKey = request.startKey;
  const requestWorkspaceId = request.workspaceId;
  const strings = [
    orchestrationRunId,
    suffix,
    requestEventId,
    requestRunId,
    requestStartKey,
    requestWorkspaceId,
  ];
  if (
    typeof createdAtMilliseconds !== "number" ||
    !Number.isSafeInteger(createdAtMilliseconds) ||
    strings.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("Hatchet restart qualification state is invalid.");
  }
  if (
    typeof orchestrationRunId !== "string" ||
    typeof suffix !== "string" ||
    typeof requestEventId !== "string" ||
    typeof requestRunId !== "string" ||
    typeof requestStartKey !== "string" ||
    typeof requestWorkspaceId !== "string"
  ) {
    throw new Error("Hatchet restart qualification state is invalid.");
  }
  return {
    createdAtMilliseconds,
    orchestrationRunId,
    request: {
      eventId: requestEventId,
      runId: requestRunId,
      startKey: requestStartKey,
      workspaceId: requestWorkspaceId,
    },
    suffix,
  };
};

const readState = async (): Promise<QualificationState> => {
  const contents = await readFile(
    requiredEnvironment("KUROBARA_HATCHET_STATE_FILE"),
    "utf8"
  );
  return parseState(JSON.parse(contents) as unknown);
};

const toRequest = (state: QualificationState): StartRunRequest => ({
  eventId: eventId(state.request.eventId),
  runId: runId(state.request.runId),
  startKey: state.request.startKey,
  workspaceId: workspaceId(state.request.workspaceId),
});

const createRuntime = (
  suffix: string,
  execute: (request: StartRunRequest) => Promise<void>
) =>
  createHatchetOrchestration(
    {
      apiUrl: requiredEnvironment("HATCHET_CLIENT_API_URL"),
      hostPort: requiredEnvironment("HATCHET_CLIENT_HOST_PORT"),
      idempotencyTtlMilliseconds: IDEMPOTENCY_TTL_MILLISECONDS,
      namespace: requiredEnvironment("HATCHET_CLIENT_NAMESPACE"),
      readinessTimeoutMilliseconds: 15_000,
      requestTimeoutMilliseconds: 7500,
      slots: 1,
      tlsStrategy: "none",
      token: requiredEnvironment("HATCHET_CLIENT_TOKEN"),
      workerName: `kurobara-qualification-${suffix}`,
    },
    execute
  );

const createQualificationClient = () =>
  HatchetClient.init(
    {
      api_url: requiredEnvironment("HATCHET_CLIENT_API_URL"),
      host_port: requiredEnvironment("HATCHET_CLIENT_HOST_PORT"),
      namespace: requiredEnvironment("HATCHET_CLIENT_NAMESPACE"),
      tls_config: { tls_strategy: "none" },
      token: requiredEnvironment("HATCHET_CLIENT_TOKEN"),
    },
    undefined,
    { timeout: 7500 }
  );

const withTimeout = async <Result>(
  promise: Promise<Result>,
  timeoutMilliseconds: number,
  message: string
): Promise<Result> => {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const waitForLookup = async (
  lookup: () => ReturnType<
    ReturnType<typeof createHatchetOrchestration>["port"]["findRunByStartKey"]
  >
) => {
  const deadline = Date.now() + 30_000;
  let lastReason: string | undefined;
  let lastStatus = "not-run";
  while (Date.now() < deadline) {
    const result = await lookup();
    lastStatus = result.status;
    lastReason = "reason" in result ? result.reason : undefined;
    if (result.status === "found") {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Hatchet did not expose the submitted run before timeout (last status: ${lastStatus}${lastReason === undefined ? "" : `, reason: ${lastReason}`}).`
  );
};

const waitForCompletion = async (orchestrationRunId: string): Promise<void> => {
  const client = createQualificationClient();
  const deadline = Date.now() + 30_000;
  let lastStatus = "not-read";
  while (Date.now() < deadline) {
    try {
      lastStatus = await client.runs.get_status(orchestrationRunId);
      if (lastStatus === "COMPLETED") {
        return;
      }
    } catch {
      lastStatus = "read-failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Hatchet did not report the submitted run as completed before timeout (last status: ${lastStatus}).`
  );
};

test("creates and persists a completed self-hosted Hatchet run", {
  timeout: 60_000,
}, async (context) => {
  if (qualificationPhase !== "prepare") {
    context.skip("prepare phase only");
    return;
  }
  const suffix = `${process.pid}-${randomUUID()}`;
  const request: StartRunRequest = {
    eventId: eventId(`event-${suffix}`),
    runId: runId(`run-${suffix}`),
    startKey: `start-${suffix}`,
    workspaceId: workspaceId(`workspace-${suffix}`),
  };

  let executions = 0;
  let resolveExecution: (value: StartRunRequest) => void = () => undefined;
  const execution = new Promise<StartRunRequest>((resolve) => {
    resolveExecution = resolve;
  });
  const runtime = createRuntime(suffix, (executedRequest) => {
    executions += 1;
    resolveExecution(executedRequest);
    return Promise.resolve();
  });

  await runtime.worker.start();
  try {
    const createdAtMilliseconds = Date.now();
    const started = await runtime.port.startRun(request);
    assert.equal(started.status, "accepted");

    assert.deepEqual(
      await withTimeout(
        execution,
        20_000,
        "Hatchet accepted the run but the Kurobara worker did not execute it."
      ),
      request
    );

    const found = await waitForLookup(() =>
      runtime.port.findRunByStartKey(request)
    );
    assert.equal(found.orchestrationRunId, started.orchestrationRunId);

    const duplicate = await runtime.port.startRun(request);
    assert.deepEqual(duplicate, {
      orchestrationRunId: started.orchestrationRunId,
      status: "already-started",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(executions, 1);
    await waitForCompletion(started.orchestrationRunId);

    const state: QualificationState = {
      createdAtMilliseconds,
      orchestrationRunId: started.orchestrationRunId,
      request,
      suffix,
    };
    await writeFile(
      requiredEnvironment("KUROBARA_HATCHET_STATE_FILE"),
      `${JSON.stringify(state)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } finally {
    await runtime.worker.stop();
  }
});

test("retains lookup and idempotency across a Hatchet service restart", {
  timeout: 60_000,
}, async (context) => {
  if (qualificationPhase !== "verify") {
    context.skip("verify phase only");
    return;
  }
  const state = await readState();
  const request = toRequest(state);
  let executions = 0;
  const runtime = createRuntime(`${state.suffix}-after-restart`, () => {
    executions += 1;
    return Promise.resolve();
  });

  await runtime.worker.start();
  try {
    const found = await waitForLookup(() =>
      runtime.port.findRunByStartKey(request)
    );
    assert.equal(found.orchestrationRunId, state.orchestrationRunId);
    await waitForCompletion(state.orchestrationRunId);

    const elapsed = Date.now() - state.createdAtMilliseconds;
    assert.ok(elapsed >= 0 && elapsed < IDEMPOTENCY_TTL_MILLISECONDS);
    const duplicate = await runtime.port.startRun(request);
    assert.deepEqual(duplicate, {
      orchestrationRunId: state.orchestrationRunId,
      status: "already-started",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterDuplicate = await waitForLookup(() =>
      runtime.port.findRunByStartKey(request)
    );
    assert.equal(afterDuplicate.orchestrationRunId, state.orchestrationRunId);
    assert.equal(executions, 0);
  } finally {
    await runtime.worker.stop();
  }
});
