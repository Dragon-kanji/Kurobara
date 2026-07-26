import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  PluginExecuteRequest,
  PluginHealthRequest,
  PluginManifestV1,
} from "@kurobara/plugin-sdk";

import {
  type DevelopmentPluginHost,
  type DevelopmentPluginHostOptions,
  PluginHostError,
  startDevelopmentPluginHost,
} from "../src/index.ts";
import {
  FIXTURE_CONFIGURATION_HASH,
  FIXTURE_INPUT_HASH,
  FIXTURE_MANIFEST,
} from "./fixtures/fixture-values.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sidecarPath = path.join(
  packageRoot,
  "test/fixtures/one-request-sidecar.ts"
);

const options = (
  behavior = "normal",
  overrides: Partial<DevelopmentPluginHostOptions> = {},
  pidLog?: string,
  requestLog?: string
): DevelopmentPluginHostOptions => ({
  arguments: [
    "--experimental-strip-types",
    sidecarPath,
    behavior,
    ...(pidLog ? [pidLog, ...(requestLog ? [requestLog] : [])] : []),
  ],
  callTimeoutMs: 1000,
  executablePath: process.execPath,
  expectedManifest: FIXTURE_MANIFEST,
  workingDirectory: packageRoot,
  ...overrides,
});

const context = (deadlineAtMs = Date.now() + 5000) => ({
  capability: {
    capabilityId: "fixture.echo",
    capabilityVersion: "1.0.0",
  },
  configuration: {
    contentHash: FIXTURE_CONFIGURATION_HASH,
    value: { mode: "synthetic" },
  },
  deadlineAtMs,
});

const healthRequest = (deadlineAtMs?: number): PluginHealthRequest => ({
  context: context(deadlineAtMs),
});

const executeRequest = (
  quoteExpiresAtMs = Date.now() + 5000
): PluginExecuteRequest => {
  const value = { value: true };
  const capability = FIXTURE_MANIFEST.capabilities[0];
  if (!capability) {
    throw new Error("The fixture manifest must expose one capability.");
  }
  return {
    context: context(),
    costLimit: { amount: 1, unit: "requests" },
    input: {
      contentHash: FIXTURE_INPUT_HASH,
      contract: capability.inputContract,
      sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
      value,
    },
    operationKey: "synthetic:operation",
    quote: {
      expiresAtMs: quoteExpiresAtMs,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "requests",
      upperBound: 1,
    },
  };
};

const lookupRequest = () => ({
  context: context(),
  operationKey: "synthetic:lookup",
});

const closeQuietly = async (
  host: DevelopmentPluginHost | undefined
): Promise<void> => {
  await host?.close();
};

