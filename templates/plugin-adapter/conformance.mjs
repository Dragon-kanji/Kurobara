import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runSidecarConformance,
  serializePluginConformanceReport,
} from "@kurobara/plugin-conformance";

import { pluginManifest } from "./dist/index.js";

const ARTIFACT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const CANARY = "synthetic-redaction-canary";
const modes = new Set([
  "conformant",
  "errors",
  "idempotence",
  "lookup-always-found",
  "lookup-failed-outcome",
  "lookup-mismatch",
  "redaction",
  "redelivery-reference-drift",
  "schema",
  "second-execute-timeout",
  "timeout",
]);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

const readOptions = () => {
  const values = {
    artifactFingerprint: undefined,
    journalPath: undefined,
    mode: undefined,
  };
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (flag === "--artifact-fingerprint" && value) {
      values.artifactFingerprint = value;
      continue;
    }
    if (flag === "--journal" && value) {
      values.journalPath = path.resolve(value);
      continue;
    }
    if (flag === "--mode" && value && modes.has(value)) {
      values.mode = value;
      continue;
    }
    throw new Error("plugin-conformance-invocation-invalid");
  }
  if (
    process.argv.length !== 8 ||
    !values.artifactFingerprint ||
    !ARTIFACT_FINGERPRINT.test(values.artifactFingerprint) ||
    !values.journalPath ||
    !values.mode
  ) {
    throw new Error("plugin-conformance-invocation-invalid");
  }
  return values;
};

const readPackageIdentity = async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8")
  );
  if (
    manifest.name !== "@example/kurobara-plugin-adapter" ||
    manifest.version !== "0.1.0"
  ) {
    throw new Error("plugin-conformance-invocation-invalid");
  }
  return manifest;
};

const readEffectObservation = async (journalPath) => {
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    if (
      journal?.version !== 1 ||
      journal.effects === null ||
      typeof journal.effects !== "object" ||
      Array.isArray(journal.effects)
    ) {
      throw new Error("plugin-conformance-effect-probe-invalid");
    }
    let effectCount = 0;
    const operationKeys = [];
    for (const [operationKey, effect] of Object.entries(journal.effects)) {
      if (
        !Number.isSafeInteger(effect?.effectCount) ||
        effect.effectCount < 1
      ) {
        throw new Error("plugin-conformance-effect-probe-invalid");
      }
      effectCount += effect.effectCount;
      operationKeys.push(
        ...Array.from({ length: effect.effectCount }, () => operationKey)
      );
    }
    return { effectCount, operationKeys: operationKeys.sort() };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { effectCount: 0, operationKeys: [] };
    }
    throw error;
  }
};

const requests = () => {
  const hash = (character) => `sha256:${character.repeat(64)}`;
  const capability = pluginManifest.capabilities[0];
  const context = {
    capability: {
      capabilityId: capability.capabilityId,
      capabilityVersion: capability.capabilityVersion,
    },
    configuration: {
      contentHash: hash("d"),
      value: { endpointProfile: "synthetic" },
    },
    deadlineAtMs: 4_102_444_800_000,
  };
  const operationKey = "operation:adapter-template:conformance";
  const inputValue = {
    dataset_id: "dataset:synthetic",
    record_id: "record:synthetic",
    values: [{ field_id: "document", value: "synthetic" }],
    workspace_id: "workspace:synthetic",
  };
  const input = {
    contentHash: hash("e"),
    contract: capability.inputContract,
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  };
  return {
    classifyError: {
      context,
      diagnostic: { kind: "provider-code", providerCode: CANARY },
      phase: "execute",
    },
    estimate: { context, input },
    execute: {
      context,
      costLimit: { amount: 1, unit: "credits" },
      input,
      operationKey,
      quote: {
        expiresAtMs: context.deadlineAtMs,
        guarantee: "hard",
        pricingVersion: "1.0.0",
        unit: "credits",
        upperBound: 1,
      },
    },
    health: { context },
    lookup: { context, operationKey },
    normalize: {
      context,
      operationKey,
      outputContract: capability.outputContract,
      providerPayload: {
        adapter: "deterministic-local",
        attempt_id: "attempt:synthetic",
        operation_key: operationKey,
        run_id: "run:synthetic",
        status: "succeeded",
        step_run_id: "step-run:synthetic",
      },
    },
    validateConfig: {
      capability: context.capability,
      configuration: context.configuration,
    },
  };
};

const run = async () => {
  const options = readOptions();
  const packageManifest = await readPackageIdentity();
  const report = await runSidecarConformance({
    canary: CANARY,
    effectProbe: {
      read: async () => {
        const observation = await readEffectObservation(options.journalPath);
        return options.mode === "redaction"
          ? { ...observation, diagnostic: CANARY }
          : observation;
      },
    },
    host: {
      arguments: [
        path.join(packageRoot, "sidecar.mjs"),
        "--journal",
        options.journalPath,
        "--mode",
        options.mode,
      ],
      callTimeoutMs: 2000,
      executablePath: process.execPath,
      expectedManifest: pluginManifest,
      workingDirectory: packageRoot,
    },
    requests: requests(),
    subject: {
      artifactFingerprint: options.artifactFingerprint,
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
    },
  });
  process.stdout.write(serializePluginConformanceReport(report));
  process.exitCode = report.summary.status === "passed" ? 0 : 1;
};

try {
  await run();
} catch {
  process.stderr.write("plugin-conformance-invocation-invalid\n");
  process.exitCode = 2;
}
