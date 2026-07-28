import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.KUROBARA_DOGFOOD_ENABLE_TEST_HELPERS = "1";
const { dogfoodTestHelpers } = await import("../../scripts/b2b-dogfood.mjs");
Reflect.deleteProperty(process.env, "KUROBARA_DOGFOOD_ENABLE_TEST_HELPERS");

if (dogfoodTestHelpers === undefined) {
  throw new Error("Dogfood test helpers were not enabled.");
}
const CONSTRUCTION_FAILURE_PATTERN = /synthetic state write failure/u;
const EMULATED_PROCESS_GROUP_SETTLEMENT_GRACE_MS = 5000;
const temporaryDirectories = [];
const services = [];

const waitForFile = async (file, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}.`);
};

after(async () => {
  await Promise.all(
    services.splice(0).map((service) =>
      dogfoodTestHelpers
        .stopService(service, {
          forceSettlementGraceMs: EMULATED_PROCESS_GROUP_SETTLEMENT_GRACE_MS,
          terminationGraceMs: 50,
        })
        .catch(() => undefined)
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      })
    )
  );
});

test("parses only an explicit bounded live run", () => {
  assert.deepEqual(dogfoodTestHelpers.parseArguments([]), { command: "help" });
  assert.deepEqual(
    dogfoodTestHelpers.parseArguments([
      "run",
      "--confirm-provider-calls",
      "--country",
      "FR",
      "--industry",
      "pet-food",
      "--title",
      "VP Sales",
      "--timeout-ms",
      "60000",
    ]),
    {
      command: "run",
      confirmProviderCalls: true,
      country: "FR",
      industry: "pet-food",
      timeoutMs: 60_000,
      title: "VP Sales",
    }
  );
  assert.throws(
    () => dogfoodTestHelpers.parseArguments(["run"]),
    (error) => error?.code === "usage-invalid"
  );
  assert.throws(
    () =>
      dogfoodTestHelpers.parseArguments([
        "run",
        "--confirm-provider-calls",
        "--country",
        "ES",
        "--country",
        "FR",
      ]),
    (error) => error?.code === "usage-invalid"
  );
});

test("escalates an interrupted ready stubborn child and settles within a hard bound", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kurobara-dogfood-test."));
  temporaryDirectories.push(parent);
  const readyFile = path.join(parent, "ready");
  const controller = new AbortController();
  const startedAt = Date.now();
  const command = dogfoodTestHelpers.runCommand(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => process.stdout.write("term-ignored\\n")); writeFileSync(process.argv[1], "ready", { mode: 0o600 }); setInterval(() => {}, 1000);',
      readyFile,
    ],
    {
      forceSettlementGraceMs: 100,
      label: "synthetic stubborn child",
      signal: controller.signal,
      terminationGraceMs: 50,
      timeoutMs: 5000,
    }
  );
  await waitForFile(readyFile);
  controller.abort();
  await assert.rejects(
    command,
    (error) =>
      error?.code === "command-interrupted" &&
      error.message.includes("term-ignored")
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test("keeps interrupt handlers installed until explicit cleanup disposal", () => {
  const signalHost = new EventEmitter();
  const controller = new AbortController();
  const guard = dogfoodTestHelpers.installInterruptGuard(
    controller,
    signalHost
  );

  signalHost.emit("SIGINT");
  signalHost.emit("SIGTERM");

  assert.equal(controller.signal.aborted, true);
  assert.equal(guard.count(), 2);
  assert.equal(signalHost.listenerCount("SIGINT"), 1);
  assert.equal(signalHost.listenerCount("SIGTERM"), 1);

  guard.dispose();
  assert.equal(signalHost.listenerCount("SIGINT"), 0);
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

test("keeps real provider credentials in the worker environment only", () => {
  const runtime = Object.freeze({
    KUROBARA_CONTACT_EXPORT_POLICY_JSON: '{"policy":"synthetic"}',
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: "privacy-secret",
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION: "v1",
    KUROBARA_DATABASE_URL: "postgres://local-only",
    KUROBARA_PROVIDER_ORDER: "prospeo,hunter",
  });
  const environments = dogfoodTestHelpers.composeRuntimeEnvironments(runtime, {
    HUNTER_API_KEY: "hunter-secret",
    PROSPEO_API_KEY: "prospeo-secret",
  });

  assert.equal(
    environments.bootstrap.KUROBARA_CONTACT_PRIVACY_HMAC_SECRET,
    undefined
  );
  assert.equal(environments.bootstrap.HUNTER_API_KEY, undefined);
  assert.equal(
    environments.api.KUROBARA_CONTACT_PRIVACY_HMAC_SECRET,
    "privacy-secret"
  );
  assert.equal(
    environments.api.KUROBARA_CONTACT_EXPORT_POLICY_JSON,
    '{"policy":"synthetic"}'
  );
  assert.equal(
    environments.bootstrap.KUROBARA_CONTACT_EXPORT_POLICY_JSON,
    undefined
  );
  assert.equal(
    environments.worker.KUROBARA_CONTACT_EXPORT_POLICY_JSON,
    undefined
  );
  assert.equal(environments.api.HUNTER_API_KEY, "configured-in-worker");
  assert.equal(environments.api.PROSPEO_API_KEY, "configured-in-worker");
  assert.equal(environments.worker.HUNTER_API_KEY, "hunter-secret");
  assert.equal(environments.worker.PROSPEO_API_KEY, "prospeo-secret");
});

test("stops a whole service group when a ready descendant ignores SIGTERM", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kurobara-dogfood-test."));
  temporaryDirectories.push(parent);
  const readyFile = path.join(parent, "descendant-ready");
  const descendantSource =
    'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], "ready", { mode: 0o600 }); setInterval(() => {}, 1000);';
  const service = dogfoodTestHelpers.startService(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { spawn } from "node:child_process"; spawn(process.execPath, ["--input-type=module", "--eval", process.argv[1], process.argv[2]], { stdio: "ignore" }); setInterval(() => {}, 1000);',
      descendantSource,
      readyFile,
    ],
    process.env
  );
  services.push(service);
  await waitForFile(readyFile);
  const processGroupId = service.processGroupId;
  assert.equal(dogfoodTestHelpers.processGroupExists(processGroupId), true);

  await dogfoodTestHelpers.stopService(service, {
    forceSettlementGraceMs: EMULATED_PROCESS_GROUP_SETTLEMENT_GRACE_MS,
    terminationGraceMs: 50,
  });

  assert.equal(dogfoodTestHelpers.processGroupExists(processGroupId), false);
  services.splice(services.indexOf(service), 1);
});

test("removes private state when construction fails after mkdtemp", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kurobara-dogfood-test."));
  temporaryDirectories.push(parent);
  let stateDirectory;

  await assert.rejects(
    dogfoodTestHelpers.createRunState({
      allocateDistinctPorts: () =>
        Promise.resolve([41_001, 41_002, 41_003, 41_004]),
      createStateDirectory: async () => {
        stateDirectory = await mkdtemp(path.join(parent, "state."));
        return stateDirectory;
      },
      writeStateFile: () =>
        Promise.reject(new Error("synthetic state write failure")),
    }),
    CONSTRUCTION_FAILURE_PATTERN
  );

  assert.ok(stateDirectory);
  await assert.rejects(
    access(stateDirectory),
    (error) => error?.code === "ENOENT"
  );
});
