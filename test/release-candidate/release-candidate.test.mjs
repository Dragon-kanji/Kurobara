import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createReleaseChildEnvironment,
  inspectTrackedWorktree,
  installLockedReleaseDependencies,
  materializeReleaseSource,
  parseReleaseArguments,
} from "../../scripts/release-candidate.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const RELEASE_SCRIPT = path.join(
  REPOSITORY_ROOT,
  "scripts/release-candidate.mjs"
);
const SECRET_CANARY = "synthetic-release-secret-canary";
const DATABASE_URL_ERROR = /KUROBARA_DATABASE_URL/u;
const DYNAMIC_REQUIRE_ERROR = /Dynamic require/u;
const ABSOLUTE_PATH_PATTERN = /absolute path/u;
const CHECKSUM_LINE_PATTERN = /^([0-9a-f]{64}) {2}(.+)$/u;
const EXPLICIT_TEST_PROCESS_PATTERN = /explicit test process/u;
const HELP_OUTPUT_PATTERN = /Expected command:/u;
const TRACKED_FILE_PATTERN = /tracked\.txt/u;
const THIRD_PARTY_NOTICES_PATH = "THIRD_PARTY_NOTICES.md";

const execute = (
  command,
  arguments_,
  {
    cwd = REPOSITORY_ROOT,
    environment = process.env,
    maximumBytes = 64 * 1024 * 1024,
  } = {}
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill("SIGKILL");
        reject(new Error("release test output exceeded its budget"));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", reject);
    child.on("close", (status, signal) =>
      resolve({
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    );
  });

const git = (repository, arguments_) =>
  execute("git", ["-C", repository, ...arguments_]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const collectFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
};

const npmCli = () => {
  const candidate =
    process.env.KUROBARA_RELEASE_NPM_CLI ?? process.env.npm_execpath;
  if (!(candidate && path.isAbsolute(candidate))) {
    throw new Error(
      "KUROBARA_RELEASE_NPM_CLI or npm_execpath must identify npm 10.9.4."
    );
  }
  return candidate;
};

const releaseEnvironment = () => ({
  ...process.env,
  KUROBARA_RELEASE_NPM_CLI: npmCli(),
  KUROBARA_RELEASE_TEST_ONLY_ALLOW_DIRTY: "true",
  NODE_ENV: "test",
  PROSPEO_API_KEY: SECRET_CANARY,
});

test("release invocation and child environments fail closed", () => {
  assert.throws(
    () => parseReleaseArguments(["--output", "relative"]),
    ABSOLUTE_PATH_PATTERN
  );
  assert.throws(
    () =>
      parseReleaseArguments(
        ["--output", "/tmp/candidate", "--allow-dirty-for-tests"],
        {}
      ),
    EXPLICIT_TEST_PROCESS_PATTERN
  );
  assert.deepEqual(
    parseReleaseArguments(
      ["--output", "/tmp/candidate", "--allow-dirty-for-tests"],
      {
        KUROBARA_RELEASE_TEST_ONLY_ALLOW_DIRTY: "true",
        NODE_ENV: "test",
      }
    ),
    {
      allowDirtyForTests: true,
      outputDirectory: "/tmp/candidate",
    }
  );

  const child = createReleaseChildEnvironment({
    HOME: "/tmp/synthetic-home",
    PATH: "/usr/bin",
    PROSPEO_API_KEY: SECRET_CANARY,
  });
  assert.equal(child.PROSPEO_API_KEY, undefined);
  assert.equal(JSON.stringify(child).includes(SECRET_CANARY), false);
  assert.equal(child.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(child.NODE_OPTIONS, "");
});

test("tracked dirtiness is detected independently from untracked files", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-release-dirty-test.")
  );
  try {
    await git(temporaryRoot, ["init", "--quiet"]);
    await git(temporaryRoot, ["config", "user.name", "Synthetic Test"]);
    await git(temporaryRoot, [
      "config",
      "user.email",
      "synthetic@example.invalid",
    ]);
    await writeFile(path.join(temporaryRoot, "tracked.txt"), "clean\n", "utf8");
    await git(temporaryRoot, ["add", "tracked.txt"]);
    await git(temporaryRoot, ["commit", "--quiet", "-m", "fixture"]);
    assert.equal((await inspectTrackedWorktree(temporaryRoot)).clean, true);

    await writeFile(path.join(temporaryRoot, "untracked.txt"), "new\n", "utf8");
    assert.equal((await inspectTrackedWorktree(temporaryRoot)).clean, true);

    await writeFile(path.join(temporaryRoot, "tracked.txt"), "dirty\n", "utf8");
    const inspection = await inspectTrackedWorktree(temporaryRoot);
    assert.equal(inspection.clean, false);
    assert.match(inspection.status, TRACKED_FILE_PATTERN);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("isolates committed source and recreates node_modules from the lockfile", async () => {
  assert.equal(process.version, "v24.14.0");
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-release-source-isolation-test.")
  );
  const repository = path.join(temporaryRoot, "repository");
  const dependency = path.join(repository, "vendor/fixture-dependency");
  try {
    await mkdir(dependency, { recursive: true });
    await Promise.all([
      writeFile(path.join(repository, ".gitignore"), "node_modules\n", "utf8"),
      writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({
          dependencies: {
            "fixture-dependency": "file:vendor/fixture-dependency",
          },
          name: "release-source-isolation-fixture",
          private: true,
          version: "1.0.0",
        })}\n`,
        "utf8"
      ),
      writeFile(path.join(repository, "tracked.txt"), "committed\n", "utf8"),
      writeFile(
        path.join(dependency, "index.js"),
        'export default "locked-canonical-dependency";\n',
        "utf8"
      ),
      writeFile(
        path.join(dependency, "package.json"),
        `${JSON.stringify({
          main: "index.js",
          name: "fixture-dependency",
          type: "module",
          version: "1.0.0",
        })}\n`,
        "utf8"
      ),
    ]);
    const lock = await execute(
      process.execPath,
      [
        npmCli(),
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        path.join(temporaryRoot, "lock-cache"),
      ],
      {
        cwd: repository,
        environment: createReleaseChildEnvironment(process.env),
      }
    );
    assert.equal(lock.status, 0, lock.stderr);
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "Synthetic Test"]);
    await git(repository, [
      "config",
      "user.email",
      "synthetic@example.invalid",
    ]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "fixture"]);
    const commit = await git(repository, ["rev-parse", "HEAD"]);
    assert.equal(commit.status, 0, commit.stderr);

    await writeFile(path.join(repository, "tracked.txt"), "dirty\n", "utf8");
    await writeFile(
      path.join(repository, "untracked-source.txt"),
      "must-not-be-copied\n",
      "utf8"
    );
    const staleDependency = path.join(
      repository,
      "node_modules/fixture-dependency"
    );
    await mkdir(staleDependency, { recursive: true });
    await writeFile(
      path.join(staleDependency, "index.js"),
      'export default "mutated-stale-node-modules";\n',
      "utf8"
    );

    const sourceRoot = path.join(temporaryRoot, "isolated-source");
    const operationRoot = path.join(temporaryRoot, "operation");
    await mkdir(operationRoot);
    const childEnvironment = createReleaseChildEnvironment(process.env, {
      HOME: path.join(operationRoot, "home"),
    });
    await materializeReleaseSource({
      environment: childEnvironment,
      repositoryRoot: repository,
      sourceCommit: commit.stdout.trim(),
      sourceRoot,
      temporaryRoot: operationRoot,
    });
    assert.equal(
      await readFile(path.join(sourceRoot, "tracked.txt"), "utf8"),
      "committed\n"
    );
    await assert.rejects(
      access(path.join(sourceRoot, "untracked-source.txt")),
      (error) =>
        error instanceof Error && "code" in error && error.code === "ENOENT"
    );
    await installLockedReleaseDependencies({
      childEnvironment,
      npmCli: npmCli(),
      sourceRoot,
      temporaryRoot: operationRoot,
    });
    assert.equal(
      await readFile(
        path.join(sourceRoot, "node_modules/fixture-dependency/index.js"),
        "utf8"
      ),
      'export default "locked-canonical-dependency";\n'
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("builds and verifies the standalone local release candidate", async () => {
  assert.equal(process.version, "v24.14.0");
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-release-candidate-test.")
  );
  try {
    const relative = await execute(
      process.execPath,
      [RELEASE_SCRIPT, "--output", "relative"],
      { environment: releaseEnvironment() }
    );
    assert.equal(relative.status, 2);
    assert.deepEqual(JSON.parse(relative.stderr), {
      code: "release-output-invalid",
      status: "failed",
    });

    const existingOutput = path.join(temporaryRoot, "existing");
    await mkdir(existingOutput);
    const sentinel = path.join(existingOutput, "sentinel");
    await writeFile(sentinel, "preserved\n", "utf8");
    const existing = await execute(
      process.execPath,
      [RELEASE_SCRIPT, "--output", existingOutput, "--allow-dirty-for-tests"],
      { environment: releaseEnvironment() }
    );
    assert.equal(existing.status, 2);
    assert.deepEqual(JSON.parse(existing.stderr), {
      code: "release-output-exists",
      status: "failed",
    });
    assert.equal(await readFile(sentinel, "utf8"), "preserved\n");

    const failedOutput = path.join(temporaryRoot, "failed-output");
    const failed = await execute(
      process.execPath,
      [RELEASE_SCRIPT, "--output", failedOutput, "--allow-dirty-for-tests"],
      {
        environment: {
          ...releaseEnvironment(),
          KUROBARA_RELEASE_TEST_ONLY_FAIL_AFTER_OUTPUT_CREATE: "true",
        },
      }
    );
    assert.notEqual(failed.status, 0);
    await assert.rejects(access(failedOutput), {
      code: "ENOENT",
    });

    const output = path.join(temporaryRoot, "candidate");
    const built = await execute(
      process.execPath,
      [RELEASE_SCRIPT, "--output", output, "--allow-dirty-for-tests"],
      { environment: releaseEnvironment() }
    );
    assert.equal(built.status, 0, `${built.stderr}\n${built.stdout}`);
    assert.equal(JSON.parse(built.stdout).status, "built");

    const releaseManifest = JSON.parse(
      await readFile(path.join(output, "release-manifest.json"), "utf8")
    );
    assert.equal(releaseManifest.schema_version, 1);
    assert.equal(releaseManifest.source.binding, "test-only-worktree-snapshot");
    assert.equal(typeof releaseManifest.source.base_commit, "string");
    assert.equal(typeof releaseManifest.source.base_tree, "string");
    assert.equal(releaseManifest.source.commit, null);
    assert.equal(releaseManifest.source.dirty_override_for_tests, true);
    assert.deepEqual(releaseManifest.source.reproducibility, {
      byte_for_byte_verified: false,
      status: "not-applicable-test-snapshot",
    });
    assert.equal(releaseManifest.source.tree, null);
    assert.equal(
      releaseManifest.legal.third_party_notices_sha256,
      sha256(
        await readFile(path.join(REPOSITORY_ROOT, THIRD_PARTY_NOTICES_PATH))
      )
    );
    const sourceArchive = path.join(
      output,
      releaseManifest.source.source_archive
    );
    const sourceListing = await execute("tar", ["-tzf", sourceArchive]);
    assert.equal(sourceListing.status, 0, sourceListing.stderr);
    const archivedLockEntry = sourceListing.stdout
      .trim()
      .split("\n")
      .find((entry) => entry === "./package-lock.json");
    assert.equal(archivedLockEntry, "./package-lock.json");
    const archivedLock = await execute("tar", [
      "-xOf",
      sourceArchive,
      archivedLockEntry,
    ]);
    assert.equal(archivedLock.status, 0, archivedLock.stderr);
    assert.equal(
      releaseManifest.source.dependency_lock_sha256,
      sha256(Buffer.from(archivedLock.stdout))
    );
    const candidateLock = JSON.parse(archivedLock.stdout);
    assert.equal(releaseManifest.tools.node, "24.14.0");
    assert.equal(releaseManifest.tools.npm, "10.9.4");
    assert.equal(releaseManifest.tools.esbuild, "0.28.1");
    assert.equal(releaseManifest.tools.cyclonedx_npm, "6.0.0");
    assert.equal(releaseManifest.offline_install.status, "passed");
    assert.deepEqual(
      releaseManifest.package_catalog.public_packages.map(
        (candidate) => candidate.name
      ),
      ["@kurobara/cli"]
    );

    for (const bundle of [
      "api.mjs",
      "bootstrap-api-key.mjs",
      "bootstrap-planning.mjs",
      "cli.mjs",
      "heartbeat-worker.js",
      "worker.mjs",
    ]) {
      await access(path.join(output, "runtime/bin", bundle));
    }
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(output, "runtime/bin/package.json"), "utf8")
      ),
      { type: "commonjs" }
    );
    const apiStartup = await execute(
      process.execPath,
      [await realpath(path.join(output, "runtime/bin/api.mjs"))],
      {
        environment: createReleaseChildEnvironment({
          ...process.env,
          NODE_ENV: "test",
        }),
      }
    );
    assert.equal(apiStartup.status, 1);
    assert.match(apiStartup.stderr, DATABASE_URL_ERROR);
    assert.doesNotMatch(apiStartup.stderr, DYNAMIC_REQUIRE_ERROR);

    const workerStartup = await execute(
      process.execPath,
      [await realpath(path.join(output, "runtime/bin/worker.mjs"))],
      {
        environment: createReleaseChildEnvironment({
          ...process.env,
          NODE_ENV: "test",
        }),
      }
    );
    assert.equal(workerStartup.status, 1);
    assert.match(workerStartup.stderr, DATABASE_URL_ERROR);
    assert.doesNotMatch(workerStartup.stderr, DYNAMIC_REQUIRE_ERROR);

    const cliBundle = await readFile(
      path.join(output, "runtime/bin/cli.mjs"),
      "utf8"
    );
    assert.equal(
      cliBundle.split("\n").filter((line) => line.startsWith("#!")).length,
      1
    );

    const tarballs = (await readdir(path.join(output, "npm"))).filter((name) =>
      name.endsWith(".tgz")
    );
    assert.equal(tarballs.length, 1);
    const tarball = path.join(output, "npm", tarballs[0]);
    const listed = await execute("tar", ["-tzf", tarball]);
    assert.equal(listed.status, 0);
    const entries = listed.stdout.trim().split("\n");
    for (const required of [
      "package/LICENSE",
      "package/THIRD_PARTY_NOTICES.md",
      "package/dist/index.js",
      "package/package.json",
    ]) {
      assert.ok(entries.includes(required), `${required} missing`);
    }
    assert.equal(
      entries.some(
        (entry) =>
          entry.includes("/src/") ||
          entry.includes("/test/") ||
          entry.endsWith(".ts") ||
          entry.includes("tsconfig")
      ),
      false
    );
    const packedManifest = await execute("tar", [
      "-xOf",
      tarball,
      "package/package.json",
    ]);
    const manifest = JSON.parse(packedManifest.stdout);
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(JSON.stringify(manifest).includes("file:"), false);
    assert.equal(JSON.stringify(manifest).includes("workspace:"), false);
    assert.deepEqual(manifest.bin, { kurobara: "dist/index.js" });

    const runtimeFiles = await collectFiles(path.join(output, "runtime"));
    assert.equal(
      runtimeFiles.some(
        (file) =>
          file.endsWith(".ts") ||
          file.split(path.sep).includes("src") ||
          file.split(path.sep).includes("test")
      ),
      false
    );

    const checksumLines = (
      await readFile(path.join(output, "SHA256SUMS"), "utf8")
    )
      .trim()
      .split("\n");
    const checksumPaths = [];
    for (const line of checksumLines) {
      const match = CHECKSUM_LINE_PATTERN.exec(line);
      assert.ok(match, `invalid checksum line: ${line}`);
      const [, expected, relativePath] = match;
      checksumPaths.push(relativePath);
      assert.equal(
        sha256(await readFile(path.join(output, relativePath))),
        expected
      );
    }
    assert.deepEqual(checksumPaths, [...checksumPaths].sort());
    for (const artifact of releaseManifest.artifacts) {
      const bytes = await readFile(path.join(output, artifact.path));
      assert.equal(sha256(bytes), artifact.sha256);
      assert.equal(bytes.length, artifact.size_bytes);
    }
    assert.equal(
      releaseManifest.artifacts.find(
        (artifact) => artifact.path === "runtime/bin/heartbeat-worker.js"
      )?.kind,
      "runtime-bundle"
    );

    for (const sbom of [
      "npm-kurobara-cli.cdx.json",
      "runtime-api.cdx.json",
      "runtime-bootstrap-api-key.cdx.json",
      "runtime-bootstrap-planning.cdx.json",
      "runtime-cli.cdx.json",
      "runtime-worker-heartbeat.cdx.json",
      "runtime-worker.cdx.json",
      "source.cdx.json",
    ]) {
      const document = JSON.parse(
        await readFile(path.join(output, "sbom", sbom), "utf8")
      );
      assert.equal(document.bomFormat, "CycloneDX");
      assert.equal(document.specVersion, "1.6");
    }
    const heartbeatSbom = JSON.parse(
      await readFile(
        path.join(output, "sbom/runtime-worker-heartbeat.cdx.json"),
        "utf8"
      )
    );
    const hatchetComponent = heartbeatSbom.components.find(
      (component) => component.name === "@hatchet-dev/typescript-sdk"
    );
    assert.equal(hatchetComponent?.version, "1.28.0");
    assert.deepEqual(hatchetComponent.licenses, [{ expression: "MIT" }]);
    const hatchetIntegrity =
      candidateLock.packages["node_modules/@hatchet-dev/typescript-sdk"]
        .integrity;
    assert.equal(typeof hatchetIntegrity, "string");
    const [hatchetAlgorithm, hatchetBase64] = hatchetIntegrity.split("-");
    assert.deepEqual(hatchetComponent.hashes, [
      {
        alg: hatchetAlgorithm.toUpperCase().replace("SHA", "SHA-"),
        content: Buffer.from(hatchetBase64, "base64").toString("hex"),
      },
    ]);

    const harness = path.join(temporaryRoot, "consumer");
    const emptyCache = path.join(temporaryRoot, "consumer-empty-cache");
    await mkdir(harness);
    await mkdir(emptyCache);
    await writeFile(
      path.join(harness, "package.json"),
      `${JSON.stringify({
        dependencies: {
          "@kurobara/cli": `file:${tarball}`,
        },
        name: "external-kurobara-cli-consumer",
        private: true,
        version: "0.0.0",
      })}\n`,
      "utf8"
    );
    const install = await execute(
      process.execPath,
      [
        npmCli(),
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        emptyCache,
      ],
      {
        cwd: harness,
        environment: createReleaseChildEnvironment(),
      }
    );
    assert.equal(install.status, 0, install.stderr);
    await access(path.join(harness, "node_modules/.bin/kurobara"));
    const help = await execute(
      process.execPath,
      [
        path.join(harness, "node_modules/@kurobara/cli/dist/index.js"),
        "--help",
      ],
      {
        cwd: harness,
        environment: createReleaseChildEnvironment(),
      }
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(`${help.stdout}${help.stderr}`, HELP_OUTPUT_PATTERN);

    for (const file of await collectFiles(output)) {
      assert.equal(
        (await readFile(file)).includes(Buffer.from(SECRET_CANARY)),
        false,
        `${file} leaked the secret canary`
      );
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
