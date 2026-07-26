import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const REQUIRED_NODE_VERSION = "24.14.0";
const REQUIRED_NPM_VERSION = "10.9.4";
const REQUIRED_ESBUILD_VERSION = "0.28.1";
const EXPECTED_RUNTIME_BUNDLE_IDS = Object.freeze([
  "cli",
  "api",
  "worker-heartbeat",
  "worker",
  "bootstrap-api-key",
  "bootstrap-planning",
]);
const TEST_DIRTY_ENVIRONMENT = "KUROBARA_RELEASE_TEST_ONLY_ALLOW_DIRTY";
const TEST_FAIL_AFTER_OUTPUT_ENVIRONMENT =
  "KUROBARA_RELEASE_TEST_ONLY_FAIL_AFTER_OUTPUT_CREATE";
const GIT_TIMESTAMP_PATTERN = /^\d+$/u;
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const WHITESPACE_PATTERN = /\s+/u;
const JSON_INDENT = 2;
const compareStrings = (left, right) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const hasExecutableBit = (mode) => {
  const permissions = mode % 0o1000;
  return [0o100, 0o010, 0o001].some(
    (bit) => Math.floor(permissions / bit) % 2 === 1
  );
};

export class ReleaseCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReleaseCandidateError";
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const sha256File = async (file) => sha256(await readFile(file));

