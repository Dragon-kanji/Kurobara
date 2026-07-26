// biome-ignore-all lint/suspicious/noMisplacedAssertion: assertion helpers are called only by this node:test case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const templateRoot = path.join(repositoryRoot, "templates/plugin-adapter");
const typescriptCli = path.join(
  repositoryRoot,
  "node_modules/typescript/bin/tsc"
);
const npmCli = process.env.npm_execpath;
const REDACTION_CANARY = "synthetic-redaction-canary";
const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

// Deliberate allowlist: credentials, proxies, NODE_OPTIONS, and
// Kurobara/provider-specific variables are never inherited by child processes.
const commandEnvironment = Object.freeze({
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  COREPACK_ENABLE_NETWORK: "0",
  HOME: process.env.HOME ?? "",
  NODE_OPTIONS: "",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_userconfig: "/dev/null",
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
});

const execute = (command, arguments_, options = {}) =>
  spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? commandEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });

const run = (command, arguments_, options = {}) => {
  const result = execute(command, arguments_, options);
  assert.equal(
    result.status,
    0,
    [
      `${command} ${arguments_.join(" ")} exited with ${result.status}.`,
      result.stdout,
      result.stderr,
    ].join("\n")
  );
  return result.stdout;
};

const runNpm = (arguments_, options = {}) => {
  assert.ok(npmCli, "npm_execpath is required for packaging tests.");
  return run(process.execPath, [npmCli, ...arguments_], options);
};

const relativeFileSpecifier = (fromDirectory, file) => {
  const relative = path.relative(fromDirectory, file).split(path.sep).join("/");
  return `file:${relative.startsWith(".") ? relative : `./${relative}`}`;
};

const packPackage = (packageRoot, artifactsRoot) => {
  const output = runNpm([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    artifactsRoot,
    "--cache",
    path.join(artifactsRoot, "..", "pack-cache"),
    packageRoot,
  ]);
  const filename = output.trim().split("\n").at(-1);
  assert.ok(filename, `npm pack did not return a filename for ${packageRoot}.`);
  return path.join(artifactsRoot, filename);
};

const readPackedManifest = (archive) =>
  JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));

const listPackedFiles = (archive) =>
  run("tar", ["-tzf", archive])
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0);

const assertVersionSpecifications = (manifest) => {
  for (const dependencyMap of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const specification of Object.values(dependencyMap ?? {})) {
      assert.equal(specification.startsWith("file:"), false);
      assert.equal(specification.startsWith("workspace:"), false);
    }
  }
  for (const specification of Object.values(manifest.dependencies ?? {})) {
    assert.match(specification, EXACT_SEMVER);
  }
};

const assertCompiledPackage = (archive, expectedName) => {
  const manifest = readPackedManifest(archive);
  const files = listPackedFiles(archive);
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.engines?.node, "24.14.0");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.ok(files.includes("package/dist/index.js"));
  assert.ok(files.includes("package/dist/index.d.ts"));
  assert.equal(
    files.some((entry) => entry.includes("/test/")),
    false
  );
  assert.equal(
    files.some((entry) => entry.includes("tsconfig")),
    false
  );
  assertVersionSpecifications(manifest);
};

const assertTemplateArchive = (archive) => {
  const manifest = readPackedManifest(archive);
  const files = listPackedFiles(archive);
  assert.equal(manifest.name, "@example/kurobara-plugin-adapter");
  assert.equal(manifest.engines?.node, "24.14.0");
  assert.deepEqual(manifest.dependencies, {
    "@kurobara/plugin-sdk": "0.1.0",
  });
  assert.deepEqual(manifest.devDependencies, {
    "@kurobara/plugin-conformance": "0.1.0",
    typescript: "5.9.3",
  });
  assertVersionSpecifications(manifest);
  assert.ok(files.includes("package/dist/index.js"));
  assert.ok(files.includes("package/dist/index.d.ts"));
  assert.ok(files.includes("package/conformance.mjs"));
  assert.ok(files.includes("package/sidecar.mjs"));
  assert.equal(
    files.some((entry) => entry.includes("/src/")),
    false
  );
  assert.equal(
    files.some((entry) => entry.includes("tsconfig")),
    false
  );
};

