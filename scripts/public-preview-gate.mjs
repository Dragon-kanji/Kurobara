import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FORMAT_VERSION = "1.0.0";
const REQUIRED_PASS_COUNT = 2;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FIXTURE_REPORT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 128;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const FIXTURE_TIMEOUT_MS = 60 * 60_000;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_OUTCOME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/u;
const FORBIDDEN_TAG_CHARACTER_PATTERN = /[~^:?*\\[\]]/u;
const EFFECTIVE_CAPABILITIES_PATTERN = /^CapEff:\s+([0-9a-f]+)$/imu;
const NO_NEW_PRIVILEGES_PATTERN = /^NoNewPrivs:\s+([01])$/imu;
const CHILD_ENVIRONMENT_PASSTHROUGH_KEYS = [
  "PATH",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
];
const TEST_MODE_ENVIRONMENT_KEY = "KUROBARA_PUBLIC_PREVIEW_TESTING";
const TEST_MODE_ENVIRONMENT_VALUE = "true";
const ISOLATED_PASS_ENVIRONMENT_KEY = "KUROBARA_PUBLIC_PREVIEW_ISOLATED_PASS";
const ISOLATED_REPORT_DIRECTORY = "/root/kurobara-public-preview-reports";
const ISOLATED_NPM_WRAPPER_DIRECTORY = "/opt/kurobara-public-preview-bin";
const PRIOR_PASS_REPORT_PATH = "/proof/pass-1.json";
const REQUIRED_NPM_VERSION = "10.9.4";
const ISOLATED_CHILD_IDENTITY = Object.freeze({ gid: 1000, uid: 1000 });
export const PUBLIC_PREVIEW_CONTAINER_IMAGE =
  "node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b";
export const PUBLIC_PREVIEW_CONTAINER_PLATFORM = "linux/amd64";

export class PublicPreviewGateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PublicPreviewGateError";
  }
}

function fail(code, message) {
  throw new PublicPreviewGateError(code, message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  const canonicalize = (candidate) => {
    if (Array.isArray(candidate)) {
      return candidate.map(canonicalize);
    }
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return candidate;
  };
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function isTestModeAllowed(environment) {
  return (
    environment.NODE_ENV === "test" &&
    environment[TEST_MODE_ENVIRONMENT_KEY] === TEST_MODE_ENVIRONMENT_VALUE
  );
}

function validateRemoteUrl(rawUrl, allowLocalTestRemote) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("repository-url-invalid", "The repository URL is not a valid URL.");
  }
  if (parsed.username || parsed.password) {
    fail(
      "repository-url-credentials-forbidden",
      "The repository URL must not contain credentials."
    );
  }
  if (parsed.search || parsed.hash) {
    fail(
      "repository-url-components-forbidden",
      "The repository URL must not contain a query or fragment."
    );
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (allowLocalTestRemote && parsed.protocol === "file:") {
    return parsed;
  }
  fail(
    "repository-url-protocol-forbidden",
    "Public proof requires an HTTPS repository URL."
  );
}

export function validateDownloadUrl(
  rawUrl,
  allowLocalTestRemote,
  code,
  allowSearch = false
) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail(code, "An artifact URL is not a valid URL.");
  }
  if (parsed.username || parsed.password) {
    fail(code, "Artifact URLs must not contain credentials.");
  }
  if (parsed.hash || (!allowSearch && parsed.search)) {
    fail(
      code,
      allowSearch
        ? "Artifact redirect URLs must not contain a fragment."
        : "Artifact URLs must not contain a query or fragment."
    );
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (allowLocalTestRemote && parsed.protocol === "file:") {
    return parsed;
  }
  fail(code, "Public proof requires HTTPS artifact URLs.");
}

function validateTag(tag) {
  if (
    tag.length < 1 ||
    tag.length > 200 ||
    tag.startsWith("-") ||
    tag.includes("..") ||
    tag.includes("@{") ||
    FORBIDDEN_TAG_CHARACTER_PATTERN.test(tag) ||
    Array.from(tag).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 32 || codePoint === 127);
    })
  ) {
    fail("expected-tag-invalid", "The expected tag is not a safe Git tag.");
  }
}