const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, JSON_INDENT)}\n`, "utf8");

const pathExists = async (candidate) => {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const createFreshDirectory = async (directory, code) => {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ReleaseCandidateError(
        code,
        "The requested output directory already exists."
      );
    }
    throw error;
  }
};

const normalizedAbsolutePath = (candidate, code) => {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    !path.isAbsolute(candidate)
  ) {
    throw new ReleaseCandidateError(code, "An absolute path is required.");
  }
  return path.normalize(candidate);
};

export const createReleaseChildEnvironment = (
  source = process.env,
  overrides = {}
) =>
  Object.freeze({
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: source.HOME ?? tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    NODE_OPTIONS: "",
    PATH: source.PATH ?? "",
    TMPDIR: source.TMPDIR ?? tmpdir(),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: "/dev/null",
    ...overrides,
  });

const run = (
  command,
  arguments_,
  { cwd = REPOSITORY_ROOT, environment, maximumBytes = 32 * 1024 * 1024 } = {}
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment ?? createReleaseChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumBytes) {
        child.kill("SIGKILL");
        reject(
          new ReleaseCandidateError(
            "release-child-output-too-large",
            "A release child process exceeded its output budget."
          )
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const result = {
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (status === 0) {
        resolve(result);
        return;
      }
      reject(
        Object.assign(
          new ReleaseCandidateError(
            "release-child-failed",
            `${path.basename(command)} exited without a successful status.`
          ),
          { result }
        )
      );
    });
  });

const runGit = (arguments_, repositoryRoot = REPOSITORY_ROOT) =>
  run("git", ["-C", repositoryRoot, ...arguments_], {
    environment: createReleaseChildEnvironment(),
  });

export const inspectTrackedWorktree = async (
  repositoryRoot = REPOSITORY_ROOT
) => {
  const result = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=no"],
    repositoryRoot
  );
  return {
    clean: result.stdout.length === 0,
    status: result.stdout,
  };
};

const assertDirtyOverride = (allowDirtyForTests, environment) => {
  if (!allowDirtyForTests) {
    return;
  }
  if (
    environment.NODE_ENV !== "test" ||
    environment[TEST_DIRTY_ENVIRONMENT] !== "true"
  ) {
    throw new ReleaseCandidateError(
      "release-dirty-override-forbidden",
      "The dirty-worktree override is restricted to an explicit test process."
    );
  }
};

const resolveNpmCli = async (environment) => {
  const candidate =
    environment.KUROBARA_RELEASE_NPM_CLI ?? environment.npm_execpath;
  const npmCli = normalizedAbsolutePath(candidate, "release-npm-cli-required");
  const resolved = await realpath(npmCli);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new ReleaseCandidateError(
      "release-npm-cli-invalid",
      "The configured npm CLI is not a regular file."
    );
  }
  const result = await run(process.execPath, [resolved, "--version"]);
  const version = result.stdout.trim();
  if (version !== REQUIRED_NPM_VERSION) {
    throw new ReleaseCandidateError(
      "release-npm-version-mismatch",
      `The release requires npm ${REQUIRED_NPM_VERSION}.`
    );
  }
  return { file: resolved, version };
};

const readSourceIdentity = async (repositoryRoot = REPOSITORY_ROOT) => {
  const commitResult = await runGit(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    repositoryRoot
  );
  const commit = commitResult.stdout.trim();
  if (!GIT_OBJECT_ID_PATTERN.test(commit)) {
    throw new ReleaseCandidateError(
      "release-source-commit-invalid",
      "The source commit identifier is invalid."
    );
  }
  const [tree, timestamp] = await Promise.all([
    runGit(["rev-parse", "--verify", `${commit}^{tree}`], repositoryRoot),
    runGit(["show", "-s", "--format=%ct", commit], repositoryRoot),
  ]);
  if (!GIT_TIMESTAMP_PATTERN.test(timestamp.stdout.trim())) {
    throw new ReleaseCandidateError(
      "release-source-timestamp-invalid",
      "The source commit timestamp is invalid."
    );
  }
  return {
    commit,
    sourceDateEpoch: Number(timestamp.stdout.trim()),
    tree: tree.stdout.trim(),
  };
};

const readRootManifest = async (sourceRoot) => {
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8")
  );
  if (
    manifest.packageManager !== `npm@${REQUIRED_NPM_VERSION}` ||
    manifest.engines?.node !== REQUIRED_NODE_VERSION ||
    !SEMANTIC_VERSION_PATTERN.test(manifest.version)
  ) {
    throw new ReleaseCandidateError(
      "release-root-manifest-invalid",
      "The root runtime, package manager, or version is not release-qualified."
    );
  }
  return manifest;
};

const createToolBin = async (temporaryRoot, npmCli) => {
  const toolBin = path.join(temporaryRoot, "tool-bin");
  await mkdir(toolBin);
  await Promise.all([
    symlink(process.execPath, path.join(toolBin, "node")),
    symlink(npmCli, path.join(toolBin, "npm")),
  ]);
  return toolBin;
};

const npmEnvironment = (
  temporaryRoot,
  toolBin,
  sourceEnvironment,
  overrides = {}
) =>
  createReleaseChildEnvironment(sourceEnvironment, {
    HOME: path.join(temporaryRoot, "home"),
    PATH: `${toolBin}${path.delimiter}${sourceEnvironment.PATH ?? ""}`,
    ...overrides,
  });

const assertSafeRepositoryRelativePath = (candidate) => {
  if (
    candidate.length === 0 ||
    path.isAbsolute(candidate) ||
    candidate.split("/").includes("..")
  ) {
    throw new ReleaseCandidateError(
      "release-source-path-invalid",
      "Git returned an unsafe source path."
    );
  }
};

const copyDirtyTestSnapshot = async (repositoryRoot, sourceRoot) => {
  const listed = await runGit(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repositoryRoot
  );
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    assertSafeRepositoryRelativePath(relativePath);
    const source = path.join(repositoryRoot, relativePath);
    const destination = path.join(sourceRoot, relativePath);
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    if (metadata.isFile()) {
      await copyFile(source, destination);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
      continue;
    }
    throw new ReleaseCandidateError(
      "release-source-type-invalid",
      "The test-only source snapshot contains an unsupported file type."
    );
  }
};

export const materializeReleaseSource = async ({
  allowDirtyForTests = false,
  environment = createReleaseChildEnvironment(),
  repositoryRoot = REPOSITORY_ROOT,
  sourceCommit,
  sourceRoot,
  temporaryRoot,
}) => {
  await mkdir(sourceRoot);
  if (allowDirtyForTests) {
    await copyDirtyTestSnapshot(repositoryRoot, sourceRoot);
  } else {
    const archive = path.join(temporaryRoot, "committed-source.tar");
    await run(
      "git",
      [
        "-C",
        repositoryRoot,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        sourceCommit,
      ],
      { environment }
    );
    await run("tar", ["-xf", archive, "-C", sourceRoot], { environment });
  }
  if (await pathExists(path.join(sourceRoot, "node_modules"))) {
    throw new ReleaseCandidateError(
      "release-source-node-modules-present",
      "The isolated source unexpectedly contains node_modules."
    );
  }
  return sourceRoot;
};

export const installLockedReleaseDependencies = async ({
  childEnvironment,
  npmCli,
  sourceRoot,
  temporaryRoot,
}) => {
  const lockfile = path.join(sourceRoot, "package-lock.json");
  const lockfileSha256 = await sha256File(lockfile);
  await run(
    process.execPath,
    [
      npmCli,
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(temporaryRoot, "npm-ci-cache"),
    ],
    { cwd: sourceRoot, environment: childEnvironment }
  );
  if ((await sha256File(lockfile)) !== lockfileSha256) {
    throw new ReleaseCandidateError(
      "release-lockfile-mutated",
      "npm ci changed the isolated package lock."
    );
  }
  return {
    installation: "npm-ci",
    lockfileSha256,
  };
};

const parseRuntimeReceipt = (stdout, outputDirectory) => {
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch (cause) {
    throw Object.assign(
      new ReleaseCandidateError(
        "release-runtime-receipt-invalid",
        "The isolated runtime builder did not return JSON."
      ),
      { cause }
    );
  }
  if (
    receipt.status !== "built" ||
    receipt.node_version !== REQUIRED_NODE_VERSION ||
    receipt.esbuild_version !== REQUIRED_ESBUILD_VERSION ||
    !Array.isArray(receipt.bundles) ||
    receipt.bundles.length !== EXPECTED_RUNTIME_BUNDLE_IDS.length
  ) {
    throw new ReleaseCandidateError(
      "release-runtime-receipt-invalid",
      "The isolated runtime builder returned an unexpected receipt."
    );
  }
  const bundles = receipt.bundles.map((bundle, index) => {
    if (
      bundle === null ||
      typeof bundle !== "object" ||
      bundle.id !== EXPECTED_RUNTIME_BUNDLE_IDS[index] ||
      typeof bundle.executable !== "boolean" ||
      typeof bundle.output_file !== "string" ||
      typeof bundle.source !== "string" ||
      typeof bundle.source_manifest !== "string" ||
      !Array.isArray(bundle.included_inputs) ||
      bundle.included_inputs.some((input) => typeof input !== "string")
    ) {
      throw new ReleaseCandidateError(
        "release-runtime-receipt-invalid",
        "The isolated runtime builder returned an invalid bundle."
      );
    }
    for (const candidate of [
      bundle.output_file,
      bundle.source,
      bundle.source_manifest,
    ]) {
      assertSafeRepositoryRelativePath(candidate);
    }
    const outputFile = path.resolve(outputDirectory, bundle.output_file);
    if (
      outputFile === outputDirectory ||
      !outputFile.startsWith(`${outputDirectory}${path.sep}`)
    ) {
      throw new ReleaseCandidateError(
        "release-runtime-receipt-invalid",
        "A runtime output escaped the candidate directory."
      );
    }
    return {
      executable: bundle.executable,
      id: bundle.id,
      includedInputs: bundle.included_inputs,
      outputFile,
      source: bundle.source,
      sourceManifest: bundle.source_manifest,
    };
  });
  return {
    bundles,
    esbuildVersion: receipt.esbuild_version,
    nodeVersion: receipt.node_version,
    outputDirectory,
  };
};

const runRuntimeBuilder = async ({
  childEnvironment,
  outputDirectory,
  sourceRoot,
}) => {
  const result = await run(
    process.execPath,
    [
      path.join(sourceRoot, "scripts/build-runtime.mjs"),
      "--output",
      outputDirectory,
    ],
    { cwd: sourceRoot, environment: childEnvironment }
  );
  return parseRuntimeReceipt(result.stdout, outputDirectory);
};

const describeSourceSnapshot = async (root, current = root) => {
  const entries = (await readdir(current, { withFileTypes: true })).sort(
    (left, right) => compareStrings(left.name, right.name)
  );
  const description = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (entry.isDirectory()) {
      description.push({ path: `${relative}/`, type: "directory" });
      description.push(...(await describeSourceSnapshot(root, absolute)));
      continue;
    }
    if (entry.isFile()) {
      description.push({
        executable: hasExecutableBit(metadata.mode),
        path: relative,
        sha256: await sha256File(absolute),
        type: "file",
      });
      continue;
    }
    if (entry.isSymbolicLink()) {
      description.push({
        path: relative,
        target: await readlink(absolute),
        type: "symlink",
      });
      continue;
    }
    throw new ReleaseCandidateError(
      "release-source-type-invalid",
      "The release source contains an unsupported file type."
    );
  }
  return description;
};

const assertSourceArchiveEquivalent = async ({
  archive,
  childEnvironment,
  sourceRoot,
  temporaryRoot,
  version,
}) => {
  const extractionRoot = path.join(
    temporaryRoot,
    "source-archive-verification"
  );
  await mkdir(extractionRoot);
  await run("tar", ["-xzf", archive, "-C", extractionRoot], {
    environment: childEnvironment,
  });
  const archivedSourceRoot = path.join(extractionRoot, `kurobara-${version}`);
  if (!(await pathExists(archivedSourceRoot))) {
    throw new ReleaseCandidateError(
      "release-source-archive-invalid",
      "The distributed source archive is missing its expected root."
    );
  }
  const [buildInput, distributedSource] = await Promise.all([
    describeSourceSnapshot(sourceRoot),
    describeSourceSnapshot(archivedSourceRoot),
  ]);
  if (JSON.stringify(buildInput) !== JSON.stringify(distributedSource)) {
    throw new ReleaseCandidateError(
      "release-source-archive-drift",
      "The distributed source archive differs from the isolated build input."
    );
  }
};

const createSourceArchive = async (
  outputDirectory,
  version,
  sourceIdentity,
  childEnvironment,
  { allowDirtyForTests, sourceRoot, temporaryRoot }
) => {
  const sourceDirectory = path.join(outputDirectory, "source");
  await mkdir(sourceDirectory);
  const filename = `kurobara-${version}-source.tar.gz`;
  const archive = path.join(sourceDirectory, filename);
  if (allowDirtyForTests) {
    await run("tar", ["-czf", archive, "-C", sourceRoot, "."], {
      environment: childEnvironment,
    });
    return archive;
  }
  await run(
    "git",
    [
      "-C",
      REPOSITORY_ROOT,
      "archive",
      "--format=tar.gz",
      `--prefix=kurobara-${version}/`,
      `--output=${archive}`,
      sourceIdentity.commit,
    ],
    { environment: childEnvironment }
  );
  await assertSourceArchiveEquivalent({
    archive,
    childEnvironment,
    sourceRoot,
    temporaryRoot,
    version,
  });
  return archive;
};

const readPackageCatalog = async (sourceRoot) => {
  const catalog = JSON.parse(
    await readFile(
      path.join(sourceRoot, "release/package-catalog.json"),
      "utf8"
    )
  );
  if (
    catalog.schema_version !== 1 ||
    !Array.isArray(catalog.public_packages) ||
    catalog.public_packages.length !== 1 ||
    catalog.public_packages[0]?.name !== "@kurobara/cli" ||
    catalog.public_packages[0]?.bundle !== "cli" ||
    catalog.public_packages[0]?.kind !== "standalone-cli"
  ) {
    throw new ReleaseCandidateError(
      "release-package-catalog-invalid",
      "The release package catalog must select only the standalone CLI."
    );
  }
  return catalog;
};

const stageStandaloneCli = async ({
  runtime,
  sourceRoot,
  stageRoot,
  version,
}) => {
  const stage = path.join(stageRoot, "kurobara-cli");
  const distribution = path.join(stage, "dist");
  await mkdir(stage);
  await mkdir(distribution);
  const cliBundle = runtime.bundles.find((bundle) => bundle.id === "cli");
  if (cliBundle === undefined) {
    throw new ReleaseCandidateError(
      "release-cli-bundle-missing",
      "The standalone CLI runtime bundle is missing."
    );
  }
  await Promise.all([
    copyFile(cliBundle.outputFile, path.join(distribution, "kurobara.js")),
    copyFile(path.join(sourceRoot, "LICENSE"), path.join(stage, "LICENSE")),
    copyFile(
      path.join(sourceRoot, "THIRD_PARTY_NOTICES.md"),
      path.join(stage, "THIRD_PARTY_NOTICES.md")
    ),
  ]);
  await writeFile(
    path.join(distribution, "index.js"),
    [
      "#!/usr/bin/env node",
      "",
      'const helpRequested = process.argv.length === 3 && process.argv[2] === "--help";',
      'await import("./kurobara.js");',
      "if (helpRequested && process.exitCode === 2) {",
      "  process.exitCode = 0;",
      "}",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  await writeFile(
    path.join(stage, "README.md"),
    [
      "# @kurobara/cli",
      "",
      "Standalone Kurobara headless CLI.",
      "",
      "Run `kurobara --help` to print the machine-readable command usage.",
      "",
    ].join("\n"),
    "utf8"
  );
  await writeJson(path.join(stage, "package.json"), {
    bin: {
      kurobara: "dist/index.js",
    },
    description: "Standalone headless CLI for Kurobara.",
    engines: {
      node: ">=24.14.0 <25",
    },
    files: ["dist", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"],
    license: "Apache-2.0",
    name: "@kurobara/cli",
    publishConfig: {
      access: "public",
    },
    type: "module",
    version,
  });
  return { bundle: cliBundle, stage };
};

const parseNpmPackResult = (stdout) => {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new ReleaseCandidateError(
      "release-npm-pack-output-invalid",
      "npm pack did not return JSON."
    );
  }
  const filename = result[0]?.filename;
  if (
    result.length !== 1 ||
    typeof filename !== "string" ||
    !filename.endsWith(".tgz") ||
    path.basename(filename) !== filename
  ) {
    throw new ReleaseCandidateError(
      "release-npm-pack-output-invalid",
      "npm pack returned an unexpected artifact description."
    );
  }
  return filename;
};

const inspectCliTarball = async (tarball, childEnvironment, sourceRoot) => {
  const listed = await run("tar", ["-tzf", tarball], {
    environment: childEnvironment,
  });
  const entries = listed.stdout.trim().split("\n").filter(Boolean);
  const forbidden = entries.find(
    (entry) =>
      entry.includes("/src/") ||
      entry.includes("/test/") ||
      entry.endsWith(".ts") ||
      entry.includes("tsconfig")
  );
  if (forbidden !== undefined) {
    throw new ReleaseCandidateError(
      "release-npm-tarball-source-leak",
      "The npm tarball contains source or test material."
    );
  }
  for (const required of [
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/dist/index.js",
    "package/package.json",
  ]) {
    if (!entries.includes(required)) {
      throw new ReleaseCandidateError(
        "release-npm-tarball-incomplete",
        `The npm tarball is missing ${required}.`
      );
    }
  }
  const [manifestResult, licenseResult, noticesResult] = await Promise.all([
    run("tar", ["-xOf", tarball, "package/package.json"], {
      environment: childEnvironment,
    }),
    run("tar", ["-xOf", tarball, "package/LICENSE"], {
      environment: childEnvironment,
    }),
    run("tar", ["-xOf", tarball, "package/THIRD_PARTY_NOTICES.md"], {
      environment: childEnvironment,
    }),
  ]);
  const manifest = JSON.parse(manifestResult.stdout);
  if (
    manifest.private !== undefined ||
    manifest.dependencies !== undefined ||
    JSON.stringify(manifest).includes("file:") ||
    JSON.stringify(manifest).includes("workspace:") ||
    manifest.bin?.kurobara !== "dist/index.js"
  ) {
    throw new ReleaseCandidateError(
      "release-npm-manifest-unsafe",
      "The packed CLI manifest is not standalone."
    );
  }
  const [rootLicense, rootThirdPartyNotices] = await Promise.all([
    readFile(path.join(sourceRoot, "LICENSE")),
    readFile(path.join(sourceRoot, "THIRD_PARTY_NOTICES.md")),
  ]);
  if (
    !(
      Buffer.from(licenseResult.stdout).equals(rootLicense) &&
      Buffer.from(noticesResult.stdout).equals(rootThirdPartyNotices)
    )
  ) {
    throw new ReleaseCandidateError(
      "release-npm-legal-drift",
      "The packed legal files do not match the repository."
    );
  }
  return { entries, manifest };
};

const packStandaloneCli = async ({
  childEnvironment,
  npmCli,
  npmOutput,
  sourceRoot,
  stage,
  temporaryRoot,
}) => {
  await mkdir(npmOutput);
  const result = await run(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      npmOutput,
      "--cache",
      path.join(temporaryRoot, "pack-cache"),
      stage,
    ],
    { environment: childEnvironment }
  );
  const tarball = path.join(npmOutput, parseNpmPackResult(result.stdout));
  await inspectCliTarball(tarball, childEnvironment, sourceRoot);
  return tarball;
};

const exerciseOfflineCli = async ({
  childEnvironment,
  npmCli,
  tarball,
  temporaryRoot,
}) => {
  const harness = path.join(temporaryRoot, "offline-harness");
  const emptyCache = path.join(temporaryRoot, "offline-cache");
  await mkdir(harness);
  await mkdir(emptyCache);
  await writeJson(path.join(harness, "package.json"), {
    dependencies: {
      "@kurobara/cli": `file:${tarball}`,
    },
    name: "kurobara-release-offline-harness",
    private: true,
    type: "module",
    version: "0.0.0",
  });
  await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      emptyCache,
    ],
    { cwd: harness, environment: childEnvironment }
  );
  const executable = path.join(harness, "node_modules/.bin/kurobara");
  const help = await run(executable, ["--help"], {
    cwd: harness,
    environment: childEnvironment,
  });
  const combined = `${help.stdout}${help.stderr}`;
  if (
    !combined.includes("Expected command:") ||
    combined.includes("node_modules/.cache")
  ) {
    throw new ReleaseCandidateError(
      "release-cli-offline-execution-failed",
      "The installed standalone CLI did not return its bounded usage response."
    );
  }
  return { status: "passed" };
};

const packageRootForInput = async (input, sourceRoot) => {
  if (input.startsWith("<")) {
    return;
  }
  const absolute = path.resolve(sourceRoot, input);
  let current = path.dirname(absolute);
  while (
    current === sourceRoot ||
    current.startsWith(`${sourceRoot}${path.sep}`)
  ) {
    const manifest = path.join(current, "package.json");
    if (await pathExists(manifest)) {
      return { directory: current, manifest };
    }
    if (current === sourceRoot) {
      break;
    }
    current = path.dirname(current);
  }
};

const componentPurl = (name, version) =>
  `pkg:npm/${encodeURIComponent(name).replace("%2F", "/")}@${version}`;

const integrityHash = (integrity) => {
  if (typeof integrity !== "string") {
    return;
  }
  const [algorithmAndValue] = integrity.split(WHITESPACE_PATTERN);
  const separator = algorithmAndValue.indexOf("-");
  if (separator <= 0) {
    return;
  }
  const algorithm = algorithmAndValue.slice(0, separator).toLowerCase();
  const cyclonedxAlgorithms = {
    sha256: "SHA-256",
    sha384: "SHA-384",
    sha512: "SHA-512",
  };
  const cyclonedxAlgorithm = cyclonedxAlgorithms[algorithm];
  if (cyclonedxAlgorithm === undefined) {
    return;
  }
  return {
    alg: cyclonedxAlgorithm,
    content: Buffer.from(
      algorithmAndValue.slice(separator + 1),
      "base64"
    ).toString("hex"),
  };
};

const bundledComponents = async (bundle, rootPackageName, lock, sourceRoot) => {
  const components = new Map();
  for (const input of bundle.includedInputs) {
    const packageRoot = await packageRootForInput(input, sourceRoot);
    if (packageRoot === undefined) {
      continue;
    }
    const manifest = JSON.parse(await readFile(packageRoot.manifest, "utf8"));
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      manifest.name === rootPackageName
    ) {
      continue;
    }
    const purl = componentPurl(manifest.name, manifest.version);
    if (components.has(purl)) {
      continue;
    }
    const lockKey = path
      .relative(sourceRoot, packageRoot.directory)
      .split(path.sep)
      .join("/");
    const locked = lock.packages?.[lockKey];
    const hash = integrityHash(locked?.integrity);
    components.set(purl, {
      "bom-ref": purl,
      ...(hash === undefined ? {} : { hashes: [hash] }),
      ...(typeof manifest.license === "string"
        ? { licenses: [{ expression: manifest.license }] }
        : {}),
      name: manifest.name,
      properties: [
        {
          name: "cdx:npm:package:bundled",
          value: "true",
        },
      ],
      purl,
      type: "library",
      version: manifest.version,
    });
  }
  return [...components.values()].sort((left, right) =>
    compareStrings(left.purl, right.purl)
  );
};

const writeBundleSbom = async ({
  artifact,
  bundle,
  componentName,
  componentVersion,
  esbuildVersion,
  lock,
  output,
  sourceRoot,
}) => {
  const artifactHash = await sha256File(artifact);
  const rootReference = `${componentPurl(componentName, componentVersion)}?artifact=standalone`;
  const components = await bundledComponents(
    bundle,
    componentName,
    lock,
    sourceRoot
  );
  const document = {
    bomFormat: "CycloneDX",
    components,
    dependencies: [
      {
        dependsOn: components.map((component) => component["bom-ref"]),
        ref: rootReference,
      },
      ...components.map((component) => ({
        dependsOn: [],
        ref: component["bom-ref"],
      })),
    ],
    metadata: {
      component: {
        "bom-ref": rootReference,
        hashes: [
          {
            alg: "SHA-256",
            content: artifactHash,
          },
        ],
        name: componentName,
        type: "application",
        version: componentVersion,
      },
      tools: {
        components: [
          {
            name: "esbuild",
            type: "application",
            version: esbuildVersion,
          },
        ],
      },
    },
    specVersion: "1.6",
    version: 1,
  };
  await writeJson(output, document);
};

const resolveCycloneDxCli = async (sourceRoot) => {
  const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
  let manifestFile;
  try {
    const entryFile = sourceRequire.resolve("@cyclonedx/cyclonedx-npm");
    manifestFile = path.join(path.dirname(entryFile), "package.json");
  } catch {
    throw new ReleaseCandidateError(
      "release-cyclonedx-missing",
      "@cyclonedx/cyclonedx-npm is required to build the source SBOM."
    );
  }
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const relativeBinary =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.["cyclonedx-npm"];
  if (manifest.version !== "6.0.0" || typeof relativeBinary !== "string") {
    throw new ReleaseCandidateError(
      "release-cyclonedx-version-mismatch",
      "CycloneDX npm 6.0.0 is required."
    );
  }
  return {
    binary: path.resolve(path.dirname(manifestFile), relativeBinary),
    version: manifest.version,
  };
};

const writeSourceSbom = async ({
  childEnvironment,
  cyclonedx,
  output,
  sourceRoot,
}) => {
  await run(
    process.execPath,
    [
      cyclonedx.binary,
      path.join(sourceRoot, "package.json"),
      "--output-file",
      output,
      "--output-format",
      "JSON",
      "--spec-version",
      "1.6",
      "--output-reproducible",
      "--package-lock-only",
      "--omit",
      "dev",
    ],
    { cwd: sourceRoot, environment: childEnvironment }
  );
  const document = JSON.parse(await readFile(output, "utf8"));
  if (document.bomFormat !== "CycloneDX" || document.specVersion !== "1.6") {
    throw new ReleaseCandidateError(
      "release-cyclonedx-output-invalid",
      "CycloneDX returned an unexpected source SBOM."
    );
  }
};

const listFiles = async (root, current = root) => {
  const names = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of names) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new ReleaseCandidateError(
        "release-artifact-type-invalid",
        "Release outputs must contain only regular files and directories."
      );
    }
  }
  return files.sort();
};

const artifactKind = (relativePath) => {
  if (relativePath.startsWith("npm/")) {
    return "npm-tarball";
  }
  if (relativePath.startsWith("source/")) {
    return "source-archive";
  }
  if (relativePath.startsWith("sbom/")) {
    return "cyclonedx-sbom";
  }
  if (
    relativePath.startsWith("runtime/bin/") &&
    (relativePath.endsWith(".mjs") ||
      relativePath === "runtime/bin/heartbeat-worker.js")
  ) {
    return "runtime-bundle";
  }
  if (relativePath.endsWith(".sql")) {
    return "postgres-migration";
  }
  return "runtime-support";
};

const describeArtifacts = async (outputDirectory) => {
  const excluded = new Set(["SHA256SUMS", "release-manifest.json"]);
  const relativeFiles = (await listFiles(outputDirectory)).filter(
    (relativePath) => !excluded.has(relativePath)
  );
  return Promise.all(
    relativeFiles.map(async (relativePath) => {
      const absolute = path.join(outputDirectory, relativePath);
      const metadata = await stat(absolute);
      return {
        kind: artifactKind(relativePath),
        path: relativePath,
        sha256: await sha256File(absolute),
        size_bytes: metadata.size,
      };
    })
  );
};

const writeChecksums = async (outputDirectory, artifacts) => {
  const manifestPath = path.join(outputDirectory, "release-manifest.json");
  const manifestMetadata = await stat(manifestPath);
  const entries = [
    ...artifacts,
    {
      path: "release-manifest.json",
      sha256: await sha256File(manifestPath),
      size_bytes: manifestMetadata.size,
    },
  ].sort((left, right) => compareStrings(left.path, right.path));
  await writeFile(
    path.join(outputDirectory, "SHA256SUMS"),
    `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
    "utf8"
  );
};

