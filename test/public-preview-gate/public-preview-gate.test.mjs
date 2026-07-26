import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PUBLIC_PREVIEW_CONTAINER_IMAGE,
  PUBLIC_PREVIEW_CONTAINER_PLATFORM,
  PublicPreviewGateError,
  parseArguments,
  resetChildHome,
  runPublicPreviewGate,
  validateDownloadUrl,
} from "../../scripts/public-preview-gate.mjs";

const TAG = "v0.1.0-rc.7";
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const LAUNCHER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/public-preview-gate.sh"
);
const WORKER_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/public-preview-gate.mjs"
);
const ISOLATED_LAUNCHER_REQUIRED_PATTERN =
  /"error_code":"isolated-launcher-required"/u;
const LOCAL_TEST_LAUNCHER_FORBIDDEN_PATTERN =
  /"error_code":"local-test-launcher-forbidden"/u;
const TEST_ENVIRONMENT = {
  ...process.env,
  KUROBARA_PUBLIC_PREVIEW_TESTING: "true",
  NODE_ENV: "test",
};

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function git(repositoryRoot, arguments_) {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeFixtureGate(repositoryRoot, fixtureFailureCode) {
  const fixtureReport =
    fixtureFailureCode === undefined
      ? { outcome: "fixture-passed" }
      : {
          failure: { reason_code: fixtureFailureCode },
          outcome: "failed",
        };
  const failureExit =
    fixtureFailureCode === undefined ? "" : "\nprocess.exitCode = 1;";
  const script = `import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const forbidden = [
  "EXA_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "KUROBARA_PROVIDER_ORDER",
  "NODE_AUTH_TOKEN",
  "TAVILY_API_KEY",
  "UNRELATED_AMBIENT_SENTINEL",
  "npm_config_node_options",
  "npm_config_registry",
  "npm_config_userconfig",
];
if (forbidden.some((key) => process.env[key] !== undefined)) {
  process.exit(20);
}
if (
  process.env.GIT_TERMINAL_PROMPT !== "0" ||
  process.env.GIT_CONFIG_GLOBAL !== "/dev/null" ||
  process.env.GIT_CONFIG_NOSYSTEM !== "1" ||
  process.env.GIT_CONFIG_SYSTEM !== "/dev/null" ||
  process.env.NODE_OPTIONS !== "" ||
  typeof process.env.NPM_CONFIG_GLOBALCONFIG !== "string" ||
  typeof process.env.NPM_CONFIG_USERCONFIG !== "string" ||
  process.env.NPM_CONFIG_GLOBALCONFIG === process.env.NPM_CONFIG_USERCONFIG ||
  typeof process.env.NPM_CONFIG_CACHE !== "string"
) {
  process.exit(21);
}
const npmConfigurations = await Promise.all([
  readFile(process.env.NPM_CONFIG_GLOBALCONFIG, "utf8"),
  readFile(process.env.NPM_CONFIG_USERCONFIG, "utf8"),
]);
if (npmConfigurations.some((contents) => contents !== "")) {
  process.exit(24);
}
const homeEntries = await readdir(process.env.HOME, { withFileTypes: true });
if (
  homeEntries.length > 1 ||
  (homeEntries.length === 1 &&
    (homeEntries[0].name !== ".cache" || !homeEntries[0].isDirectory()))
) {
  process.exit(23);
}
if (homeEntries.length === 1) {
  const cacheEntries = await readdir(path.join(process.env.HOME, ".cache"), {
    withFileTypes: true,
  });
  if (
    cacheEntries.length !== 1 ||
    cacheEntries[0].name !== "rosetta" ||
    !cacheEntries[0].isDirectory()
  ) {
    process.exit(23);
  }
}
await writeFile(path.join(process.env.HOME, ".preview-pass-used"), "", {
  flag: "wx",
  mode: 0o600,
});
await writeFile(path.join(process.cwd(), ".git", "preview-pass-used"), "", {
  flag: "wx",
  mode: 0o600,
});
const arguments_ = process.argv.slice(2);
if (
  arguments_[0] !== "--mode" ||
  arguments_[1] !== "fixture" ||
  arguments_[2] !== "--require-clean" ||
  arguments_[3] !== "--report" ||
  arguments_.length !== 5
) {
  process.exit(22);
}
await writeFile(
  arguments_[4],
  \`\${JSON.stringify(${JSON.stringify(fixtureReport)})}\\n\`,
  { flag: "wx", mode: 0o600 }
);${failureExit}
`;
  await mkdir(path.join(repositoryRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(repositoryRoot, "scripts/v1-gate.mjs"),
    script,
    "utf8"
  );
}

async function createFixture(options = {}) {
  const root = await mkdtemp(
    path.join(tmpdir(), "kurobara-public-preview-test-")
  );
  const repositoryRoot = path.join(root, "repository");
  await mkdir(repositoryRoot);
  git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "public-preview-fixture",
        packageManager: "npm@10.9.4",
        private: true,
        scripts: {
          preinstall: 'node -e "process.exit(44)"',
        },
        type: "module",
        version: "0.1.0",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name: "public-preview-fixture",
        packages: {
          "": {
            hasInstallScript: true,
            name: "public-preview-fixture",
            version: "0.1.0",
          },
        },
        requires: true,
        version: "0.1.0",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, ".gitignore"),
    "node_modules/\n",
    "utf8"
  );
  await writeFixtureGate(repositoryRoot, options.fixtureFailureCode);
  git(repositoryRoot, ["add", "--all"]);
  git(repositoryRoot, ["commit", "--no-gpg-sign", "-m", "fixture"]);
  git(repositoryRoot, [
    "tag",
    "--annotate",
    "--no-sign",
    TAG,
    "--message",
    "fixture release",
  ]);
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const bareRepository = path.join(root, "remote.git");
  execFileSync("git", ["clone", "--bare", repositoryRoot, bareRepository], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const artifactsDirectory = path.join(root, "artifacts");
  await mkdir(artifactsDirectory);
  const artifactPath = path.join(artifactsDirectory, "source.tar.gz");
  const artifactBytes = Buffer.from("synthetic release artifact\n", "utf8");
  await writeFile(artifactPath, artifactBytes);
  const manifestPath = path.join(artifactsDirectory, "manifest.json");
  const manifest = {
    artifacts: [
      {
        name: "source.tar.gz",
        sha256: sha256(artifactBytes),
        size_bytes: artifactBytes.length,
        url: pathToFileURL(artifactPath).href,
      },
    ],
    commit,
    format_version: "1.0.0",
    tag: TAG,
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(manifestPath, manifestBytes);

  return {
    artifactPath,
    commit,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    repositoryUrl: pathToFileURL(bareRepository).href,
    root,
  };
}

function argumentsFor(fixture, reportDirectory, overrides = {}) {
  return [
    "--repository-url",
    overrides.repositoryUrl ?? fixture.repositoryUrl,
    "--expected-commit",
    overrides.expectedCommit ?? fixture.commit,
    "--expected-tag",
    overrides.expectedTag ?? TAG,
    "--artifacts-manifest-url",
    pathToFileURL(fixture.manifestPath).href,
    "--expected-artifacts-manifest-sha256",
    overrides.manifestSha256 ?? fixture.manifestSha256,
    "--passes",
    "2",
    "--report-dir",
    reportDirectory,
    "--allow-local-test-remote",
  ];
}

async function withHostileEnvironment(fixture, callback) {
  const ambientHome = path.join(fixture.root, "ambient-home");
  const ambientGitConfigDirectory = path.join(ambientHome, ".config", "git");
  await mkdir(ambientGitConfigDirectory, { recursive: true });
  const preloadMarker = path.join(fixture.root, "node-options-preloaded");
  const preloadScript = path.join(fixture.root, "ambient-preload.cjs");
  await writeFile(
    path.join(ambientHome, ".netrc"),
    "machine example.invalid login fixture password must-not-reach-child\n",
    { mode: 0o600 }
  );
  const hostileGitConfiguration = `[url "file:///not-the-fixture/"]
\tinsteadOf = file://
[credential]
\thelper = store
[http]
\textraHeader = Authorization: Bearer must-not-reach-child
`;
  await writeFile(
    path.join(ambientHome, ".gitconfig"),
    hostileGitConfiguration,
    "utf8"
  );
  await writeFile(
    path.join(ambientGitConfigDirectory, "config"),
    hostileGitConfiguration,
    "utf8"
  );
  await writeFile(
    path.join(ambientHome, ".npmrc"),
    "//registry.npmjs.org/:_authToken=must-not-reach-child\n",
    "utf8"
  );
  await writeFile(
    preloadScript,
    `require("node:fs").writeFileSync(${JSON.stringify(
      preloadMarker
    )}, "preloaded\\n");\n`,
    "utf8"
  );
  const replacements = {
    EXA_API_KEY: "must-not-reach-child",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: path.join(ambientHome, ".gitconfig"),
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer must-not-reach-child",
    GH_TOKEN: "must-not-reach-child",
    GITHUB_TOKEN: "must-not-reach-child",
    HOME: ambientHome,
    KUROBARA_PROVIDER_ORDER: "tavily,exa",
    NODE_AUTH_TOKEN: "must-not-reach-child",
    NODE_OPTIONS: `--require=${preloadScript}`,
    TAVILY_API_KEY: "must-not-reach-child",
    UNRELATED_AMBIENT_SENTINEL: "must-not-reach-child",
    XDG_CONFIG_HOME: path.join(ambientHome, ".config"),
    npm_config_node_options: `--require=${preloadScript}`,
    npm_config_registry:
      "https://fixture:must-not-reach-child@registry.example.invalid/",
    npm_config_userconfig: path.join(ambientHome, ".npmrc"),
  };
  const previous = Object.fromEntries(
    Object.keys(replacements).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, replacements);
  try {
    return await callback({ ambientHome, preloadMarker });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withFixture(callback, options) {
  const fixture = await createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
}

function publicArguments(reportDirectory) {
  return [
    "--repository-url",
    "https://example.invalid/Kurobara.git",
    "--expected-commit",
    "a".repeat(40),
    "--expected-tag",
    TAG,
    "--artifacts-manifest-url",
    "https://example.invalid/artifacts-manifest.json",
    "--expected-artifacts-manifest-sha256",
    `sha256:${"b".repeat(64)}`,
    "--passes",
    "2",
    "--report-dir",
    reportDirectory,
  ];
}

async function createFakeDocker(root) {
  const binDirectory = path.join(root, "bin");
  const logPath = path.join(root, "docker.log");
  const statePath = path.join(root, "docker.state");
  await mkdir(binDirectory);
  const dockerPath = path.join(binDirectory, "docker");
  await writeFile(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
command_name="$1"
shift
{
  printf '%s' "\${command_name}"
  for argument in "$@"; do
    printf '\\t%s' "\${argument}"
  done
  printf '\\n'
} >> "\${FAKE_DOCKER_LOG}"
case "\${command_name}" in
  create)
    count=0
    if [[ -f "\${FAKE_DOCKER_STATE}" ]]; then
      count="$(<"\${FAKE_DOCKER_STATE}")"
    fi
    count=$((count + 1))
    printf '%s\\n' "\${count}" > "\${FAKE_DOCKER_STATE}"
    printf 'fake-container-%s\\n' "\${count}"
    ;;
  start|rm)
    ;;
  cp)
    destination="$2"
    printf '{}\\n' > "\${destination}"
    ;;
  *)
    exit 70
    ;;
esac
`,
    "utf8"
  );
  await chmod(dockerPath, 0o700);
  return { binDirectory, logPath, statePath };
}

test("requires HTTPS outside the explicit test harness", () => {
  assert.throws(
    () =>
      parseArguments(
        [
          "--repository-url",
          "file:///tmp/repository.git",
          "--expected-commit",
          "a".repeat(40),
          "--expected-tag",
          TAG,
          "--artifacts-manifest-url",
          "file:///tmp/manifest.json",
          "--expected-artifacts-manifest-sha256",
          `sha256:${"b".repeat(64)}`,
          "--report-dir",
          "/tmp/public-preview-report",
          "--allow-local-test-remote",
        ],
        process.env
      ),
    { code: "local-test-mode-forbidden" }
  );
});

test("rejects credentials encoded as download URL components", async () => {
  const productionArguments = [
    "--repository-url",
    "https://example.invalid/Kurobara.git",
    "--expected-commit",
    "a".repeat(40),
    "--expected-tag",
    TAG,
    "--artifacts-manifest-url",
    "https://example.invalid/manifest.json?X-Amz-Signature=credential",
    "--expected-artifacts-manifest-sha256",
    `sha256:${"b".repeat(64)}`,
    "--report-dir",
    "/tmp/kurobara-public-preview-component-test",
  ];
  assert.throws(() => parseArguments(productionArguments, process.env), {
    code: "artifacts-manifest-url-invalid",
  });
  productionArguments[7] = "https://example.invalid/manifest.json#credential";
  assert.throws(() => parseArguments(productionArguments, process.env), {
    code: "artifacts-manifest-url-invalid",
  });

  await withFixture(async (fixture) => {
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    manifest.artifacts[0].url =
      "https://example.invalid/source.tar.gz?token=credential";
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(fixture.manifestPath, bytes);
    const options = parseArguments(
      argumentsFor(fixture, path.join(fixture.root, "component-url"), {
        manifestSha256: sha256(bytes),
      }),
      TEST_ENVIRONMENT
    );
    await assert.rejects(runPublicPreviewGate(options), {
      code: "artifact-url-invalid",
    });
  });
});

test("accepts signed HTTPS queries only after an artifact redirect", () => {
  assert.equal(
    validateDownloadUrl(
      "https://release-assets.githubusercontent.com/source.tar.gz?sig=synthetic",
      false,
      "artifact-redirect-invalid",
      true
    ).href,
    "https://release-assets.githubusercontent.com/source.tar.gz?sig=synthetic"
  );
  for (const url of [
    "https://release-assets.githubusercontent.com/source.tar.gz#fragment",
    "https://fixture:credential@example.invalid/source.tar.gz?sig=synthetic",
    "http://release-assets.githubusercontent.com/source.tar.gz?sig=synthetic",
  ]) {
    assert.throws(
      () => validateDownloadUrl(url, false, "artifact-redirect-invalid", true),
      { code: "artifact-redirect-invalid" }
    );
  }
});

test("resets package-manager metadata from the dedicated child home", async () => {
  const passRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-public-preview-home-")
  );
  try {
    const homeDirectory = path.join(passRoot, "home");
    await mkdir(path.join(homeDirectory, ".cache"), { recursive: true });
    await writeFile(path.join(homeDirectory, ".cache", "metadata"), "");

    await resetChildHome(homeDirectory, passRoot, {}, undefined);

    assert.deepEqual(await readdir(homeDirectory), []);
  } finally {
    await rm(passRoot, { force: true, recursive: true });
  }
});

test("the local harness runs two fresh passes with a fail-closed child environment", async () => {
  await withFixture(async (fixture) => {
    const reportDirectory = path.join(fixture.root, "reports");
    const options = parseArguments(
      argumentsFor(fixture, reportDirectory),
      TEST_ENVIRONMENT
    );

    const summary = await withHostileEnvironment(
      fixture,
      async ({ preloadMarker }) => {
        const result = await runPublicPreviewGate(options);
        await assert.rejects(readFile(preloadMarker), { code: "ENOENT" });
        return result;
      }
    );

    assert.equal(summary.outcome, "passed");
    assert.equal(summary.passes_completed, 2);
    assert.equal(summary.passes_required, 2);
    assert.deepEqual(summary.isolation_contract, {
      boundary: "in-process-test-harness",
      public_proof: false,
    });
    for (const passNumber of [1, 2]) {
      const report = JSON.parse(
        await readFile(
          path.join(reportDirectory, `pass-${passNumber}.json`),
          "utf8"
        )
      );
      assert.equal(report.outcome, "passed");
      assert.equal(report.pass, passNumber);
      assert.equal(report.expected_commit, fixture.commit);
      assert.equal(report.expected_tag, TAG);
      assert.equal(report.mode, "local-test");
      assert.equal(report.fixture.outcome, "fixture-passed");
      assert.equal(report.artifacts.artifacts.length, 1);
      assert.deepEqual(report.isolation_contract, {
        boundary: "in-process-test-harness",
        pass: passNumber,
        public_proof: false,
        workspace: "fresh-temporary-directory",
      });
      assert.deepEqual(report.credential_contract, {
        child_environment: "allowlisted",
        credential_helper: "disabled",
        git_configuration: "isolated",
        home: "fresh-runtime-cache-only",
        interactive_prompt: false,
        node_options: "cleared",
        npm_configuration: "isolated",
      });
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes("must-not-reach-child"), false);
      assert.equal(serialized.includes(fixture.root), false);
    }
  });
});

test("the public launcher constructs two distinct hardened containers", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kurobara-public-preview-launcher-test-")
  );
  try {
    const fakeDocker = await createFakeDocker(root);
    const reportDirectory = path.join(root, "reports");
    const result = spawnSync(
      "bash",
      [LAUNCHER_PATH, ...publicArguments(reportDirectory)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EXA_API_KEY: "must-not-reach-container",
          FAKE_DOCKER_LOG: fakeDocker.logPath,
          FAKE_DOCKER_STATE: fakeDocker.statePath,
          HTTPS_PROXY: "https://must-not-reach-container.invalid",
          NODE_EXTRA_CA_CERTS: path.join(root, "must-not-reach-container.pem"),
          PATH: `${fakeDocker.binDirectory}:${process.env.PATH}`,
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);

    const calls = (await readFile(fakeDocker.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const createCalls = calls.filter(([command]) => command === "create");
    assert.equal(createCalls.length, 2);
    for (const call of createCalls) {
      assert.equal(call.includes("--init"), true);
      assert.equal(call.includes("--read-only"), true);
      assert.equal(call.includes("--platform"), true);
      assert.equal(call.includes(PUBLIC_PREVIEW_CONTAINER_PLATFORM), true);
      assert.equal(call.includes("--cap-drop"), true);
      assert.equal(call.includes("ALL"), true);
      assert.equal(call.includes("--cap-add"), true);
      assert.equal(call.includes("SETUID"), true);
      assert.equal(call.includes("SETGID"), true);
      assert.equal(
        call.filter((argument) => argument === "--cap-add").length,
        2
      );
      assert.equal(call.includes("--security-opt"), true);
      assert.equal(call.includes("no-new-privileges=true"), true);
      assert.equal(call.includes("--tmpfs"), true);
      assert.equal(call.includes("/tmp:rw,exec,nosuid,nodev,mode=1777"), true);
      assert.equal(call.includes("--user"), true);
      assert.equal(call.includes("0:0"), true);
      assert.equal(call.includes("type=volume,dst=/root"), true);
      assert.equal(
        call.includes("type=volume,dst=/opt/kurobara-public-preview-bin"),
        true
      );
      assert.equal(call.includes(PUBLIC_PREVIEW_CONTAINER_IMAGE), true);
      assert.equal(call.includes("/usr/bin/env"), true);
      assert.equal(call.includes("-i"), true);
      assert.equal(call.includes("--env"), false);
      const serialized = call.join("\n");
      assert.equal(serialized.includes("must-not-reach-container"), false);
    }
    const firstMounts = createCalls[0].filter((argument) =>
      argument.startsWith("type=bind,")
    );
    const secondMounts = createCalls[1].filter((argument) =>
      argument.startsWith("type=bind,")
    );
    assert.equal(firstMounts.length, 1);
    assert.equal(firstMounts[0].endsWith(",readonly"), true);
    assert.equal(firstMounts[0].includes(reportDirectory), false);
    assert.equal(secondMounts.length, 2);
    assert.equal(
      secondMounts.some(
        (mount) =>
          mount.includes(`${reportDirectory}/pass-1.json`) &&
          mount.includes("dst=/proof/pass-1.json") &&
          mount.endsWith(",readonly")
      ),
      true
    );
    const startCalls = calls.filter(([command]) => command === "start");
    assert.deepEqual(
      startCalls.map((call) => call.at(-1)),
      ["fake-container-1", "fake-container-2"]
    );
    assert.equal(calls.filter(([command]) => command === "rm").length, 2);
    await readFile(path.join(reportDirectory, "pass-1.json"), "utf8");
    await readFile(path.join(reportDirectory, "pass-2.json"), "utf8");
    await readFile(path.join(reportDirectory, "summary.json"), "utf8");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the Node worker refuses direct production invocation", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kurobara-public-preview-refusal-test-")
  );
  try {
    const reportDirectory = path.join(root, "reports");
    const result = spawnSync(
      process.execPath,
      [WORKER_PATH, ...publicArguments(reportDirectory)],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "production",
          PATH: process.env.PATH,
        },
      }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, ISOLATED_LAUNCHER_REQUIRED_PATTERN);
    await assert.rejects(readFile(reportDirectory), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the production launcher refuses the local file test mode", () => {
  const result = spawnSync(
    "bash",
    [LAUNCHER_PATH, "--allow-local-test-remote"],
    {
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, LOCAL_TEST_LAUNCHER_FORBIDDEN_PATTERN);
});

test("fails when the expected commit does not match the release tag", async () => {
  await withFixture(async (fixture) => {
    const options = parseArguments(
      argumentsFor(fixture, path.join(fixture.root, "wrong-commit"), {
        expectedCommit: "a".repeat(40),
      }),
      TEST_ENVIRONMENT
    );

    await assert.rejects(runPublicPreviewGate(options), {
      code: "tag-commit-mismatch",
    });
    const report = JSON.parse(
      await readFile(
        path.join(fixture.root, "wrong-commit/pass-1.json"),
        "utf8"
      )
    );
    assert.equal(report.error_code, "tag-commit-mismatch");
  });
});

test("fails when the expected tag is unavailable", async () => {
  await withFixture(async (fixture) => {
    const options = parseArguments(
      argumentsFor(fixture, path.join(fixture.root, "wrong-tag"), {
        expectedTag: "v0.1.0-rc.404",
      }),
      TEST_ENVIRONMENT
    );

    await assert.rejects(runPublicPreviewGate(options), {
      code: "expected-tag-unavailable",
    });
  });
});

test("fails when a downloaded artifact checksum differs", async () => {
  await withFixture(async (fixture) => {
    const original = await readFile(fixture.artifactPath);
    await writeFile(fixture.artifactPath, Buffer.alloc(original.length, 120));
    const options = parseArguments(
      argumentsFor(fixture, path.join(fixture.root, "wrong-checksum")),
      TEST_ENVIRONMENT
    );

    await assert.rejects(runPublicPreviewGate(options), {
      code: "artifact-checksum-mismatch",
    });
  });
});

test("surfaces one bounded reason code when the safe fixture fails", async () => {
  await withFixture(
    async (fixture) => {
      const reportDirectory = path.join(
        fixture.root,
        "fixture-failure-reports"
      );
      const options = parseArguments(
        argumentsFor(fixture, reportDirectory),
        TEST_ENVIRONMENT
      );

      await assert.rejects(runPublicPreviewGate(options), {
        code: "safe-fixture-failed",
        fixtureErrorCode: "export-proof-invalid",
      });
      const report = JSON.parse(
        await readFile(path.join(reportDirectory, "pass-1.json"), "utf8")
      );
      assert.equal(report.error_code, "safe-fixture-failed");
      assert.equal(report.fixture_error_code, "export-proof-invalid");
      assert.equal(JSON.stringify(report).includes(fixture.root), false);
    },
    { fixtureFailureCode: "export-proof-invalid" }
  );
});

test("refuses to overwrite an existing report directory", async () => {
  await withFixture(async (fixture) => {
    const reportDirectory = path.join(fixture.root, "existing-reports");
    await mkdir(reportDirectory);
    const options = parseArguments(
      argumentsFor(fixture, reportDirectory),
      TEST_ENVIRONMENT
    );

    await assert.rejects(runPublicPreviewGate(options), {
      code: "report-directory-exists",
    });
  });
});

test("exposes a stable typed error for invalid arguments", () => {
  assert.throws(
    () => parseArguments(["--passes", "1"], TEST_ENVIRONMENT),
    PublicPreviewGateError
  );
});