const writeHarnessManifest = async (harnessRoot, archives) => {
  const dependencies = {};
  for (const archive of archives) {
    const manifest = readPackedManifest(archive);
    dependencies[manifest.name] = relativeFileSpecifier(harnessRoot, archive);
  }
  await writeFile(
    path.join(harnessRoot, "package.json"),
    `${JSON.stringify(
      {
        dependencies,
        name: "kurobara-plugin-conformance-packaging-harness",
        private: true,
        type: "module",
        version: "0.0.0",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
};

const installHarness = async (harnessRoot, archives, cacheRoot) => {
  await mkdir(harnessRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await writeHarnessManifest(harnessRoot, archives);
  runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      cacheRoot,
    ],
    { cwd: harnessRoot }
  );
  runNpm(["ls", "--all"], { cwd: harnessRoot });
};

const assertExternalTypeResolution = async (harnessRoot) => {
  await writeFile(
    path.join(harnessRoot, "conformance-probe.ts"),
    [
      'import { runSidecarConformance, type RunSidecarConformanceOptions } from "@kurobara/plugin-conformance";',
      "",
      "export const qualify = (options: RunSidecarConformanceOptions) =>",
      "  runSidecarConformance(options);",
      "",
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(harnessRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2024",
          verbatimModuleSyntax: true,
        },
        files: ["conformance-probe.ts"],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  run(process.execPath, [typescriptCli, "--project", "tsconfig.json"], {
    cwd: harnessRoot,
  });
};

const packageFingerprint = async (archive) =>
  `sha256:${createHash("sha256")
    .update(await readFile(archive))
    .digest("hex")}`;

const installedTemplatePaths = (runtimeRoot) => {
  const packageRoot = path.join(
    runtimeRoot,
    "node_modules/@example/kurobara-plugin-adapter"
  );
  return {
    conformance: path.join(packageRoot, "conformance.mjs"),
    packageRoot,
  };
};

const runConformance = ({
  artifactFingerprint,
  journalPath,
  mode,
  runtimeRoot,
}) => {
  const paths = installedTemplatePaths(runtimeRoot);
  return execute(
    process.execPath,
    [
      paths.conformance,
      "--artifact-fingerprint",
      artifactFingerprint,
      "--journal",
      journalPath,
      "--mode",
      mode,
    ],
    { cwd: paths.packageRoot }
  );
};

const parseReportOutput = (result, expectedStatus) => {
  assert.equal(
    result.status,
    expectedStatus,
    `${result.stderr}\n${result.stdout}`
  );
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.trim().includes("\n"), false);
  assert.equal(result.stdout.includes(REDACTION_CANARY), false);
  return JSON.parse(result.stdout);
};

const failedGuarantee = (report, guaranteeId) =>
  report.guarantees.find((guarantee) => guarantee.id === guaranteeId)?.status;

test("packs and qualifies the external adapter template using only offline tarballs", async () => {
  assert.equal(process.version, "v24.14.0");
  assert.equal(runNpm(["--version"]).trim(), "10.9.4");

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-conformance-packaging-")
  );
  try {
    const artifactsRoot = path.join(temporaryRoot, "artifacts");
    await mkdir(artifactsRoot, { recursive: true });

    for (const workspace of [
      "@kurobara/plugin-sdk",
      "@kurobara/plugin-host",
      "@kurobara/plugin-conformance",
    ]) {
      runNpm(["run", "build", "-w", workspace]);
    }

    const contractsArchive = packPackage(
      path.join(repositoryRoot, "packages/contracts"),
      artifactsRoot
    );
    const sdkArchive = packPackage(
      path.join(repositoryRoot, "packages/plugin-sdk"),
      artifactsRoot
    );
    const hostArchive = packPackage(
      path.join(repositoryRoot, "packages/plugin-host"),
      artifactsRoot
    );
    const conformanceArchive = packPackage(
      path.join(repositoryRoot, "packages/plugin-conformance"),
      artifactsRoot
    );

    assertVersionSpecifications(readPackedManifest(contractsArchive));
    assertCompiledPackage(sdkArchive, "@kurobara/plugin-sdk");
    assertCompiledPackage(hostArchive, "@kurobara/plugin-host");
    assertCompiledPackage(conformanceArchive, "@kurobara/plugin-conformance");

    const closureArchives = [
      path.join(repositoryRoot, "packages/plugin-sdk/node_modules/ajv"),
      path.join(repositoryRoot, "node_modules/fast-deep-equal"),
      path.join(repositoryRoot, "node_modules/fast-uri"),
      path.join(repositoryRoot, "node_modules/json-schema-traverse"),
      path.join(repositoryRoot, "node_modules/jsonc-parser"),
      path.join(repositoryRoot, "node_modules/require-from-string"),
    ].map((packageRoot) => packPackage(packageRoot, artifactsRoot));

    const internalArchives = [
      contractsArchive,
      sdkArchive,
      hostArchive,
      conformanceArchive,
      ...closureArchives,
    ];
    const buildHarnessRoot = path.join(temporaryRoot, "build-harness");
    await installHarness(
      buildHarnessRoot,
      internalArchives,
      path.join(temporaryRoot, "build-cache")
    );
    await assertExternalTypeResolution(buildHarnessRoot);

    const externalTemplateRoot = path.join(
      buildHarnessRoot,
      "external-plugin-adapter"
    );
    await cp(templateRoot, externalTemplateRoot, { recursive: true });
    run(process.execPath, [typescriptCli, "--project", "tsconfig.json"], {
      cwd: externalTemplateRoot,
    });
    const templateArchive = packPackage(externalTemplateRoot, artifactsRoot);
    assertTemplateArchive(templateArchive);
    const artifactFingerprint = await packageFingerprint(templateArchive);

    const runtimeRoot = path.join(temporaryRoot, "runtime-harness");
    await installHarness(
      runtimeRoot,
      [...internalArchives, templateArchive],
      path.join(temporaryRoot, "runtime-cache")
    );

    const first = runConformance({
      artifactFingerprint,
      journalPath: path.join(temporaryRoot, "first-journal.json"),
      mode: "conformant",
      runtimeRoot,
    });
    const firstReport = parseReportOutput(first, 0);
    assert.equal(firstReport.summary.status, "passed");
    assert.equal(firstReport.subject.artifact_fingerprint, artifactFingerprint);
    assert.equal(
      firstReport.guarantees.every(
        (guarantee) => guarantee.status === "passed"
      ),
      true
    );
    const second = runConformance({
      artifactFingerprint,
      journalPath: path.join(temporaryRoot, "second-journal.json"),
      mode: "conformant",
      runtimeRoot,
    });
    const secondReport = parseReportOutput(second, 0);
    assert.deepEqual(secondReport, firstReport);
    assert.equal(second.stdout, first.stdout);

    const defectiveModes = new Map([
      ["errors", "errors.closed-and-redacted"],
      ["idempotence", "execution.declared-delivery-semantics"],
      ["lookup-always-found", "lookup.declared-reconciliation-no-effect"],
      ["lookup-failed-outcome", "lookup.declared-reconciliation-no-effect"],
      ["lookup-mismatch", "lookup.declared-reconciliation-no-effect"],
      ["redaction", "redaction.canary-absent"],
      ["redelivery-reference-drift", "execution.declared-delivery-semantics"],
      ["schema", "protocol.closed-messages"],
      ["second-execute-timeout", "timeouts.call-bound"],
      ["timeout", "timeouts.call-bound"],
    ]);
    for (const [mode, guaranteeId] of defectiveModes) {
      const defective = runConformance({
        artifactFingerprint,
        journalPath: path.join(temporaryRoot, `${mode}-journal.json`),
        mode,
        runtimeRoot,
      });
      const defectiveReport = parseReportOutput(defective, 1);
      assert.equal(failedGuarantee(defectiveReport, guaranteeId), "failed");
    }

    const invalidInvocation = execute(
      process.execPath,
      [installedTemplatePaths(runtimeRoot).conformance],
      { cwd: installedTemplatePaths(runtimeRoot).packageRoot }
    );
    assert.equal(invalidInvocation.status, 2);
    assert.equal(invalidInvocation.stdout, "");
    assert.equal(
      invalidInvocation.stderr,
      "plugin-conformance-invocation-invalid\n"
    );

    const zeroFingerprintInvocation = runConformance({
      artifactFingerprint: `sha256:${"0".repeat(64)}`,
      journalPath: path.join(temporaryRoot, "zero-fingerprint-journal.json"),
      mode: "conformant",
      runtimeRoot,
    });
    assert.equal(zeroFingerprintInvocation.status, 2);
    assert.equal(zeroFingerprintInvocation.stdout, "");
    assert.equal(
      zeroFingerprintInvocation.stderr,
      "plugin-conformance-invocation-invalid\n"
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
