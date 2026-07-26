import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  loadPlanningManifest,
  PlanningOperatorError,
  parsePlanningOperatorArguments,
  runPlanningOperator,
} from "../src/bootstrap-planning.ts";

const temporaryDirectories: string[] = [];
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const hash = (marker: string): string =>
  `sha256:${marker.repeat(64).slice(0, 64)}`;

const manifest = () => ({
  formatVersion: "1.0.0",
  planning: {
    authorities: [
      {
        authorityEnvelopeId: "authority-local",
        budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
        capabilities: [
          {
            capabilityId: "documents.summarize",
            capabilityVersion: "1.0.0",
          },
        ],
        deadline: 4_102_444_800_000,
        permissions: ["capabilities:list", "plans:quote", "runs:create"],
        subjectActorId: "actor-local",
        version: "1.0.0",
        workspaceId: "workspace-local",
      },
    ],
    defaults: {
      policySnapshotId: "policy-local",
      pricingSnapshotId: "pricing-local",
      workspaceId: "workspace-local",
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash("c"),
          maxAttemptsPerStep: 3,
          requiredPermission: "plans:quote",
          version: "1.0.0",
        },
        snapshotId: "policy-local",
        workspaceId: "workspace-local",
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-local",
        ttlMilliseconds: 60_000,
        unit: "credits",
        upperBound: 5,
        version: "1.0.0",
        workspaceId: "workspace-local",
      },
    ],
    workflows: [],
    workspaceId: "workspace-local",
  },
});

const writeManifest = async (content: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kurobara-planning-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "planning.json");
  await writeFile(file, content, { mode: 0o600 });
  return file;
};

test("parses an explicit planning operator mode and file", () => {
  assert.deepEqual(
    parsePlanningOperatorArguments(["--file", "planning.json", "--check"]),
    { file: "planning.json", mode: "check" }
  );
  assert.throws(
    () => parsePlanningOperatorArguments(["--check", "--apply"]),
    PlanningOperatorError
  );
  assert.deepEqual(
    parsePlanningOperatorArguments([
      "--workspace",
      "workspace-local",
      "--read",
    ]),
    { mode: "read", workspaceId: "workspace-local" }
  );
  assert.throws(
    () =>
      parsePlanningOperatorArguments([
        "--read",
        "--workspace",
        "workspace-local",
        "--file",
        "planning.json",
      ]),
    PlanningOperatorError
  );
});

test("validates a strict planning manifest without opening PostgreSQL", async () => {
  const file = await writeManifest(JSON.stringify(manifest()));
  const result = await runPlanningOperator(["--check", "--file", file], {});
  assert.equal(result.status, "valid");
  assert.equal(result.database_verified, false);
  assert.equal(result.workspace_id, "workspace-local");
  assert.match(String(result.source_sha256), SHA256_PATTERN);
});

test("rejects a missing database URL before starting an apply", async () => {
  const file = await writeManifest(JSON.stringify(manifest()));

  await assert.rejects(
    () => runPlanningOperator(["--apply", "--file", file], {}),
    (error: unknown) =>
      error instanceof PlanningOperatorError &&
      error.code === "config-invalid" &&
      error.mutationState === "not-started"
  );
});

test("rejects duplicate keys and unsupported authority versions", async () => {
  const duplicate = await writeManifest(
    '{"formatVersion":"1.0.0","formatVersion":"1.0.0","planning":{}}'
  );
  await assert.rejects(
    () => loadPlanningManifest(duplicate),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "duplicate-key"
  );

  const unsupported = manifest();
  const unsupportedAuthority = unsupported.planning.authorities[0];
  if (unsupportedAuthority === undefined) {
    throw new Error("The planning fixture requires an authority.");
  }
  unsupportedAuthority.version = "2.0.0";
  const unsupportedFile = await writeManifest(JSON.stringify(unsupported));
  await assert.rejects(
    () => loadPlanningManifest(unsupportedFile),
    (error: unknown) =>
      error instanceof PlanningOperatorError &&
      error.code === "manifest-invalid"
  );
});

