import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PluginConformanceReport } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import type { PluginManifestV1 } from "@kurobara/plugin-sdk";

import packageMetadata from "../package.json" with { type: "json" };
import {
  PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX,
  PLUGIN_CONFORMANCE_GUARANTEE_IDS,
  PLUGIN_CONFORMANCE_REPORT_VERSION,
  type RunSidecarConformanceOptions,
  runSidecarConformance,
  serializePluginConformanceReport,
} from "../src/index.ts";
import {
  FIXTURE_EXTERNAL_ID_MANIFEST,
  FIXTURE_LOOKUP_ONLY_MANIFEST,
  FIXTURE_MANIFEST,
  FIXTURE_ONE_SHOT_MANIFEST,
  FIXTURE_TIMEOUT_MANIFEST,
  type FixtureEffectState,
  fixtureRequests,
} from "./fixtures/fixture-values.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sidecarPath = path.join(
  packageRoot,
  "test/fixtures/one-request-sidecar.ts"
);
const catalogMutationProbePath = path.join(
  packageRoot,
  "test/fixtures/catalog-mutation-probe.ts"
);
const catalogMutationPreloadPath = path.join(
  packageRoot,
  "test/fixtures/catalog-mutation-before-runner.ts"
);
const canary = "SYNTHETIC-CONFORMANCE-CANARY";
const INVOCATION_INVALID = /invocation-invalid/u;

interface FixtureRun {
  readonly options: RunSidecarConformanceOptions;
  readonly pidLog: string;
  readonly root: string;
  readonly statePath: string;
}

const fixtureRun = async (
  mode: string,
  manifest?: PluginManifestV1
): Promise<FixtureRun> => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-conformance-"));
  const statePath = path.join(root, "effects.json");
  const pidLog = path.join(root, "pids.log");
  let expectedManifest: PluginManifestV1 = manifest ?? FIXTURE_MANIFEST;
  if (
    !manifest &&
    (mode === "external-id" ||
      mode === "external-id-always-found" ||
      mode === "external-id-operation-key-only")
  ) {
    expectedManifest = FIXTURE_EXTERNAL_ID_MANIFEST;
  } else if (
    !manifest &&
    (mode === "timeout" || mode === "second-execute-timeout")
  ) {
    expectedManifest = FIXTURE_TIMEOUT_MANIFEST;
  } else if (!manifest && mode === "one-shot") {
    expectedManifest = FIXTURE_ONE_SHOT_MANIFEST;
  }
  const baseRequests = fixtureRequests(canary);
  let requests: RunSidecarConformanceOptions["requests"] = baseRequests;
  if (mode === "wrong-lookup-key") {
    requests = Object.freeze({
      ...baseRequests,
      lookup: Object.freeze({
        ...baseRequests.lookup,
        operationKey: "operation:conformance:wrong-lookup",
      }),
    });
  } else if (
    mode === "external-id" ||
    mode === "external-id-always-found" ||
    mode === "external-id-operation-key-only"
  ) {
    requests = Object.freeze({
      ...baseRequests,
      lookup: Object.freeze({
        ...baseRequests.lookup,
        externalOperationReference: `fixture:${baseRequests.execute.operationKey}`,
      }),
    });
  }
  return {
    options: {
      canary,
      effectProbe: {
        read: async () => {
          try {
            const state = JSON.parse(
              await readFile(statePath, "utf8")
            ) as FixtureEffectState;
            return {
              effectCount: state.operationKeys.length,
              operationKeys: state.operationKeys,
            };
          } catch {
            return { effectCount: 0, operationKeys: [] };
          }
        },
      },
      host: {
        arguments: [
          "--conditions=kurobara-source",
          "--experimental-strip-types",
          sidecarPath,
          mode,
          statePath,
          canary,
          pidLog,
        ],
        callTimeoutMs:
          mode === "timeout" || mode === "second-execute-timeout" ? 1500 : 5000,
        executablePath: process.execPath,
        expectedManifest,
        workingDirectory: packageRoot,
      },
      requests,
      subject: {
        artifactFingerprint: `sha256:${"f".repeat(64)}`,
        packageName: "@example/conformance-subject",
        packageVersion: "1.0.0",
      },
    },
    pidLog,
    root,
    statePath,
  };
};