export const parseReleaseArguments = (
  arguments_,
  environment = process.env
) => {
  let outputDirectory;
  let allowDirtyForTests = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output" && outputDirectory === undefined) {
      outputDirectory = arguments_[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--allow-dirty-for-tests" && !allowDirtyForTests) {
      allowDirtyForTests = true;
      continue;
    }
    throw new ReleaseCandidateError(
      "release-invocation-invalid",
      "Usage: node scripts/release-candidate.mjs --output /absolute/new-directory [--allow-dirty-for-tests]"
    );
  }
  assertDirtyOverride(allowDirtyForTests, environment);
  return {
    allowDirtyForTests,
    outputDirectory: normalizedAbsolutePath(
      outputDirectory,
      "release-output-invalid"
    ),
  };
};

export const buildReleaseCandidate = async ({
  allowDirtyForTests = false,
  environment = process.env,
  outputDirectory,
}) => {
  if (process.version !== `v${REQUIRED_NODE_VERSION}`) {
    throw new ReleaseCandidateError(
      "release-node-version-mismatch",
      `The release requires Node ${REQUIRED_NODE_VERSION}.`
    );
  }
  assertDirtyOverride(allowDirtyForTests, environment);
  const normalizedOutput = normalizedAbsolutePath(
    outputDirectory,
    "release-output-invalid"
  );
  const worktree = await inspectTrackedWorktree();
  if (!(worktree.clean || allowDirtyForTests)) {
    throw new ReleaseCandidateError(
      "release-worktree-dirty",
      "Commit or restore tracked changes before building a release candidate."
    );
  }
  const [npm, sourceIdentity] = await Promise.all([
    resolveNpmCli(environment),
    readSourceIdentity(),
  ]);

  let outputCreated = false;
  let temporaryRoot;
  try {
    await createFreshDirectory(normalizedOutput, "release-output-exists");
    outputCreated = true;
    if (
      allowDirtyForTests &&
      environment[TEST_FAIL_AFTER_OUTPUT_ENVIRONMENT] === "true"
    ) {
      throw new ReleaseCandidateError(
        "release-test-injected-failure",
        "The test harness injected a failure after output creation."
      );
    }
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "kurobara-release-candidate.")
    );
    await mkdir(path.join(temporaryRoot, "home"));
    const toolBin = await createToolBin(temporaryRoot, npm.file);
    const childEnvironment = npmEnvironment(
      temporaryRoot,
      toolBin,
      environment,
      {
        SOURCE_DATE_EPOCH: String(sourceIdentity.sourceDateEpoch),
      }
    );
    const sourceRoot = path.join(temporaryRoot, "source");
    await materializeReleaseSource({
      allowDirtyForTests,
      environment: childEnvironment,
      repositoryRoot: REPOSITORY_ROOT,
      sourceCommit: sourceIdentity.commit,
      sourceRoot,
      temporaryRoot,
    });
    const [rootManifest, packageCatalog] = await Promise.all([
      readRootManifest(sourceRoot),
      readPackageCatalog(sourceRoot),
    ]);
    const sourceArchive = await createSourceArchive(
      normalizedOutput,
      rootManifest.version,
      sourceIdentity,
      childEnvironment,
      { allowDirtyForTests, sourceRoot, temporaryRoot }
    );
    const dependencyClosure = await installLockedReleaseDependencies({
      childEnvironment,
      npmCli: npm.file,
      sourceRoot,
      temporaryRoot,
    });
    const cyclonedx = await resolveCycloneDxCli(sourceRoot);
    const runtime = await runRuntimeBuilder({
      childEnvironment,
      outputDirectory: path.join(normalizedOutput, "runtime"),
      sourceRoot,
    });
    const stage = await stageStandaloneCli({
      runtime,
      sourceRoot,
      stageRoot: temporaryRoot,
      version: rootManifest.version,
    });
    const cliTarball = await packStandaloneCli({
      childEnvironment,
      npmCli: npm.file,
      npmOutput: path.join(normalizedOutput, "npm"),
      sourceRoot,
      stage: stage.stage,
      temporaryRoot,
    });
    const offlineInstall = await exerciseOfflineCli({
      childEnvironment,
      npmCli: npm.file,
      tarball: cliTarball,
      temporaryRoot,
    });

    const sbomDirectory = path.join(normalizedOutput, "sbom");
    await mkdir(sbomDirectory);
    await writeSourceSbom({
      childEnvironment,
      cyclonedx,
      output: path.join(sbomDirectory, "source.cdx.json"),
      sourceRoot,
    });
    const lock = JSON.parse(
      await readFile(path.join(sourceRoot, "package-lock.json"), "utf8")
    );
    for (const bundle of runtime.bundles) {
      const sourceManifest = JSON.parse(
        await readFile(path.join(sourceRoot, bundle.sourceManifest), "utf8")
      );
      await writeBundleSbom({
        artifact: bundle.outputFile,
        bundle,
        componentName: sourceManifest.name,
        componentVersion: sourceManifest.version,
        esbuildVersion: runtime.esbuildVersion,
        lock,
        output: path.join(sbomDirectory, `runtime-${bundle.id}.cdx.json`),
        sourceRoot,
      });
    }
    await writeBundleSbom({
      artifact: cliTarball,
      bundle: stage.bundle,
      componentName: "@kurobara/cli",
      componentVersion: rootManifest.version,
      esbuildVersion: runtime.esbuildVersion,
      lock,
      output: path.join(sbomDirectory, "npm-kurobara-cli.cdx.json"),
      sourceRoot,
    });

    const artifacts = await describeArtifacts(normalizedOutput);
    const [licenseHash, thirdPartyNoticesHash] = await Promise.all([
      sha256File(path.join(sourceRoot, "LICENSE")),
      sha256File(path.join(sourceRoot, "THIRD_PARTY_NOTICES.md")),
    ]);
    const releaseManifest = {
      artifacts,
      legal: {
        license_sha256: licenseHash,
        third_party_notices_sha256: thirdPartyNoticesHash,
      },
      offline_install: offlineInstall,
      package_catalog: packageCatalog,
      schema_version: 1,
      source: {
        ...(allowDirtyForTests
          ? {
              base_commit: sourceIdentity.commit,
              base_tree: sourceIdentity.tree,
              commit: null,
              tree: null,
            }
          : {
              commit: sourceIdentity.commit,
              tree: sourceIdentity.tree,
            }),
        binding: allowDirtyForTests
          ? "test-only-worktree-snapshot"
          : "exact-git-commit",
        dependency_lock_sha256: dependencyClosure.lockfileSha256,
        dirty_override_for_tests: allowDirtyForTests,
        reproducibility: {
          byte_for_byte_verified: false,
          status: allowDirtyForTests
            ? "not-applicable-test-snapshot"
            : "not-verified",
        },
        source_archive: path
          .relative(normalizedOutput, sourceArchive)
          .split(path.sep)
          .join("/"),
        source_date_epoch: sourceIdentity.sourceDateEpoch,
      },
      tools: {
        cyclonedx_npm: cyclonedx.version,
        esbuild: runtime.esbuildVersion,
        node: REQUIRED_NODE_VERSION,
        npm: npm.version,
      },
      version: rootManifest.version,
    };
    await writeJson(
      path.join(normalizedOutput, "release-manifest.json"),
      releaseManifest
    );
    await writeChecksums(normalizedOutput, artifacts);
    return {
      artifactCount: artifacts.length,
      commit: allowDirtyForTests ? null : sourceIdentity.commit,
      outputDirectory: normalizedOutput,
      packageCount: packageCatalog.public_packages.length,
      version: rootManifest.version,
    };
  } catch (error) {
    if (outputCreated) {
      await rm(normalizedOutput, { force: true, recursive: true });
    }
    throw error;
  } finally {
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  let options;
  try {
    options = parseReleaseArguments(process.argv.slice(2), process.env);
  } catch (error) {
    const code =
      error instanceof ReleaseCandidateError
        ? error.code
        : "release-invocation-failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 2;
  }
  if (options !== undefined) {
    buildReleaseCandidate({ ...options, environment: process.env })
      .then((result) => {
        process.stdout.write(
          `${JSON.stringify({
            artifact_count: result.artifactCount,
            commit: result.commit,
            package_count: result.packageCount,
            status: "built",
            version: result.version,
          })}\n`
        );
      })
      .catch((error) => {
        const code =
          error instanceof ReleaseCandidateError
            ? error.code
            : "release-build-failed";
        process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
        process.exitCode = error instanceof ReleaseCandidateError ? 2 : 1;
      });
  }
}