test("rejects prototype-mutating keys before object construction", async () => {
  const polluted = await writeManifest(
    `{"formatVersion":"1.0.0","__proto__":${JSON.stringify({
      planning: manifest().planning,
    })}}`
  );

  await assert.rejects(
    () => loadPlanningManifest(polluted),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "json-invalid"
  );
});

test("rejects I-JSON violations before validating the manifest", async () => {
  const loneSurrogate = await writeManifest(
    JSON.stringify(manifest()).replace("workspace-local", "\\ud800")
  );
  await assert.rejects(
    () => loadPlanningManifest(loneSurrogate),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "json-invalid"
  );

  const nonFinite = await writeManifest(
    JSON.stringify(manifest()).replace("4102444800000", "1e400")
  );
  await assert.rejects(
    () => loadPlanningManifest(nonFinite),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "json-invalid"
  );
});

test("rejects invalid graphs and unsupported compiler provenance", async () => {
  const invalid = manifest();
  const capability = {
    capabilityId: "documents.summarize",
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/operator/1.0.0",
    schemaVersion: "1.0.0",
  };
  const invalidFile = await writeManifest(
    JSON.stringify({
      ...invalid,
      planning: {
        ...invalid.planning,
        workflows: [
          {
            allowedCapabilities: [capability.capabilityId],
            catalogFingerprint: hash("a"),
            catalogVersion: "1.0.0",
            compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
            compilerVersion: "1.0.0",
            inputContract: contract,
            outputContract: contract,
            workflow: {
              contentHash: hash("c"),
              nodes: [
                { capability, dependsOn: ["second"], key: "first" },
                { capability, dependsOn: ["first"], key: "second" },
              ],
              revision: "1.0.0",
              workflowSpecId: "workflow-invalid",
            },
            workspaceId: "workspace-local",
          },
        ],
      },
    })
  );

  await assert.rejects(
    () => runPlanningOperator(["--check", "--file", invalidFile], {}),
    (error: unknown) =>
      error instanceof PlanningOperatorError &&
      error.code === "manifest-invalid" &&
      error.mutationState === "not-started"
  );

  const unsupportedCompilerFile = await writeManifest(
    JSON.stringify({
      ...invalid,
      planning: {
        ...invalid.planning,
        workflows: [
          {
            allowedCapabilities: [capability.capabilityId],
            catalogFingerprint: hash("a"),
            catalogVersion: "1.0.0",
            compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
            compilerVersion: "999.0.0",
            inputContract: contract,
            outputContract: contract,
            workflow: {
              contentHash: hash("d"),
              nodes: [
                { capability, dependsOn: [], key: "first" },
                { capability, dependsOn: ["first"], key: "second" },
              ],
              revision: "1.0.0",
              workflowSpecId: "workflow-unsupported-compiler",
            },
            workspaceId: "workspace-local",
          },
        ],
      },
    })
  );
  await assert.rejects(
    () =>
      runPlanningOperator(["--check", "--file", unsupportedCompilerFile], {}),
    (error: unknown) =>
      error instanceof PlanningOperatorError &&
      error.code === "manifest-invalid"
  );
});

test("rejects unknown keys and unsafe files", async () => {
  const unknown = { ...manifest(), unexpected: true };
  const unknownFile = await writeManifest(JSON.stringify(unknown));
  await assert.rejects(
    () => loadPlanningManifest(unknownFile),
    (error: unknown) =>
      error instanceof PlanningOperatorError &&
      error.code === "manifest-invalid"
  );

  const unsafeFile = await writeManifest(JSON.stringify(manifest()));
  await chmod(unsafeFile, 0o666);
  await assert.rejects(
    () => loadPlanningManifest(unsafeFile),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "file-unsafe"
  );

  const symlinkPath = `${unsafeFile}.link`;
  await symlink(unsafeFile, symlinkPath);
  await assert.rejects(
    () => loadPlanningManifest(symlinkPath),
    (error: unknown) =>
      error instanceof PlanningOperatorError && error.code === "file-unsafe"
  );
});