const withFixture = async <Result>(
  mode: string,
  action: (fixture: FixtureRun) => Promise<Result>,
  manifest?: PluginManifestV1
): Promise<Result> => {
  const fixture = await fixtureRun(mode, manifest);
  try {
    return await action(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
};

const guarantee = (report: PluginConformanceReport, id: string) => {
  const selected = report.guarantees.find((candidate) => candidate.id === id);
  if (!selected) {
    throw new Error(`Missing conformance guarantee ${id}.`);
  }
  return selected;
};

const optionsWithMutableProbe = (
  source: RunSidecarConformanceOptions,
  onRead: (readCount: number, options: RunSidecarConformanceOptions) => void
): RunSidecarConformanceOptions => {
  const readEffectState = source.effectProbe.read.bind(source.effectProbe);
  let readCount = 0;
  let mutableOptions: RunSidecarConformanceOptions;
  mutableOptions = {
    ...source,
    effectProbe: {
      read: () => {
        readCount += 1;
        onRead(readCount, mutableOptions);
        return readEffectState();
      },
    },
    host: structuredClone(source.host),
    requests: structuredClone(source.requests),
    subject: structuredClone(source.subject),
  };
  return mutableOptions;
};

test("qualifies one exact local sidecar with observed idempotency", async () => {
  assert.equal(process.version, "v24.14.0");
  const report = await withFixture("good", ({ options }) =>
    runSidecarConformance(options)
  );

  assert.equal(report.summary.status, "passed");
  assert.equal(report.summary.passed, PLUGIN_CONFORMANCE_GUARANTEE_IDS.length);
  assert.equal(report.summary.failed, 0);
  assert.deepEqual(
    report.guarantees.map((candidate) => candidate.id),
    PLUGIN_CONFORMANCE_GUARANTEE_IDS
  );
  assert.equal(
    guarantee(report, "execution.declared-delivery-semantics").status,
    "passed"
  );
  assert.equal(
    guarantee(report, "lookup.declared-reconciliation-no-effect").status,
    "passed"
  );
});

test("keeps the nine-guarantee registry immutable during probing", async () => {
  assert.equal(Object.isFrozen(PLUGIN_CONFORMANCE_GUARANTEE_IDS), true);
  const report = await withFixture("good", ({ options }) => {
    const hostileOptions = optionsWithMutableProbe(options, (readCount) => {
      if (readCount !== 1) {
        return;
      }
      assert.throws(() =>
        (PLUGIN_CONFORMANCE_GUARANTEE_IDS as unknown as string[]).splice(1)
      );
    });
    return runSidecarConformance(hostileOptions);
  });

  assert.equal(PLUGIN_CONFORMANCE_GUARANTEE_IDS.length, 9);
  assert.equal(report.guarantees.length, 9);
  assert.equal(report.summary.total, 9);
  assert.equal(report.summary.status, "passed");
  assert.doesNotThrow(() => serializePluginConformanceReport(report));
});

test("accepts stable omitted external references for native-key idempotency", async () => {
  const report = await withFixture("undefined-reference", ({ options }) =>
    runSidecarConformance(options)
  );

  assert.equal(report.summary.status, "passed");
  assert.equal(
    guarantee(report, "execution.declared-delivery-semantics").status,
    "passed"
  );
  assert.equal(
    guarantee(report, "lookup.declared-reconciliation-no-effect").status,
    "passed"
  );
});

test("accepts omitted references for lookup-only by-operation-key", async () => {
  const report = await withFixture(
    "lookup-only-undefined-reference",
    ({ options }) => runSidecarConformance(options),
    FIXTURE_LOOKUP_ONLY_MANIFEST
  );

  assert.equal(report.summary.status, "passed");
  assert.equal(
    guarantee(report, "execution.declared-delivery-semantics").status,
    "passed"
  );
  assert.equal(
    guarantee(report, "lookup.declared-reconciliation-no-effect").status,
    "passed"
  );
});

test("qualifies authoritative lookup by external operation id", async () => {
  const report = await withFixture(
    "external-id",
    ({ options }) => runSidecarConformance(options),
    FIXTURE_EXTERNAL_ID_MANIFEST
  );

  assert.equal(report.summary.status, "passed");
  assert.equal(
    guarantee(report, "lookup.declared-reconciliation-no-effect").status,
    "passed"
  );
});

test("qualifies one-shot delivery without redelivery or simulated lookup proof", async () => {
  await withFixture("one-shot", async ({ options, statePath }) => {
    const report = await runSidecarConformance(options);
    const state = JSON.parse(
      await readFile(statePath, "utf8")
    ) as FixtureEffectState;

    assert.equal(report.summary.status, "passed");
    assert.equal(report.summary.not_applicable, 0);
    assert.equal(
      guarantee(report, "execution.declared-delivery-semantics").status,
      "passed"
    );
    assert.equal(
      guarantee(report, "lookup.declared-reconciliation-no-effect").status,
      "passed"
    );
    assert.equal(state.executeInvocations, 1);
    assert.equal(state.lookupInvocations, 0);
    assert.deepEqual(state.operationKeys, [
      options.requests.execute.operationKey,
    ]);
  });
});

test("serializes a validated report as byte-identical RFC 8785 JSON plus LF", async () => {
  const report = await withFixture("good", ({ options }) =>
    runSidecarConformance(options)
  );
  const first = serializePluginConformanceReport(report);
  const second = serializePluginConformanceReport(report);

  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(first.slice(0, -1).includes("\n"), false);
  assert.equal(first.includes(canary), false);
  assert.deepEqual(JSON.parse(first), report);

  const reordered = {
    ...report,
    guarantees: [...report.guarantees].reverse(),
  } as unknown as PluginConformanceReport;
  assert.throws(() => serializePluginConformanceReport(reordered));

  const wrongSummary = {
    ...report,
    summary: { ...report.summary, passed: 0 },
  } as unknown as PluginConformanceReport;
  assert.throws(() => serializePluginConformanceReport(wrongSummary));
});

test("pins the matrix to the generated catalog and report schema", () => {
  const combination = PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations[0];
  assert.ok(combination);
  assert.deepEqual(
    PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations.map(
      ({ architecture, platform }) => `${platform}-${architecture}`
    ),
    ["darwin-arm64", "linux-x64"]
  );
  assert.equal(combination.catalog_version, catalogManifest.catalog_version);
  assert.equal(
    combination.catalog_fingerprint,
    catalogManifest.catalog_fingerprint
  );
  assert.equal(
    combination.conformance_report_schema_version,
    PLUGIN_CONFORMANCE_REPORT_VERSION
  );
  assert.equal(combination.conformance_kit_version, packageMetadata.version);
  assert.equal(
    combination.contracts_package_version,
    packageMetadata.dependencies["@kurobara/contracts"]
  );
  assert.equal(
    combination.plugin_host_version,
    packageMetadata.dependencies["@kurobara/plugin-host"]
  );
  assert.equal(
    combination.plugin_sdk_version,
    packageMetadata.dependencies["@kurobara/plugin-sdk"]
  );
  const reportMember = catalogManifest.members.find(
    (member) =>
      member.id ===
      "https://schemas.kurobara.invalid/schemas/plugins/conformance-report/1.0.0"
  );
  assert.equal(
    combination.schema_fingerprints.conformance_report,
    reportMember?.fingerprint
  );
  assert.equal(
    combination.catalog_fingerprint,
    "sha256:1466e9c9bff8bc3c3f3c5e330a5770cb57429cb03bd9a75cc0701c9a71c9744e"
  );
  assert.equal(Object.isFrozen(PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX), true);
  assert.equal(
    Object.isFrozen(PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.profile),
    true
  );
  assert.equal(
    Object.isFrozen(PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations),
    true
  );
  assert.equal(Object.isFrozen(combination), true);
  assert.equal(Object.isFrozen(combination.schema_fingerprints), true);
  assert.throws(() =>
    Object.assign(combination.schema_fingerprints, {
      conformance_report: `sha256:${"0".repeat(64)}`,
    })
  );
});

test("resolves shared toolchains without weakening unsupported reports", async () => {
  const report = await withFixture("good", ({ options }) =>
    runSidecarConformance(options)
  );
  const linuxCombination =
    PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations.find(
      ({ architecture, platform }) =>
        architecture === "x64" && platform === "linux"
    );
  assert.ok(linuxCombination);

  const linuxReport: PluginConformanceReport = {
    ...report,
    environment: {
      architecture: linuxCombination.architecture,
      node_version: linuxCombination.node_version,
      platform: linuxCombination.platform,
    },
  };
  assert.doesNotThrow(() => serializePluginConformanceReport(linuxReport));

  const unsupportedEnvironment = {
    architecture: "x64",
    node_version: "24.14.0",
    platform: "freebsd",
  } as const;
  assert.throws(() =>
    serializePluginConformanceReport({
      ...report,
      environment: unsupportedEnvironment,
    })
  );

  const guarantees = report.guarantees.map((candidate, index) =>
    index === 0
      ? {
          ...candidate,
          reason_codes: ["compatibility-unsupported"] as const,
          status: "failed" as const,
        }
      : {
          ...candidate,
          reason_codes: ["profile-not-applicable"] as const,
          status: "not-applicable" as const,
        }
  );
  const unsupportedReport: PluginConformanceReport = {
    ...report,
    environment: unsupportedEnvironment,
    guarantees,
    summary: {
      failed: 1,
      not_applicable: report.summary.total - 1,
      passed: 0,
      status: "failed",
      total: report.summary.total,
    },
  };
  assert.doesNotThrow(() =>
    serializePluginConformanceReport(unsupportedReport)
  );
});

test("rejects valid-shape report provenance tampering", async () => {
  const report = await withFixture("good", ({ options }) =>
    runSidecarConformance(options)
  );
  const alternateHash = `sha256:${"1".repeat(64)}`;
  const tamperedReports: readonly (readonly [
    string,
    PluginConformanceReport,
  ])[] = [
    [
      "report schema fingerprint",
      { ...report, report_schema_fingerprint: alternateHash },
    ],
    [
      "profile fingerprint",
      {
        ...report,
        profile: { ...report.profile, fingerprint: alternateHash },
      },
    ],
    [
      "compatibility matrix fingerprint",
      {
        ...report,
        profile: {
          ...report.profile,
          compatibility_matrix_fingerprint: alternateHash,
        },
      },
    ],
    [
      "plugin API toolchain version",
      {
        ...report,
        toolchain: {
          ...report.toolchain,
          plugin_api_version: "dev.kurobara.plugin/v2",
        },
      },
    ],
    [
      "SDK toolchain version",
      {
        ...report,
        toolchain: { ...report.toolchain, sdk_package_version: "0.1.1" },
      },
    ],
    [
      "catalog version",
      {
        ...report,
        toolchain: { ...report.toolchain, catalog_version: "0.7.1" },
      },
    ],
    [
      "catalog fingerprint",
      {
        ...report,
        toolchain: { ...report.toolchain, catalog_fingerprint: alternateHash },
      },
    ],
    [
      "qualified environment",
      {
        ...report,
        environment: { ...report.environment, node_version: "24.14.1" },
      },
    ],
    [
      "all-zero artifact fingerprint",
      {
        ...report,
        subject: {
          ...report.subject,
          artifact_fingerprint: `sha256:${"0".repeat(64)}`,
        },
      },
    ],
  ];

  for (const [name, tampered] of tamperedReports) {
    assert.throws(
      () => serializePluginConformanceReport(tampered),
      `Expected ${name} tampering to be rejected.`
    );
  }

  const guarantees = report.guarantees.map((candidate, index) =>
    index === 0
      ? {
          ...candidate,
          reason_codes: ["profile-not-applicable"] as const,
          status: "not-applicable" as const,
        }
      : candidate
  );
  const passedWithNotApplicable = {
    ...report,
    guarantees,
    summary: {
      failed: 0,
      not_applicable: 1,
      passed: report.summary.total - 1,
      status: "passed" as const,
      total: report.summary.total,
    },
  } as unknown as PluginConformanceReport;
  assert.throws(() =>
    serializePluginConformanceReport(passedWithNotApplicable)
  );
});

test("rejects an all-zero artifact assertion before spawning", async () => {
  await withFixture("good", async ({ options, pidLog }) => {
    await assert.rejects(
      runSidecarConformance({
        ...options,
        subject: {
          ...options.subject,
          artifactFingerprint: `sha256:${"0".repeat(64)}`,
        },
      }),
      INVOCATION_INVALID
    );
    await assert.rejects(() => access(pidLog));
  });
});

test("rejects a canary already present in report-bound provenance", async () => {
  await withFixture("good", async ({ options, pidLog }) => {
    await assert.rejects(
      runSidecarConformance({
        ...options,
        canary: "ffffffff",
      }),
      INVOCATION_INVALID
    );
    await assert.rejects(() => access(pidLog));
  });
});

test("rejects a redaction canary absent from classifyError input", async () => {
  await withFixture("good", async ({ options, pidLog }) => {
    await assert.rejects(
      runSidecarConformance({
        ...options,
        requests: {
          ...options.requests,
          classifyError: {
            ...options.requests.classifyError,
            diagnostic: {
              kind: "provider-code",
              providerCode: "DIFFERENT-SYNTHETIC-CANARY",
            },
          },
        },
      }),
      INVOCATION_INVALID
    );
    await assert.rejects(() => access(pidLog));
  });
});

test("rejects a canary colliding with the serialized report structure", async () => {
  await withFixture("good", async ({ options, pidLog }) => {
    const structuralCanary = "guarantees";
    await assert.rejects(
      runSidecarConformance({
        ...options,
        canary: structuralCanary,
        requests: {
          ...options.requests,
          classifyError: {
            ...options.requests.classifyError,
            diagnostic: {
              kind: "provider-code",
              providerCode: structuralCanary,
            },
          },
        },
      }),
      INVOCATION_INVALID
    );
    await assert.rejects(() => access(pidLog));
  });
});

for (const unsafeCanary of ["UNSAFE\nCANARY", "UNSAFE\\CANARY"]) {
  test(`rejects unsafe canary token ${JSON.stringify(unsafeCanary)}`, async () => {
    await withFixture("good", async ({ options, pidLog }) => {
      await assert.rejects(
        runSidecarConformance({
          ...options,
          canary: unsafeCanary,
          requests: {
            ...options.requests,
            classifyError: {
              ...options.requests.classifyError,
              diagnostic: {
                kind: "provider-code",
                providerCode: unsafeCanary,
              },
            },
          },
        }),
        INVOCATION_INVALID
      );
      await assert.rejects(() => access(pidLog));
    });
  });
}

test("snapshots host, requests and canary before the baseline probe", async () => {
  await withFixture("good", async ({ options }) => {
    const mutableOptions = optionsWithMutableProbe(
      options,
      (readCount, candidate) => {
        if (readCount !== 1) {
          return;
        }
        Object.assign(candidate, { canary: "MUTATED-CONFORMANCE-CANARY" });
        Object.assign(candidate.host, { executablePath: sidecarPath });
        Object.assign(candidate.requests.execute, {
          operationKey: "operation:mutated:execute",
        });
        Object.assign(candidate.requests.lookup, {
          operationKey: "operation:mutated:lookup",
        });
      }
    );

    const report = await runSidecarConformance(mutableOptions);
    assert.equal(report.summary.status, "passed");
    assert.equal(report.subject.package_name, options.subject.packageName);
    assert.equal(
      report.subject.artifact_fingerprint,
      options.subject.artifactFingerprint
    );
  });
});

test("keeps original manifest and subject after an effect-probe mutation", async () => {
  await withFixture("good", async ({ options }) => {
    const mutableOptions = optionsWithMutableProbe(
      options,
      (readCount, candidate) => {
        if (readCount !== 2) {
          return;
        }
        Object.assign(candidate.subject, {
          artifactFingerprint: `sha256:${"e".repeat(64)}`,
          packageName: "mutated-conformance-subject",
          packageVersion: "9.9.9",
        });
        Object.assign(candidate.host.expectedManifest, {
          id: "dev.kurobara.mutated",
          version: "9.9.9",
        });
      }
    );

    const report = await runSidecarConformance(mutableOptions);
    const serialized = serializePluginConformanceReport(report);
    assert.equal(report.summary.status, "passed");
    assert.equal(report.subject.package_name, options.subject.packageName);
    assert.equal(
      report.subject.package_version,
      options.subject.packageVersion
    );
    assert.equal(
      report.subject.artifact_fingerprint,
      options.subject.artifactFingerprint
    );
    assert.equal(report.subject.declared_plugin_id, FIXTURE_MANIFEST.id);
    assert.equal(
      report.subject.declared_plugin_version,
      FIXTURE_MANIFEST.version
    );
    assert.equal(serialized.includes("mutated"), false);
  });
});

test("rejects a different executable before spawning", async () => {
  await withFixture("good", async ({ options, pidLog }) => {
    const report = await runSidecarConformance({
      ...options,
      host: { ...options.host, executablePath: sidecarPath },
    });
    assert.deepEqual(
      guarantee(report, "compatibility.exact-versions").reason_codes,
      ["compatibility-unsupported"]
    );
    await assert.rejects(() => access(pidLog));
  });
});

test("attributes an invalid working directory to the adapter only", async () => {
  await withFixture("good", async ({ options, pidLog, root }) => {
    const report = await runSidecarConformance({
      ...options,
      host: {
        ...options.host,
        workingDirectory: path.join(root, "missing-working-directory"),
      },
    });
    assert.equal(
      guarantee(report, "manifest.schema-and-semantics").status,
      "passed"
    );
    assert.deepEqual(guarantee(report, "adapter.exact-surface").reason_codes, [
      "contract-rejected",
    ]);
    await assert.rejects(() => access(pidLog));
  });
});

test("attributes a child process start failure to the adapter only", async () => {
  await withFixture("good", async ({ options, root }) => {
    const report = await runSidecarConformance({
      ...options,
      host: {
        ...options.host,
        arguments: [path.join(root, "missing-sidecar.mjs")],
      },
    });
    assert.equal(
      guarantee(report, "manifest.schema-and-semantics").status,
      "passed"
    );
    assert.deepEqual(guarantee(report, "adapter.exact-surface").reason_codes, [
      "contract-rejected",
    ]);
  });
});

test("reports a malformed manifest without throwing or spawning", async () => {
  const malformed = {} as PluginManifestV1;
  await withFixture(
    "good",
    async ({ options, pidLog }) => {
      const report = await runSidecarConformance(options);
      assert.equal(
        guarantee(report, "compatibility.exact-versions").status,
        "passed"
      );
      assert.deepEqual(
        guarantee(report, "manifest.schema-and-semantics").reason_codes,
        ["contract-rejected"]
      );
      assert.equal(report.subject.declared_plugin_id, undefined);
      assert.equal(report.subject.declared_plugin_version, undefined);
      assert.equal(
        report.toolchain.plugin_api_version,
        "dev.kurobara.plugin/v1"
      );
      assert.doesNotThrow(() => serializePluginConformanceReport(report));
      await assert.rejects(() => access(pidLog));
    },
    malformed
  );
});

test("rejects an unsupported plugin version before spawning", async () => {
  const unsupported = {
    ...FIXTURE_MANIFEST,
    apiVersion: "dev.kurobara.plugin/v2",
  } as unknown as PluginManifestV1;
  await withFixture(
    "good",
    async ({ options, pidLog }) => {
      const report = await runSidecarConformance(options);
      assert.equal(report.summary.status, "failed");
      assert.deepEqual(
        guarantee(report, "compatibility.exact-versions").reason_codes,
        ["compatibility-unsupported"]
      );
      await assert.rejects(() => access(pidLog));
    },
    unsupported
  );
});

test("rejects an unknown catalog contract reference before spawning", async () => {
  const unknownContractManifest = structuredClone(FIXTURE_MANIFEST);
  Object.assign(unknownContractManifest.capabilities[0].inputContract, {
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    schemaId:
      "https://schemas.kurobara.invalid/schemas/fixtures/unknown-input/1.0.0",
  });
  await withFixture(
    "good",
    async ({ options, pidLog }) => {
      const report = await runSidecarConformance(options);
      assert.deepEqual(
        guarantee(report, "compatibility.exact-versions").reason_codes,
        ["compatibility-unsupported"]
      );
      assert.equal(
        guarantee(report, "manifest.schema-and-semantics").status,
        "passed"
      );
      await assert.rejects(() => access(pidLog));
    },
    unknownContractManifest
  );
});

test("rejects a catalog member injected before an isolated runner import", async () => {
  await withFixture("good", async ({ pidLog }) => {
    const probe = spawnSync(
      process.execPath,
      [
        "--conditions=kurobara-source",
        "--experimental-strip-types",
        "--import",
        catalogMutationPreloadPath,
        catalogMutationProbePath,
        pidLog,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
      }
    );
    assert.equal(probe.status, 0, probe.stderr);
    await assert.rejects(() => access(pidLog));
  });
});

for (const baselineCanaryMode of ["observation", "throw"] as const) {
  test(`attributes a baseline canary ${baselineCanaryMode} to redaction`, async () => {
    await withFixture("good", async ({ options, pidLog }) => {
      const report = await runSidecarConformance({
        ...options,
        effectProbe: {
          read: () => {
            if (baselineCanaryMode === "throw") {
              return Promise.reject(new Error(canary));
            }
            return Promise.resolve({
              effectCount: -1,
              operationKeys: [canary],
            });
          },
        },
      });
      assert.deepEqual(
        guarantee(report, "execution.declared-delivery-semantics").reason_codes,
        ["behavior-mismatch"]
      );
      assert.deepEqual(
        guarantee(report, "redaction.canary-absent").reason_codes,
        ["forbidden-observation"]
      );
      assert.equal(
        serializePluginConformanceReport(report).includes(canary),
        false
      );
      await assert.rejects(() => access(pidLog));
    });
  });
}

for (const scenario of [
  {
    guaranteeId: "protocol.closed-messages",
    mode: "invalid-response",
    reason: "contract-rejected",
  },
  {
    guaranteeId: "errors.closed-and-redacted",
    mode: "invalid-error",
    reason: "contract-rejected",
  },
  {
    guaranteeId: "timeouts.call-bound",
    mode: "timeout",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "timeouts.call-bound",
    mode: "second-execute-timeout",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "execution.declared-delivery-semantics",
    mode: "double-effect",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "lookup-effect",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "wrong-lookup-key",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "execution.declared-delivery-semantics",
    mode: "redelivery-reference-drift",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "lookup-reference-drift",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "lookup-failed-outcome",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "lookup-always-found",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "external-id-always-found",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "lookup.declared-reconciliation-no-effect",
    mode: "external-id-operation-key-only",
    reason: "behavior-mismatch",
  },
  {
    guaranteeId: "redaction.canary-absent",
    mode: "redaction",
    reason: "forbidden-observation",
  },
] as const) {
  test(`fails ${scenario.guaranteeId} for ${scenario.mode}`, async () => {
    const report = await withFixture(scenario.mode, ({ options }) =>
      runSidecarConformance(options)
    );
    const result = guarantee(report, scenario.guaranteeId);
    assert.equal(report.summary.status, "failed");
    assert.equal(result.status, "failed");
    assert.equal(result.reason_codes.includes(scenario.reason), true);
    assert.equal(
      serializePluginConformanceReport(report).includes(canary),
      false
    );
  });
}
