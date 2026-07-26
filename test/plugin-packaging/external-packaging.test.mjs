// biome-ignore-all lint/suspicious/noMisplacedAssertion: assertion helpers are called only by this node:test case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const fixtureRoot = path.join(repositoryRoot, "test/plugin-packaging/fixture");
const typescriptCli = path.join(
  repositoryRoot,
  "node_modules/typescript/bin/tsc"
);
const npmCli = process.env.npm_execpath;

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
  PATH: process.env.PATH ?? "",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
});

const run = (command, arguments_, options = {}) => {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? commandEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
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

const assertCompiledPackage = (archive, expectedName, includeSource) => {
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
  assert.equal(
    files.includes("package/src/index.ts"),
    includeSource,
    "The private source condition and the files allowlist must agree."
  );
  for (const specification of Object.values(manifest.dependencies ?? {})) {
    assert.equal(specification.startsWith("file:"), false);
    assert.equal(specification.startsWith("workspace:"), false);
  }
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
        name: "kurobara-plugin-packaging-harness",
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

const assertLockedClosure = async () => {
  const lock = JSON.parse(
    await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8")
  );
  const expected = new Map([
    ["packages/plugin-sdk/node_modules/ajv", "8.20.0"],
    ["node_modules/fast-deep-equal", "3.1.3"],
    ["node_modules/fast-uri", "3.1.4"],
    ["node_modules/json-schema-traverse", "1.0.0"],
    ["node_modules/jsonc-parser", "3.3.1"],
    ["node_modules/require-from-string", "2.0.2"],
  ]);
  for (const [key, version] of expected) {
    assert.equal(lock.packages[key]?.version, version, `${key} drifted.`);
  }
};

const pluginRequestPayloads = () => {
  const hash = (character) => `sha256:${character.repeat(64)}`;
  const context = {
    capability: {
      capabilityId: "fixture.echo",
      capabilityVersion: "1.0.0",
    },
    configuration: {
      contentHash: hash("d"),
      value: { endpointProfile: "synthetic" },
    },
    deadlineAtMs: 4_102_444_800_000,
  };
  const inputValue = { document: "synthetic" };
  const input = {
    contentHash: hash("e"),
    contract: {
      catalogFingerprint: hash("a"),
      catalogVersion: "0.6.0",
      schemaFingerprint: hash("b"),
      schemaId:
        "https://schemas.kurobara.invalid/schemas/fixtures/plugin-input/1.0.0",
      schemaVersion: "1.0.0",
    },
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  };
  const operationKey = "operation:external-packaging:exact";
  const quote = {
    expiresAtMs: context.deadlineAtMs,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "credits",
    upperBound: 1,
  };
  const manifest = {
    apiVersion: "dev.kurobara.plugin/v1",
    auth: { modes: ["none"] },
    capabilities: [
      {
        capabilityId: context.capability.capabilityId,
        capabilityVersion: context.capability.capabilityVersion,
        inputContract: input.contract,
        outputContract: {
          catalogFingerprint: hash("a"),
          catalogVersion: "0.6.0",
          schemaFingerprint: hash("c"),
          schemaId:
            "https://schemas.kurobara.invalid/schemas/fixtures/plugin-output/1.0.0",
          schemaVersion: "1.0.0",
        },
      },
    ],
    economics: {
      estimateGuarantee: "hard",
      unit: "credits",
      usageReporting: "exact",
    },
    execution: {
      idempotency: { keyScope: "operation", mode: "native-key" },
      lookup: { authoritativeNotFound: true, mode: "by-operation-key" },
      timeouts: { executeMs: 1000, lookupMs: 1000 },
    },
    id: "dev.kurobara.external-plugin-fixture",
    permissions: { egress: { hosts: [], tlsRequired: true } },
    version: "1.0.0",
  };
  return {
    classifyError: {
      context,
      diagnostic: { kind: "provider-code", providerCode: "SYNTHETIC" },
      phase: "execute",
    },
    describe: {},
    estimate: { context, input },
    execute: {
      context,
      costLimit: { amount: 1, unit: "credits" },
      input,
      operationKey,
      quote,
    },
    health: { context },
    lookup: { context, operationKey },
    manifest,
    normalize: {
      context,
      operationKey,
      outputContract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "0.6.0",
        schemaFingerprint: hash("c"),
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/plugin-output/1.0.0",
        schemaVersion: "1.0.0",
      },
      providerPayload: { echo: "synthetic" },
    },
    operationKey,
    validateConfig: {
      capability: context.capability,
      configuration: context.configuration,
    },
  };
};

test("packs and executes an external plugin using only offline tarballs", async () => {
  assert.equal(process.version, "v24.14.0");
  assert.equal(runNpm(["--version"]).trim(), "10.9.4");
  await assertLockedClosure();

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-plugin-packaging-")
  );
  try {
    const artifactsRoot = path.join(temporaryRoot, "artifacts");
    await mkdir(artifactsRoot, { recursive: true });

    for (const workspace of [
      "@kurobara/plugin-sdk",
      "@kurobara/provider-example",
      "@kurobara/plugin-host",
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
    const providerArchive = packPackage(
      path.join(repositoryRoot, "packages/adapters/provider-example"),
      artifactsRoot
    );
    const hostArchive = packPackage(
      path.join(repositoryRoot, "packages/plugin-host"),
      artifactsRoot
    );

    assertCompiledPackage(sdkArchive, "@kurobara/plugin-sdk", true);
    assertCompiledPackage(providerArchive, "@kurobara/provider-example", true);
    assertCompiledPackage(hostArchive, "@kurobara/plugin-host", true);

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
      providerArchive,
      hostArchive,
      ...closureArchives,
    ];
    const buildHarnessRoot = path.join(temporaryRoot, "build-harness");
    await installHarness(
      buildHarnessRoot,
      internalArchives,
      path.join(temporaryRoot, "build-cache")
    );

    const externalPluginRoot = path.join(
      buildHarnessRoot,
      "external-plugin-fixture"
    );
    await cp(fixtureRoot, externalPluginRoot, { recursive: true });
    run(process.execPath, [typescriptCli, "--project", "tsconfig.json"], {
      cwd: externalPluginRoot,
    });
    const externalPluginArchive = packPackage(
      externalPluginRoot,
      artifactsRoot
    );
    assertCompiledPackage(
      externalPluginArchive,
      "@kurobara/external-plugin-fixture",
      false
    );
    assert.deepEqual(readPackedManifest(externalPluginArchive).dependencies, {
      "@kurobara/plugin-sdk": "0.1.0",
    });

    const runtimeRoot = path.join(temporaryRoot, "runtime-harness");
    await installHarness(
      runtimeRoot,
      [...internalArchives, externalPluginArchive],
      path.join(temporaryRoot, "runtime-cache")
    );

    const runtimeRequire = createRequire(
      path.join(runtimeRoot, "package.json")
    );
    const hostEntry = runtimeRequire.resolve("@kurobara/plugin-host");
    const host = await import(pathToFileURL(hostEntry).href);
    const sidecarPath = path.join(
      runtimeRoot,
      "node_modules/@kurobara/external-plugin-fixture/one-request-sidecar.mjs"
    );
    const requests = pluginRequestPayloads();

    await exerciseInstalledHost({ host, requests, sidecarPath });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

const exerciseInstalledHost = async ({ host, requests, sidecarPath }) => {
  const developmentHost = await host.startDevelopmentPluginHost({
    arguments: [sidecarPath],
    callTimeoutMs: 5000,
    executablePath: process.execPath,
    expectedManifest: requests.manifest,
    workingDirectory: path.dirname(sidecarPath),
  });
  try {
    assert.deepEqual(developmentHost.manifest, requests.manifest);
    assert.deepEqual(developmentHost.manifest.auth.modes, ["none"]);
    assert.deepEqual(developmentHost.manifest.permissions.egress.hosts, []);

    const described = await developmentHost.call("describe", requests.describe);
    assert.deepEqual(described, { manifest: requests.manifest });

    const configuration = await developmentHost.call(
      "validateConfig",
      requests.validateConfig
    );
    assert.deepEqual(configuration, {
      configurationFingerprint:
        requests.validateConfig.configuration.contentHash,
      status: "valid",
    });

    const estimated = await developmentHost.call("estimate", requests.estimate);
    assert.equal(estimated.status, "quoted");
    assert.equal(estimated.quote.guarantee, "hard");
    assert.equal(estimated.quote.upperBound, 1);

    const executed = await developmentHost.call("execute", requests.execute);
    assert.equal(executed.status, "succeeded");
    assert.equal(executed.providerPayload.operation_key, requests.operationKey);
    assert.equal(
      executed.externalOperationReference,
      `external:${requests.operationKey}`
    );

    const lookedUp = await developmentHost.call("lookup", requests.lookup);
    assert.equal(lookedUp.status, "found");
    assert.equal(
      lookedUp.outcome.providerPayload.operation_key,
      requests.operationKey
    );

    const normalized = await developmentHost.call(
      "normalize",
      requests.normalize
    );
    assert.deepEqual(normalized, {
      normalizerVersion: "1.0.0",
      output: requests.normalize.providerPayload,
      status: "normalized",
    });

    const healthResult = await developmentHost.call("health", requests.health);
    assert.equal(healthResult.status, "healthy");

    const classified = await developmentHost.call(
      "classifyError",
      requests.classifyError
    );
    assert.deepEqual(classified, {
      error: { class: "unknown", reasonCode: "unclassified" },
    });
  } finally {
    await developmentHost.close();
  }
};