const waitForPidCount = async (
  pidLog: string,
  expectedCount: number,
  deadlineAtMs = Date.now() + 1000
): Promise<void> => {
  try {
    const pids = (await readFile(pidLog, "utf8")).trim().split("\n");
    if (pids.length >= expectedCount) {
      return;
    }
  } catch {
    // The child has not created the readiness file yet.
  }
  if (Date.now() >= deadlineAtMs) {
    throw new Error(
      `Timed out waiting for ${expectedCount} fixture processes.`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await waitForPidCount(pidLog, expectedCount, deadlineAtMs);
};

test("rejects auth and egress before spawning a sidecar", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-host-admission-")
  );
  const pidLog = path.join(temporaryDirectory, "pids.log");
  const rejectedManifests: PluginManifestV1[] = [
    {
      ...FIXTURE_MANIFEST,
      auth: { modes: ["api-key-header"] },
    },
    {
      ...FIXTURE_MANIFEST,
      permissions: {
        egress: { hosts: ["api.fixture.example"], tlsRequired: true },
      },
    },
  ];

  try {
    for (const expectedManifest of rejectedManifests) {
      await assert.rejects(
        () =>
          startDevelopmentPluginHost(
            options("normal", { expectedManifest }, pidLog)
          ),
        (error: unknown) =>
          error instanceof PluginHostError &&
          error.reasonCode === "plugin-host-admission-rejected"
      );
    }
    await assert.rejects(() => access(pidLog));
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("runs describe then health in distinct one-request processes", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-host-happy-")
  );
  const pidLog = path.join(temporaryDirectory, "pids.log");
  let host: DevelopmentPluginHost | undefined;
  try {
    host = await startDevelopmentPluginHost(options("normal", {}, pidLog));
    assert.equal(Object.isFrozen(host.manifest), true);
    assert.deepEqual(host.manifest, FIXTURE_MANIFEST);

    const deadlineAtMs = Date.now() + 5000;
    assert.deepEqual(await host.call("health", healthRequest(deadlineAtMs)), {
      observedAtMs: deadlineAtMs,
      status: "healthy",
      validUntilMs: deadlineAtMs,
    });
    const pids = (await readFile(pidLog, "utf8")).trim().split("\n");
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    await host.close();
    await host.close();
  } finally {
    await closeQuietly(host);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("rejects hostile byte framing during describe", async () => {
  const hostileBehaviors = [
    "bom",
    "crlf",
    "duplicate-jsonrpc",
    "duplicate-nested-escaped",
    "empty",
    "extra",
    "flood",
    "no-lf",
    "stdout-prefix",
    "utf8",
    "wrong-id",
    "wrong-method",
  ];
  for (const behavior of hostileBehaviors) {
    await assert.rejects(
      () => startDevelopmentPluginHost(options(`describe:${behavior}`)),
      (error: unknown) =>
        error instanceof PluginHostError &&
        (error.reasonCode === "plugin-host-frame-invalid" ||
          error.reasonCode === "plugin-host-frame-limit-exceeded"),
      behavior
    );
  }
});

test("rejects a concurrent call while one child is active", async () => {
  const host = await startDevelopmentPluginHost(options("health:delay"));
  try {
    const firstCall = host.call("health", healthRequest());
    await assert.rejects(
      () => host.call("health", healthRequest()),
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.reasonCode === "plugin-host-busy"
    );
    assert.equal((await firstCall).status, "healthy");
  } finally {
    await host.close();
  }
});

test("rejects elapsed deadlines and expired quotes before spawn", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-host-preflight-")
  );
  const pidLog = path.join(temporaryDirectory, "pids.log");
  let host: DevelopmentPluginHost | undefined;
  try {
    const startedHost = await startDevelopmentPluginHost(
      options("normal", {}, pidLog)
    );
    host = startedHost;
    await assert.rejects(
      () => startedHost.call("health", healthRequest(Date.now() - 1)),
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.reasonCode === "plugin-host-deadline-exceeded"
    );
    await assert.rejects(
      () => startedHost.call("execute", executeRequest(Date.now() - 1)),
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.reasonCode === "plugin-host-quote-expired"
    );
    const pids = (await readFile(pidLog, "utf8")).trim().split("\n");
    assert.equal(pids.length, 1);
  } finally {
    await closeQuietly(host);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("rechecks deadlines and quotes after spawn before dispatch", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-host-dispatch-time-")
  );
  const pidLog = path.join(temporaryDirectory, "pids.log");
  const requestLog = path.join(temporaryDirectory, "requests.log");
  let host: DevelopmentPluginHost | undefined;
  const spawnDescriptor = Object.getOwnPropertyDescriptor(
    childProcess,
    "spawn"
  );
  assert.ok(spawnDescriptor);
  const originalSpawn = childProcess.spawn;
  const delaySignal = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  );

  try {
    const startedHost = await startDevelopmentPluginHost(
      options("normal", {}, pidLog, requestLog)
    );
    host = startedHost;
    Object.defineProperty(childProcess, "spawn", {
      ...spawnDescriptor,
      value: (...arguments_: unknown[]) => {
        Atomics.wait(delaySignal, 0, 0, 150);
        return Reflect.apply(originalSpawn, childProcess, arguments_);
      },
    });
    syncBuiltinESMExports();

    await assert.rejects(
      () => startedHost.call("health", healthRequest(Date.now() + 75)),
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.reasonCode === "plugin-host-deadline-exceeded"
    );
    await assert.rejects(
      () => startedHost.call("execute", executeRequest(Date.now() + 75)),
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.reasonCode === "plugin-host-quote-expired"
    );
    assert.equal((await readFile(requestLog, "utf8")).trim(), "describe");
  } finally {
    Object.defineProperty(childProcess, "spawn", spawnDescriptor);
    syncBuiltinESMExports();
    await closeQuietly(host);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("maps execute timeout and lookup crash to redacted ambiguity", async () => {
  const executeHost = await startDevelopmentPluginHost(options("execute:hang"));
  try {
    assert.deepEqual(await executeHost.call("execute", executeRequest()), {
      error: { class: "adapter", reasonCode: "adapter-fault" },
      status: "outcome-unknown",
    });
  } finally {
    await executeHost.close();
  }

  const lookupHost = await startDevelopmentPluginHost(options("lookup:crash"));
  try {
    assert.deepEqual(await lookupHost.call("lookup", lookupRequest()), {
      error: { class: "adapter", reasonCode: "adapter-fault" },
      status: "outcome-unknown",
    });
  } finally {
    await lookupHost.close();
  }
});

test("drains stderr without exposing a synthetic canary", async () => {
  const healthyHost = await startDevelopmentPluginHost(
    options("health:stderr-canary")
  );
  try {
    assert.equal(
      (await healthyHost.call("health", healthRequest())).status,
      "healthy"
    );
  } finally {
    await healthyHost.close();
  }

  const crashingHost = await startDevelopmentPluginHost(
    options("health:stderr-crash")
  );
  try {
    const error = await crashingHost
      .call("health", healthRequest())
      .then(() => undefined)
      .catch((reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.equal(String(error).includes("synthetic-stderr-canary"), false);
    assert.equal(
      JSON.stringify(error).includes("synthetic-stderr-canary"),
      false
    );
  } finally {
    await crashingHost.close();
  }
});

test("close terminates a child that ignores TERM within a fixed bound", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-host-close-")
  );
  const pidLog = path.join(temporaryDirectory, "pids.log");
  const host = await startDevelopmentPluginHost(
    options("health:ignore-term", { callTimeoutMs: 5000 }, pidLog)
  );
  try {
    const call = host
      .call("health", healthRequest())
      .then(() => undefined)
      .catch((error: unknown) => error);
    await waitForPidCount(pidLog, 2);
    const startedAt = Date.now();
    await host.close();
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 75, `TERM was not ignored (${elapsedMs} ms)`);
    assert.ok(elapsedMs < 1500, `close took ${elapsedMs} ms`);
    assert.ok((await call) instanceof Error);
    await host.close();
  } finally {
    await host.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