function parsePositiveInteger(rawValue, option) {
  if (!DECIMAL_INTEGER_PATTERN.test(rawValue)) {
    fail("usage-invalid", `${option} must be a positive integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("usage-invalid", `${option} must be a positive integer.`);
  }
  return value;
}

function collectArgumentValues(arguments_) {
  const values = new Map();
  let allowLocalTestRemote = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-local-test-remote") {
      if (allowLocalTestRemote) {
        fail("usage-invalid", `${argument} was provided more than once.`);
      }
      allowLocalTestRemote = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      fail("usage-invalid", `Unexpected positional argument: ${argument}`);
    }
    const option = argument.slice(2);
    if (
      ![
        "artifacts-manifest-url",
        "expected-artifacts-manifest-sha256",
        "expected-commit",
        "expected-tag",
        "passes",
        "report-dir",
        "repository-url",
      ].includes(option)
    ) {
      fail("usage-invalid", `Unknown option: ${argument}`);
    }
    if (values.has(option)) {
      fail("usage-invalid", `${argument} was provided more than once.`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("usage-invalid", `${argument} requires a value.`);
    }
    values.set(option, value);
    index += 1;
  }
  return { allowLocalTestRemote, values };
}

function requireOptions(values) {
  const required = [
    "artifacts-manifest-url",
    "expected-artifacts-manifest-sha256",
    "expected-commit",
    "expected-tag",
    "report-dir",
    "repository-url",
  ];
  for (const option of required) {
    if (!values.has(option)) {
      fail("usage-invalid", `--${option} is required.`);
    }
  }
}

export function parseArguments(arguments_, environment = process.env) {
  const { allowLocalTestRemote, values } = collectArgumentValues(arguments_);
  if (allowLocalTestRemote && !isTestModeAllowed(environment)) {
    fail(
      "local-test-mode-forbidden",
      "--allow-local-test-remote is available only to the test harness."
    );
  }
  requireOptions(values);
  const expectedCommit = values.get("expected-commit");
  const expectedManifestSha256 = values.get(
    "expected-artifacts-manifest-sha256"
  );
  const expectedTag = values.get("expected-tag");
  const reportDirectory = path.resolve(values.get("report-dir"));
  const passes = parsePositiveInteger(
    values.get("passes") ?? String(REQUIRED_PASS_COUNT),
    "--passes"
  );
  if (!COMMIT_PATTERN.test(expectedCommit)) {
    fail(
      "expected-commit-invalid",
      "--expected-commit must be a lowercase 40-character commit SHA."
    );
  }
  if (!SHA256_PATTERN.test(expectedManifestSha256)) {
    fail(
      "expected-manifest-sha256-invalid",
      "--expected-artifacts-manifest-sha256 must use sha256:<64 lowercase hex>."
    );
  }
  validateTag(expectedTag);
  if (passes !== REQUIRED_PASS_COUNT) {
    fail(
      "pass-count-invalid",
      `Public preview evidence requires exactly ${REQUIRED_PASS_COUNT} passes.`
    );
  }
  if (!path.isAbsolute(values.get("report-dir"))) {
    fail("report-directory-invalid", "--report-dir must be absolute.");
  }

  return {
    allowLocalTestRemote,
    artifactsManifestUrl: validateDownloadUrl(
      values.get("artifacts-manifest-url"),
      allowLocalTestRemote,
      "artifacts-manifest-url-invalid"
    ).href,
    expectedCommit,
    expectedManifestSha256,
    expectedTag,
    passes,
    reportDirectory,
    repositoryUrl: validateRemoteUrl(
      values.get("repository-url"),
      allowLocalTestRemote
    ).href,
    testHarnessAuthorized:
      allowLocalTestRemote && isTestModeAllowed(environment),
  };
}

async function createChildEnvironment(passRoot, sourceEnvironment, identity) {
  const homeDirectory = path.join(passRoot, "home");
  const npmGlobalConfiguration = path.join(passRoot, "npm-globalconfig");
  const npmUserConfiguration = path.join(passRoot, "npm-userconfig");
  const npmWrapperDirectory =
    identity === undefined
      ? path.join(passRoot, "bin")
      : ISOLATED_NPM_WRAPPER_DIRECTORY;
  const npmWrapper = path.join(npmWrapperDirectory, "npm");
  if (identity === undefined) {
    await mkdir(homeDirectory, { mode: 0o700 });
    await mkdir(npmWrapperDirectory, { mode: 0o700 });
  } else {
    await chmod(passRoot, 0o733);
    const wrapperDirectoryMetadata = await lstat(npmWrapperDirectory).catch(
      () => undefined
    );
    if (
      wrapperDirectoryMetadata === undefined ||
      !wrapperDirectoryMetadata.isDirectory() ||
      wrapperDirectoryMetadata.isSymbolicLink()
    ) {
      fail(
        "isolated-npm-wrapper-directory-invalid",
        "The isolated npm wrapper volume is unavailable."
      );
    }
    await chmod(npmWrapperDirectory, 0o755);
  }
  const readOnlyMode = identity === undefined ? 0o600 : 0o444;
  const executableMode = identity === undefined ? 0o700 : 0o555;
  await Promise.all([
    writeFile(npmGlobalConfiguration, "", {
      flag: "wx",
      mode: readOnlyMode,
    }),
    writeFile(npmUserConfiguration, "", {
      flag: "wx",
      mode: readOnlyMode,
    }),
    writeFile(npmWrapper, '#!/bin/sh\nexec corepack npm "$@"\n', {
      flag: "wx",
      mode: executableMode,
    }),
  ]);
  await chmod(npmWrapper, executableMode);
  const environment = {};
  for (const key of CHILD_ENVIRONMENT_PASSTHROUGH_KEYS) {
    const value = sourceEnvironment[key];
    if (typeof value === "string") {
      environment[key] = value;
    }
  }
  environment.PATH = `${npmWrapperDirectory}:${environment.PATH ?? ""}`;
  environment.HOME = homeDirectory;
  environment.GIT_ASKPASS = "/usr/bin/false";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.NODE_OPTIONS = "";
  environment.COREPACK_HOME = path.join(passRoot, "corepack");
  environment.NPM_CONFIG_CACHE = path.join(passRoot, "npm-cache");
  environment.NPM_CONFIG_GLOBALCONFIG = npmGlobalConfiguration;
  environment.NPM_CONFIG_USERCONFIG = npmUserConfiguration;
  if (identity !== undefined) {
    await runCommand(
      process.execPath,
      [
        "-e",
        'require("node:fs").mkdirSync(process.argv[1], { mode: 0o700 })',
        homeDirectory,
      ],
      {
        cwd: passRoot,
        environment,
        failureCode: "isolated-workspace-preparation-failed",
        identity,
        label: "Isolated child workspace preparation",
        timeoutCode: "isolated-workspace-preparation-timeout",
        timeoutMs: 30_000,
      }
    );
  }
  return { environment };
}

async function runCommand(command, arguments_, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      ...(options.identity ?? {}),
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new PublicPreviewGateError(
          options.timeoutCode,
          `${options.label} timed out.`
        )
      );
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(
        new PublicPreviewGateError(
          options.failureCode,
          `${options.label} could not start.`
        )
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(
        new PublicPreviewGateError(
          options.failureCode,
          `${options.label} failed.`
        )
      );
    });
  });
}

export async function resetChildHome(
  homeDirectory,
  passRoot,
  environment,
  identity
) {
  if (homeDirectory !== path.join(passRoot, "home")) {
    fail(
      "child-home-reset-invalid",
      "The child home reset target is outside the fresh pass boundary."
    );
  }
  const metadata = await lstat(homeDirectory).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    fail(
      "child-home-reset-invalid",
      "The child home reset target is not a regular directory."
    );
  }
  if (identity === undefined) {
    await rm(homeDirectory, { force: false, recursive: true });
    await mkdir(homeDirectory, { mode: 0o700 });
  } else {
    await runCommand(
      process.execPath,
      [
        "-e",
        `
const fs = require("node:fs");
const homeDirectory = process.argv[1];
const metadata = fs.lstatSync(homeDirectory);
if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
  process.exit(71);
}
fs.rmSync(homeDirectory, { force: false, recursive: true });
fs.mkdirSync(homeDirectory, { mode: 0o700 });
`,
        homeDirectory,
      ],
      {
        cwd: passRoot,
        environment,
        failureCode: "child-home-reset-failed",
        identity,
        label: "Child home reset",
        timeoutCode: "child-home-reset-timeout",
        timeoutMs: 30_000,
      }
    );
  }
  const resetMetadata = await lstat(homeDirectory).catch(() => undefined);
  if (
    resetMetadata === undefined ||
    !resetMetadata.isDirectory() ||
    resetMetadata.isSymbolicLink()
  ) {
    fail(
      "child-home-reset-invalid",
      "The child home reset did not create a regular directory."
    );
  }
}

async function git(
  repositoryRoot,
  arguments_,
  environment,
  failureCode,
  identity
) {
  await runCommand(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=/usr/bin/false",
      "-C",
      repositoryRoot,
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      environment,
      failureCode,
      identity,
      label: "Git verification",
      timeoutCode: "git-command-timeout",
      timeoutMs: 120_000,
    }
  );
}

async function gitOutput(
  repositoryRoot,
  arguments_,
  environment,
  failureCode,
  identity
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=/usr/bin/false",
        "-C",
        repositoryRoot,
        ...arguments_,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        ...(identity ?? {}),
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const chunks = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new PublicPreviewGateError(
          "git-command-timeout",
          "Git verification timed out."
        )
      );
    }, 120_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(
        new PublicPreviewGateError(failureCode, "Git verification failed.")
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (bytes > 64 * 1024) {
        reject(
          new PublicPreviewGateError(
            "git-output-too-large",
            "Git verification returned too much data."
          )
        );
        return;
      }
      if (code !== 0 || signal !== null) {
        reject(
          new PublicPreviewGateError(failureCode, "Git verification failed.")
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

async function cloneRepository(options, cloneDirectory, environment, identity) {
  await runCommand(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=/usr/bin/false",
      "clone",
      "--no-checkout",
      "--no-local",
      "--no-tags",
      options.repositoryUrl,
      cloneDirectory,
    ],
    {
      cwd: path.dirname(cloneDirectory),
      environment,
      failureCode: "anonymous-clone-failed",
      identity,
      label: "Anonymous repository clone",
      timeoutCode: "anonymous-clone-timeout",
      timeoutMs: 180_000,
    }
  );
  await git(
    cloneDirectory,
    [
      "fetch",
      "--force",
      "--no-tags",
      "origin",
      `refs/tags/${options.expectedTag}:refs/tags/${options.expectedTag}`,
    ],
    environment,
    "expected-tag-unavailable",
    identity
  );
  const tagCommit = await gitOutput(
    cloneDirectory,
    ["rev-list", "-n", "1", `refs/tags/${options.expectedTag}`],
    environment,
    "expected-tag-invalid",
    identity
  );
  if (tagCommit !== options.expectedCommit) {
    fail(
      "tag-commit-mismatch",
      "The expected tag does not resolve to the expected commit."
    );
  }
  await git(
    cloneDirectory,
    ["cat-file", "-e", `${options.expectedCommit}^{commit}`],
    environment,
    "expected-commit-unavailable",
    identity
  );
  await git(
    cloneDirectory,
    ["checkout", "--detach", options.expectedCommit],
    environment,
    "expected-commit-checkout-failed",
    identity
  );
  const head = await gitOutput(
    cloneDirectory,
    ["rev-parse", "HEAD"],
    environment,
    "expected-commit-readback-failed",
    identity
  );
  if (head !== options.expectedCommit) {
    fail(
      "expected-commit-mismatch",
      "The checked-out commit differs from the expected commit."
    );
  }
}

async function readLocalFile(url, maximumBytes, code) {
  const filePath = fileURLToPath(url);
  const metadata = await lstat(filePath).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    fail(code, "The local test artifact is unavailable or exceeds its limit.");
  }
  return await readFile(filePath);
}

async function fetchResponse(url, allowLocalTestRemote) {
  let current = validateDownloadUrl(
    url,
    allowLocalTestRemote,
    "artifact-url-invalid"
  );
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }).catch(() => undefined);
    if (response === undefined) {
      fail("artifact-download-failed", "An artifact download failed.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === MAX_REDIRECTS) {
        fail("artifact-redirect-invalid", "An artifact redirect was refused.");
      }
      current = validateDownloadUrl(
        new URL(location, current).href,
        allowLocalTestRemote,
        "artifact-redirect-invalid",
        true
      );
      continue;
    }
    if (response.status !== 200 || response.body === null) {
      fail("artifact-download-failed", "An artifact download was refused.");
    }
    return response;
  }
  fail("artifact-redirect-invalid", "Too many artifact redirects.");
}

async function downloadBytes(url, maximumBytes, allowLocalTestRemote, code) {
  const parsed = validateDownloadUrl(url, allowLocalTestRemote, code);
  if (parsed.protocol === "file:") {
    return await readLocalFile(parsed, maximumBytes, code);
  }
  const response = await fetchResponse(parsed.href, allowLocalTestRemote);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    fail(code, "A downloaded artifact exceeds its size limit.");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) {
      fail(code, "A downloaded artifact exceeds its size limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadDigest(url, maximumBytes, allowLocalTestRemote, code) {
  const parsed = validateDownloadUrl(url, allowLocalTestRemote, code);
  if (parsed.protocol === "file:") {
    const bytes = await readLocalFile(parsed, maximumBytes, code);
    return { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const response = await fetchResponse(parsed.href, allowLocalTestRemote);
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumBytes) {
      fail(code, "A downloaded artifact exceeds its size limit.");
    }
    hash.update(chunk);
  }
  return { bytes: length, sha256: `sha256:${hash.digest("hex")}` };
}

function assertExactKeys(candidate, expected, code) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    fail(code, "The artifact manifest has an invalid object shape.");
  }
  const actual = Object.keys(candidate).sort();
  const expectedSorted = [...expected].sort();
  if (
    actual.length !== expectedSorted.length ||
    actual.some((key, index) => key !== expectedSorted[index])
  ) {
    fail(code, "The artifact manifest contains unexpected or missing fields.");
  }
}

function validateArtifactManifest(candidate, options) {
  assertExactKeys(
    candidate,
    ["artifacts", "commit", "format_version", "tag"],
    "artifacts-manifest-invalid"
  );
  if (
    candidate.format_version !== FORMAT_VERSION ||
    candidate.commit !== options.expectedCommit ||
    candidate.tag !== options.expectedTag ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length < 1 ||
    candidate.artifacts.length > MAX_ARTIFACT_COUNT
  ) {
    fail(
      "artifacts-manifest-invalid",
      "The artifact manifest does not identify the expected release."
    );
  }
  const names = new Set();
  let totalBytes = 0;
  const artifacts = candidate.artifacts.map((artifact) => {
    assertExactKeys(
      artifact,
      ["name", "sha256", "size_bytes", "url"],
      "artifact-entry-invalid"
    );
    if (
      typeof artifact.name !== "string" ||
      artifact.name.length < 1 ||
      artifact.name.length > 200 ||
      artifact.name !== path.posix.basename(artifact.name) ||
      artifact.name === "." ||
      artifact.name === ".." ||
      artifact.name !== artifact.name.normalize("NFC") ||
      names.has(artifact.name) ||
      !SHA256_PATTERN.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0 ||
      artifact.size_bytes > MAX_ARTIFACT_BYTES ||
      typeof artifact.url !== "string"
    ) {
      fail("artifact-entry-invalid", "An artifact entry is invalid.");
    }
    validateDownloadUrl(
      artifact.url,
      options.allowLocalTestRemote,
      "artifact-url-invalid"
    );
    names.add(artifact.name);
    totalBytes += artifact.size_bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail(
        "artifact-size-limit-exceeded",
        "The artifact manifest exceeds its total size limit."
      );
    }
    return artifact;
  });
  return artifacts;
}

async function verifyArtifacts(options) {
  const manifestBytes = await downloadBytes(
    options.artifactsManifestUrl,
    MAX_MANIFEST_BYTES,
    options.allowLocalTestRemote,
    "artifacts-manifest-download-failed"
  );
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== options.expectedManifestSha256) {
    fail(
      "artifacts-manifest-checksum-mismatch",
      "The artifact manifest checksum differs from the expected checksum."
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("artifacts-manifest-invalid", "The artifact manifest is not JSON.");
  }
  const artifacts = validateArtifactManifest(manifest, options);
  const verified = [];
  for (const artifact of artifacts) {
    const receipt = await downloadDigest(
      artifact.url,
      artifact.size_bytes,
      options.allowLocalTestRemote,
      "artifact-download-failed"
    );
    if (receipt.bytes !== artifact.size_bytes) {
      fail(
        "artifact-size-mismatch",
        "A downloaded artifact size differs from its manifest."
      );
    }
    if (receipt.sha256 !== artifact.sha256) {
      fail(
        "artifact-checksum-mismatch",
        "A downloaded artifact checksum differs from its manifest."
      );
    }
    verified.push({
      name: artifact.name,
      sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
    });
  }
  return {
    artifacts: verified,
    manifest_sha256: manifestSha256,
  };
}

async function readFileAsIdentity(
  filePath,
  maximumBytes,
  environment,
  identity
) {
  if (identity === undefined) {
    return await readFile(filePath);
  }
  return await new Promise((resolve, reject) => {
    const helper = `
const fs = require("node:fs");
const maximumBytes = Number(process.argv[2]);
const descriptor = fs.openSync(
  process.argv[1],
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
);
const metadata = fs.fstatSync(descriptor);
if (!metadata.isFile() || metadata.size > maximumBytes) {
  process.exit(71);
}
process.stdout.write(fs.readFileSync(descriptor));
`;
    const child = spawn(
      process.execPath,
      ["-e", helper, filePath, String(maximumBytes)],
      {
        env: environment,
        ...identity,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => {
      reject(
        new PublicPreviewGateError(
          "fixture-report-invalid",
          "The safe fixture report could not be read."
        )
      );
    });
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null || bytes > maximumBytes) {
        reject(
          new PublicPreviewGateError(
            "fixture-report-invalid",
            "The safe fixture report could not be read safely."
          )
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function readFixtureReceipt(fixtureReportPath, environment, identity) {
  const metadata = await lstat(fixtureReportPath).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_FIXTURE_REPORT_BYTES
  ) {
    fail(
      "fixture-report-invalid",
      "The safe fixture did not create a bounded regular report."
    );
  }
  const bytes = await readFileAsIdentity(
    fixtureReportPath,
    MAX_FIXTURE_REPORT_BYTES,
    environment,
    identity
  );
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("fixture-report-invalid", "The safe fixture report is not JSON.");
  }
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    typeof report.outcome !== "string" ||
    !SAFE_OUTCOME_PATTERN.test(report.outcome) ||
    !["fixture-dry-run-passed", "fixture-passed"].includes(report.outcome)
  ) {
    fail(
      "fixture-report-invalid",
      "The safe fixture report does not contain an accepted fixture outcome."
    );
  }
  return {
    outcome: report.outcome,
    report_sha256: sha256(bytes),
  };
}

async function assertPinnedPackageManager(cloneDirectory) {
  const packageJsonPath = path.join(cloneDirectory, "package.json");
  const metadata = await lstat(packageJsonPath).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_MANIFEST_BYTES
  ) {
    fail(
      "package-manager-pin-invalid",
      "The candidate package manifest is not a bounded regular file."
    );
  }
  let packageManifest;
  try {
    packageManifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    fail(
      "package-manager-pin-invalid",
      "The candidate package manifest is not valid JSON."
    );
  }
  if (
    packageManifest === null ||
    typeof packageManifest !== "object" ||
    Array.isArray(packageManifest) ||
    packageManifest.packageManager !== `npm@${REQUIRED_NPM_VERSION}`
  ) {
    fail(
      "package-manager-pin-invalid",
      `The candidate must pin npm@${REQUIRED_NPM_VERSION}.`
    );
  }
}

async function runSafeFixture(cloneDirectory, passRoot, environment, identity) {
  await assertPinnedPackageManager(cloneDirectory);
  await runCommand("npm", ["ci", "--ignore-scripts"], {
    cwd: cloneDirectory,
    environment,
    failureCode: "locked-install-failed",
    identity,
    label: "Locked dependency installation",
    timeoutCode: "locked-install-timeout",
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  await resetChildHome(environment.HOME, passRoot, environment, identity);
  const fixtureReportPath = path.join(passRoot, "fixture-report.json");
  await runCommand(
    process.execPath,
    [
      "scripts/v1-gate.mjs",
      "--mode",
      "fixture",
      "--require-clean",
      "--report",
      fixtureReportPath,
    ],
    {
      cwd: cloneDirectory,
      environment,
      failureCode: "safe-fixture-failed",
      identity,
      label: "Repository safe fixture",
      timeoutCode: "safe-fixture-timeout",
      timeoutMs: FIXTURE_TIMEOUT_MS,
    }
  );
  return await readFixtureReceipt(fixtureReportPath, environment, identity);
}

function reportUrl(rawUrl, allowLocalTestRemote) {
  const parsed = new URL(rawUrl);
  if (allowLocalTestRemote) {
    return `file://local-test/${path.basename(parsed.pathname)}`;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

async function prepareReportDirectory(reportDirectory) {
  const existing = await lstat(reportDirectory).catch((error) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (existing !== undefined) {
    fail(
      "report-directory-exists",
      "The report directory already exists and will not be overwritten."
    );
  }
  const parent = await lstat(path.dirname(reportDirectory)).catch(
    () => undefined
  );
  if (parent === undefined || !parent.isDirectory()) {
    fail(
      "report-directory-parent-invalid",
      "The report directory parent must already exist."
    );
  }
  await mkdir(reportDirectory, { mode: 0o700 });
}

async function writeReport(reportDirectory, name, value) {
  await writeFile(path.join(reportDirectory, name), canonicalJson(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function failureCode(error) {
  return error instanceof PublicPreviewGateError
    ? error.code
    : "unexpected-error";
}

async function verifyIsolatedVerifier(reportDirectory) {
  const status = await readFile("/proc/self/status", "utf8");
  const capabilities = EFFECTIVE_CAPABILITIES_PATTERN.exec(status)?.[1];
  const noNewPrivileges = NO_NEW_PRIVILEGES_PATTERN.exec(status)?.[1];
  const reportMetadata = await lstat(reportDirectory);
  if (
    process.getuid?.() !== 0 ||
    process.getgid?.() !== 0 ||
    capabilities === undefined ||
    BigInt(`0x${capabilities}`) !== 0xc0n ||
    noNewPrivileges !== "1" ||
    reportMetadata.uid !== 0 ||
    reportMetadata.gid !== 0 ||
    reportMetadata.mode % 64 !== 0
  ) {
    fail(
      "isolated-verifier-contract-invalid",
      "The isolated verifier or root-only report boundary is invalid."
    );
  }
}

async function verifyIsolatedChild(passRoot, environment, identity) {
  const verification = `
const fs = require("node:fs");
const status = fs.readFileSync("/proc/self/status", "utf8");
const capabilities = /^CapEff:\\s+([0-9a-f]+)$/imu.exec(status)?.[1];
const noNewPrivileges = /^NoNewPrivs:\\s+([01])$/imu.exec(status)?.[1];
let reportBoundaryDenied = false;
try {
  fs.readdirSync("/root/kurobara-public-preview-reports");
} catch (error) {
  reportBoundaryDenied = error?.code === "EACCES";
}
if (
  process.getuid() !== 1000 ||
  process.getgid() !== 1000 ||
  capabilities === undefined ||
  BigInt("0x" + capabilities) !== 0n ||
  noNewPrivileges !== "1" ||
  !reportBoundaryDenied
) {
  process.exit(72);
}
`;
  await runCommand(process.execPath, ["-e", verification], {
    cwd: passRoot,
    environment,
    failureCode: "isolated-child-contract-invalid",
    identity,
    label: "Isolated child identity verification",
    timeoutCode: "isolated-child-contract-timeout",
    timeoutMs: 30_000,
  });
}

function credentialContract() {
  return {
    child_environment: "allowlisted",
    credential_helper: "disabled",
    git_configuration: "isolated",
    home: "fresh-runtime-cache-only",
    interactive_prompt: false,
    node_options: "cleared",
    npm_configuration: "isolated",
  };
}

function containerIsolationContract(passNumber) {
  return {
    boundary: "dedicated-clean-container",
    candidate_capabilities: "dropped-all",
    candidate_identity: "uid=1000,gid=1000",
    container_image: PUBLIC_PREVIEW_CONTAINER_IMAGE,
    container_platform: PUBLIC_PREVIEW_CONTAINER_PLATFORM,
    cross_pass_input: passNumber === 1 ? "none" : "pass-1-json-read-only",
    host_writable_mounts: false,
    no_new_privileges: true,
    report_boundary: "root-only-anonymous-volume",
    root_filesystem: "read-only",
    verifier_capabilities: "setuid-setgid-only",
    verifier_identity: "uid=0,gid=0",
    workspace: "container-tmpfs",
  };
}

function testHarnessIsolationContract(passNumber) {
  return {
    boundary: "in-process-test-harness",
    pass: passNumber,
    public_proof: false,
    workspace: "fresh-temporary-directory",
  };
}

function containerSummaryIsolationContract() {
  return {
    boundary: "separate-clean-containers",
    candidate_capabilities: "dropped-all",
    candidate_identity: "uid=1000,gid=1000",
    container_image: PUBLIC_PREVIEW_CONTAINER_IMAGE,
    container_platform: PUBLIC_PREVIEW_CONTAINER_PLATFORM,
    cross_pass_state: "pass-1-json-read-only",
    host_writable_mounts: false,
    report_boundary: "root-only-anonymous-volume",
    verifier_capabilities: "setuid-setgid-only",
    verifier_identity: "uid=0,gid=0",
  };
}

function hasExactKeys(candidate, expected) {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const actual = Object.keys(candidate).sort();
  const expectedSorted = [...expected].sort();
  return (
    actual.length === expectedSorted.length &&
    actual.every((key, index) => key === expectedSorted[index])
  );
}

function isValidTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function validatePriorArtifactReceipt(receipt) {
  const validShape =
    hasExactKeys(receipt, ["artifacts", "manifest_sha256"]) &&
    SHA256_PATTERN.test(receipt.manifest_sha256) &&
    Array.isArray(receipt.artifacts);
  if (
    !validShape ||
    receipt.artifacts.length < 1 ||
    receipt.artifacts.length > MAX_ARTIFACT_COUNT
  ) {
    fail(
      "prior-pass-report-invalid",
      "The first-pass artifact receipt is invalid."
    );
  }
  for (const artifact of receipt.artifacts) {
    if (
      !hasExactKeys(artifact, ["name", "sha256", "size_bytes"]) ||
      typeof artifact.name !== "string" ||
      artifact.name.length < 1 ||
      artifact.name.length > 200 ||
      artifact.name !== path.posix.basename(artifact.name) ||
      !SHA256_PATTERN.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0 ||
      artifact.size_bytes > MAX_ARTIFACT_BYTES
    ) {
      fail(
        "prior-pass-report-invalid",
        "The first-pass artifact receipt contains an invalid entry."
      );
    }
  }
}

function validatePriorPassReport(report, options) {
  if (
    !hasExactKeys(report, [
      "artifacts",
      "completed_at",
      "credential_contract",
      "expected_commit",
      "expected_tag",
      "fixture",
      "format_version",
      "isolation_contract",
      "kind",
      "mode",
      "outcome",
      "pass",
      "repository_url",
      "started_at",
    ]) ||
    report.completed_at < report.started_at ||
    report.expected_commit !== options.expectedCommit ||
    report.expected_tag !== options.expectedTag ||
    report.format_version !== FORMAT_VERSION ||
    report.kind !== "kurobara-public-preview-pass" ||
    report.mode !== "public-anonymous" ||
    report.outcome !== "passed" ||
    report.pass !== 1 ||
    report.repository_url !== reportUrl(options.repositoryUrl, false) ||
    !isValidTimestamp(report.started_at) ||
    !isValidTimestamp(report.completed_at) ||
    JSON.stringify(report.credential_contract) !==
      JSON.stringify(credentialContract()) ||
    JSON.stringify(report.isolation_contract) !==
      JSON.stringify(containerIsolationContract(1)) ||
    !hasExactKeys(report.fixture, ["outcome", "report_sha256"]) ||
    !["fixture-dry-run-passed", "fixture-passed"].includes(
      report.fixture.outcome
    ) ||
    !SHA256_PATTERN.test(report.fixture.report_sha256)
  ) {
    fail(
      "prior-pass-report-invalid",
      "The first-pass report is not valid isolated evidence."
    );
  }
  validatePriorArtifactReceipt(report.artifacts);
  if (report.artifacts.manifest_sha256 !== options.expectedManifestSha256) {
    fail(
      "prior-pass-report-mismatch",
      "The first-pass report identifies different release artifacts."
    );
  }
}

async function readPriorPassReport(options) {
  const metadata = await lstat(PRIOR_PASS_REPORT_PATH).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_FIXTURE_REPORT_BYTES
  ) {
    fail(
      "prior-pass-report-invalid",
      "The first-pass report must be a bounded read-only mount."
    );
  }
  const bytes = await readFile(PRIOR_PASS_REPORT_PATH);
  let report;
  try {
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      "prior-pass-report-invalid",
      "The first-pass report is not valid JSON."
    );
  }
  validatePriorPassReport(report, options);
  return { report, sha256: sha256(bytes) };
}

async function runPass(
  options,
  passNumber,
  reportDirectory,
  isolationContract
) {
  const startedAt = new Date().toISOString();
  const passRoot = await mkdtemp(
    path.join(tmpdir(), `kurobara-public-preview-${passNumber}-`)
  );
  const cloneDirectory = path.join(passRoot, "repository");
  const identity = options.allowLocalTestRemote
    ? undefined
    : ISOLATED_CHILD_IDENTITY;
  try {
    const { environment } = await createChildEnvironment(
      passRoot,
      process.env,
      identity
    );
    if (identity !== undefined) {
      await verifyIsolatedChild(passRoot, environment, identity);
    }
    await cloneRepository(options, cloneDirectory, environment, identity);
    const artifactReceipt = await verifyArtifacts(options);
    const fixtureReceipt = await runSafeFixture(
      cloneDirectory,
      passRoot,
      environment,
      identity
    );
    const report = {
      artifacts: artifactReceipt,
      completed_at: new Date().toISOString(),
      credential_contract: credentialContract(),
      expected_commit: options.expectedCommit,
      expected_tag: options.expectedTag,
      fixture: fixtureReceipt,
      format_version: FORMAT_VERSION,
      isolation_contract: isolationContract,
      kind: "kurobara-public-preview-pass",
      mode: options.allowLocalTestRemote ? "local-test" : "public-anonymous",
      outcome: "passed",
      pass: passNumber,
      repository_url: reportUrl(
        options.repositoryUrl,
        options.allowLocalTestRemote
      ),
      started_at: startedAt,
    };
    await writeReport(reportDirectory, `pass-${passNumber}.json`, report);
    return report;
  } catch (error) {
    await writeReport(reportDirectory, `pass-${passNumber}.json`, {
      completed_at: new Date().toISOString(),
      error_code: failureCode(error),
      format_version: FORMAT_VERSION,
      isolation_contract: isolationContract,
      kind: "kurobara-public-preview-pass",
      mode: options.allowLocalTestRemote ? "local-test" : "public-anonymous",
      outcome: "failed",
      pass: passNumber,
      started_at: startedAt,
    });
    throw error;
  } finally {
    if (identity === undefined) {
      await rm(passRoot, { force: true, recursive: true });
    }
  }
}

export async function runPublicPreviewGate(options) {
  if (!options.allowLocalTestRemote || options.testHarnessAuthorized !== true) {
    fail(
      "in-process-test-harness-required",
      "In-process execution is reserved for the explicit local test harness."
    );
  }
  await prepareReportDirectory(options.reportDirectory);
  const startedAt = new Date().toISOString();
  const reports = [];
  try {
    for (let passNumber = 1; passNumber <= options.passes; passNumber += 1) {
      reports.push(
        await runPass(
          options,
          passNumber,
          options.reportDirectory,
          testHarnessIsolationContract(passNumber)
        )
      );
    }
    if (
      reports.some(
        (report) =>
          report.expected_commit !== options.expectedCommit ||
          report.expected_tag !== options.expectedTag ||
          report.artifacts.manifest_sha256 !== options.expectedManifestSha256
      )
    ) {
      fail(
        "cross-pass-evidence-mismatch",
        "The two public preview passes did not verify the same release."
      );
    }
    const summary = {
      completed_at: new Date().toISOString(),
      expected_commit: options.expectedCommit,
      expected_manifest_sha256: options.expectedManifestSha256,
      expected_tag: options.expectedTag,
      format_version: FORMAT_VERSION,
      isolation_contract: {
        boundary: "in-process-test-harness",
        public_proof: false,
      },
      kind: "kurobara-public-preview-summary",
      mode: options.allowLocalTestRemote ? "local-test" : "public-anonymous",
      outcome: "passed",
      passes_completed: reports.length,
      passes_required: REQUIRED_PASS_COUNT,
      started_at: startedAt,
    };
    await writeReport(options.reportDirectory, "summary.json", summary);
    return summary;
  } catch (error) {
    await writeReport(options.reportDirectory, "summary.json", {
      completed_at: new Date().toISOString(),
      error_code: failureCode(error),
      format_version: FORMAT_VERSION,
      isolation_contract: {
        boundary: "in-process-test-harness",
        public_proof: false,
      },
      kind: "kurobara-public-preview-summary",
      mode: options.allowLocalTestRemote ? "local-test" : "public-anonymous",
      outcome: "failed",
      passes_completed: reports.length,
      passes_required: REQUIRED_PASS_COUNT,
      started_at: startedAt,
    });
    throw error;
  }
}

async function writeIsolatedFailureSummary(options, error, passesCompleted) {
  await writeReport(options.reportDirectory, "summary.json", {
    completed_at: new Date().toISOString(),
    error_code: failureCode(error),
    format_version: FORMAT_VERSION,
    isolation_contract: containerSummaryIsolationContract(),
    kind: "kurobara-public-preview-summary",
    mode: "public-anonymous",
    outcome: "failed",
    passes_completed: passesCompleted,
    passes_required: REQUIRED_PASS_COUNT,
  });
}

async function runIsolatedPass(options, passNumber) {
  if (
    options.allowLocalTestRemote ||
    options.reportDirectory !== ISOLATED_REPORT_DIRECTORY
  ) {
    fail(
      "isolated-pass-contract-invalid",
      "The isolated worker accepts only the fixed public container contract."
    );
  }
  await prepareReportDirectory(options.reportDirectory);
  await verifyIsolatedVerifier(options.reportDirectory);
  if (passNumber === 1) {
    return await runPass(
      options,
      1,
      options.reportDirectory,
      containerIsolationContract(1)
    );
  }

  let priorPass;
  let secondPass;
  try {
    priorPass = await readPriorPassReport(options);
    secondPass = await runPass(
      options,
      2,
      options.reportDirectory,
      containerIsolationContract(2)
    );
    if (
      canonicalJson(priorPass.report.artifacts) !==
        canonicalJson(secondPass.artifacts) ||
      secondPass.expected_commit !== options.expectedCommit ||
      secondPass.expected_tag !== options.expectedTag
    ) {
      fail(
        "cross-pass-evidence-mismatch",
        "The two isolated passes did not verify the same release."
      );
    }
    const secondPassBytes = Buffer.from(canonicalJson(secondPass), "utf8");
    const summary = {
      completed_at: new Date().toISOString(),
      expected_commit: options.expectedCommit,
      expected_manifest_sha256: options.expectedManifestSha256,
      expected_tag: options.expectedTag,
      format_version: FORMAT_VERSION,
      isolation_contract: containerSummaryIsolationContract(),
      kind: "kurobara-public-preview-summary",
      mode: "public-anonymous",
      outcome: "passed",
      pass_reports: [
        { pass: 1, sha256: priorPass.sha256 },
        { pass: 2, sha256: sha256(secondPassBytes) },
      ],
      passes_completed: REQUIRED_PASS_COUNT,
      passes_required: REQUIRED_PASS_COUNT,
      started_at: priorPass.report.started_at,
    };
    await writeReport(options.reportDirectory, "summary.json", summary);
    return summary;
  } catch (error) {
    const passReportPath = path.join(options.reportDirectory, "pass-2.json");
    const passReport = await lstat(passReportPath).catch(() => undefined);
    if (passReport === undefined) {
      await writeReport(options.reportDirectory, "pass-2.json", {
        completed_at: new Date().toISOString(),
        error_code: failureCode(error),
        format_version: FORMAT_VERSION,
        isolation_contract: containerIsolationContract(2),
        kind: "kurobara-public-preview-pass",
        mode: "public-anonymous",
        outcome: "failed",
        pass: 2,
      });
    }
    let passesCompleted = 0;
    if (priorPass !== undefined) {
      passesCompleted = 1;
    }
    if (secondPass !== undefined) {
      passesCompleted = 2;
    }
    await writeIsolatedFailureSummary(options, error, passesCompleted);
    throw error;
  }
}

function usage() {
  return [
    "Usage: bash scripts/public-preview-gate.sh",
    "  --repository-url <https-url>",
    "  --expected-commit <40-char-sha>",
    "  --expected-tag <tag>",
    "  --artifacts-manifest-url <https-url>",
    "  --expected-artifacts-manifest-sha256 <sha256:...>",
    "  --passes 2",
    "  --report-dir <absolute-new-directory>",
  ].join("\n");
}

async function main() {
  try {
    const isolatedPass = process.env[ISOLATED_PASS_ENVIRONMENT_KEY];
    const testHarness = isTestModeAllowed(process.env);
    if (!(testHarness || ["1", "2"].includes(isolatedPass))) {
      fail(
        "isolated-launcher-required",
        "Public preview proof must use scripts/public-preview-gate.sh."
      );
    }
    const options = parseArguments(process.argv.slice(2));
    const result = testHarness
      ? await runPublicPreviewGate(options)
      : await runIsolatedPass(options, Number(isolatedPass));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error_code: failureCode(error),
        outcome: "failed",
      })}\n${usage()}\n`
    );
    process.exitCode = 1;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await main();
}
