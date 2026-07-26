import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PLANNING_FILE = path.join(
  REPOSITORY_ROOT,
  "examples/planning-bundle.company-contact.v1.json"
);
const COMPOSE_FILE = path.join(REPOSITORY_ROOT, "infra/hatchet/compose.yaml");
const DEFAULT_PROVIDER_ENV_FILE = path.join(REPOSITORY_ROOT, ".env.local");
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const MAX_PLANNING_FILE_BYTES = 1024 * 1024;
const MAX_DOGFOOD_COMPANIES = 3;
const MAX_DOGFOOD_CONTACTS = 3;
const COMMAND_TERMINATION_GRACE_MS = 2000;
const COMMAND_FORCE_SETTLEMENT_GRACE_MS = 1000;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const ENV_LINE_PATTERN = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u;
const FORBIDDEN_ENV_LITERAL_PATTERN = /[\s`$\\'"]/u;
const NEWLINE_PATTERN = /\r?\n/u;
const WHITESPACE_PATTERN = /\s/u;
// biome-ignore lint/suspicious/noBitwiseOperators: O_NOFOLLOW must be combined with the read-only POSIX flag.
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const PROVIDER_VARIABLES = ["HUNTER_API_KEY", "PROSPEO_API_KEY"];
const REQUIRED_CAPABILITIES = [
  "organizations.discover",
  "contacts.discover",
  "contacts.identity.reveal",
  "contacts.work-email.resolve",
];
const API_KEY_PERMISSIONS = [
  "capabilities:list",
  "contacts:discover",
  "contacts:enrich",
  "contacts:export",
  "datasets:export",
  "datasets:generate",
  "datasets:read",
  "plans:quote",
  "steps:execute",
];
const EXIT = Object.freeze({
  configuration: 3,
  dependency: 5,
  internal: 70,
  interrupted: 130,
  liveFailure: 6,
  usage: 2,
});
const HELP = `Kurobara bounded B2B dogfood

Usage:
  npm run b2b:dogfood -- --help
  npm run b2b:dogfood:preflight
  npm run b2b:dogfood -- run --confirm-provider-calls [options]

Commands:
  preflight  Validate runtime, Docker, provider-key presence and the tracked B2B planning manifest. No provider call.
  run        Execute one bounded company -> contact -> identity -> work-email -> CSV export vertical.

Run options:
  --confirm-provider-calls  Required. Authorizes at most four provider requests.
  --country <ISO-2>         Company country (default: ES).
  --industry <value>        Hunter-compatible industry: gaming or software (default: software).
  --title <value>           Optional exact contact title filter (default: none).
  --timeout-ms <value>      Whole live run deadline, 60000..900000 (default: 600000).

Safety:
  Provider keys are read from the process environment first, then .env.local.
  Values are never printed. Infrastructure, API credentials and the PII-bearing
  export are isolated in a private temporary directory and deleted on cleanup.
  Output is a metadata-only JSON proof; it never contains company or contact data.
  The qualification route is Hunter company -> Prospeo verified-email shortlist,
  identity and work-email enrichment; no automatic fallback is inferred from a no-match.
  Company qualification is restricted to the exact 51-1000 employee buckets.

Exit codes:
  0 success, 2 usage, 3 configuration, 5 local dependency, 6 live flow,
  70 internal error, 130 interrupted.
`;

class DogfoodError extends Error {
  constructor(code, message, exitCode, options = {}) {
    super(message, options);
    this.code = code;
    this.exitCode = exitCode;
    this.name = "DogfoodError";
    this.providerCallsMayHaveOccurred =
      options.providerCallsMayHaveOccurred ?? false;
  }
}

const configurationError = (code, message, options) =>
  new DogfoodError(code, message, EXIT.configuration, options);

const usageError = (message) =>
  new DogfoodError("usage-invalid", message, EXIT.usage);

const baseEnvironment = () => ({
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  HOME: process.env.HOME ?? "",
  LANG: process.env.LANG ?? "C.UTF-8",
  NODE_OPTIONS: "",
  PATH: process.env.PATH ?? "",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

const capture = (stream, state) => {
  stream?.on("data", (chunk) => {
    if (state.bytes >= MAX_CAPTURE_BYTES) {
      return;
    }
    const bytes = Buffer.from(chunk);
    const available = MAX_CAPTURE_BYTES - state.bytes;
    state.chunks.push(bytes.subarray(0, available));
    state.bytes += Math.min(bytes.byteLength, available);
  });
};

const killProcessGroup = (child, signal) => {
  try {
    if (child.pid === undefined) {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // A concurrent process exit is equivalent to a successful stop request.
    }
  }
};

const processGroupExists = (processGroupId) => {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
};

const waitForProcessGroupExit = async (
  processGroupId,
  timeoutMs,
  pollIntervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now()))
    );
  }
  return true;
};

const compactDiagnostic = (value) =>
  String(value)
    .trim()
    .split(NEWLINE_PATTERN)
    .filter((line) => line.length > 0)
    .slice(-8)
    .join(" | ")
    .slice(0, 2000);

const sensitiveProblemDiagnostic = (result) => {
  for (const candidate of [result.stderr, result.stdout]) {
    try {
      const problem = JSON.parse(String(candidate).trim());
      if (
        typeof problem?.code === "string" &&
        (typeof problem?.status === "number" || problem?.status === undefined)
      ) {
        const status =
          problem.status === undefined ? "unknown" : String(problem.status);
        return `problem code ${problem.code}, status ${status}`;
      }
    } catch {
      // Provider and contact data remain withheld when the output is not a
      // single structured Kurobara problem document.
    }
  }
  return "diagnostic withheld because the command handled credentials or provider data";
};

const commandFailure = (result, code, signal, timedOut, options) => {
  const interrupted = options.signal?.aborted === true;
  let reason = `exit ${code ?? signal ?? "unknown"}`;
  let errorCode = "command-failed";
  let exitCode = options.exitCode ?? EXIT.dependency;
  if (interrupted) {
    reason = "interrupted";
    errorCode = "command-interrupted";
    exitCode = EXIT.interrupted;
  } else if (timedOut) {
    reason = "timeout";
    errorCode = "command-timeout";
  }
  let diagnostic = compactDiagnostic(result.stderr || result.stdout);
  if (options.sensitive) {
    diagnostic = sensitiveProblemDiagnostic(result);
  } else if (diagnostic.length === 0) {
    diagnostic = "no diagnostic";
  }
  return new DogfoodError(
    errorCode,
    `${options.label ?? "command"} failed (${reason}): ${diagnostic}.`,
    exitCode,
    {
      providerCallsMayHaveOccurred:
        options.providerCallsMayHaveOccurred ?? false,
    }
  );
};

const runCommand = (command, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const stdout = { bytes: 0, chunks: [] };
    const stderr = { bytes: 0, chunks: [] };
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      detached: true,
      env: options.environment ?? baseEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    let settled = false;
    let terminationRequested = false;
    let timedOut = false;
    let requiredServiceFailure;
    let commandTimeout;
    let escalationTimeout;
    let forcedSettlementTimeout;
    const requiredServiceChild = options.requiredService?.child;
    const terminationGraceMs =
      options.terminationGraceMs ?? COMMAND_TERMINATION_GRACE_MS;
    const forceSettlementGraceMs =
      options.forceSettlementGraceMs ?? COMMAND_FORCE_SETTLEMENT_GRACE_MS;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(commandTimeout);
      clearTimeout(escalationTimeout);
      clearTimeout(forcedSettlementTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      requiredServiceChild?.removeListener("close", onRequiredServiceClose);
      callback();
    };
    const settleFromExit = (code, signal) => {
      finish(() => {
        if (requiredServiceFailure !== undefined) {
          const serviceExit =
            requiredServiceFailure.code === null
              ? `signal ${requiredServiceFailure.signal ?? "unknown"}`
              : `exit ${requiredServiceFailure.code}`;
          reject(
            new DogfoodError(
              "required-service-exited",
              `${options.requiredServiceLabel ?? "required service"} stopped during ${options.label ?? "command"} (${serviceExit}); provider payload diagnostics are withheld.`,
              options.exitCode ?? EXIT.dependency,
              {
                providerCallsMayHaveOccurred:
                  options.providerCallsMayHaveOccurred ?? false,
              }
            )
          );
          return;
        }
        const result = {
          code,
          signal,
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          timedOut,
        };
        if (code === 0 && !timedOut && options.signal?.aborted !== true) {
          resolve(result);
          return;
        }
        reject(commandFailure(result, code, signal, timedOut, options));
      });
    };
    const forceSettlement = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settleFromExit(null, "SIGKILL");
    };
    const requestTermination = () => {
      if (settled || terminationRequested) {
        return;
      }
      terminationRequested = true;
      killProcessGroup(child, "SIGTERM");
      escalationTimeout = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        forcedSettlementTimeout = setTimeout(
          forceSettlement,
          forceSettlementGraceMs
        );
      }, terminationGraceMs);
    };
    const onAbort = () => {
      requestTermination();
    };
    const onRequiredServiceClose = (code, signal) => {
      requiredServiceFailure = { code, signal };
      requestTermination();
    };
    commandTimeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, options.timeoutMs ?? 300_000);
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("close", settleFromExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    requiredServiceChild?.once("close", onRequiredServiceClose);
    if (options.signal?.aborted === true) {
      onAbort();
    } else if (
      requiredServiceChild !== undefined &&
      (requiredServiceChild.exitCode !== null ||
        requiredServiceChild.signalCode !== null)
    ) {
      onRequiredServiceClose(
        requiredServiceChild.exitCode,
        requiredServiceChild.signalCode
      );
    }
  });

const npmInvocation = (arguments_) => {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && path.isAbsolute(npmExecPath)) {
    return {
      arguments: [npmExecPath, ...arguments_],
      command: process.execPath,
    };
  }
  return { arguments: arguments_, command: "npm" };
};

const runNpmCommand = (arguments_, options = {}) => {
  const invocation = npmInvocation(arguments_);
  return runCommand(invocation.command, invocation.arguments, options);
};

const startService = (command, arguments_, environment) => {
  const stdout = { bytes: 0, chunks: [] };
  const stderr = { bytes: 0, chunks: [] };
  const service = {
    child: undefined,
    processGroupId: undefined,
    spawnError: undefined,
  };
  const child = spawn(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.processGroupId = child.pid;
  capture(child.stdout, stdout);
  capture(child.stderr, stderr);
  child.once("error", (error) => {
    service.spawnError = error;
  });
  service.child = child;
  return service;
};

const startNpmService = (arguments_, environment) => {
  const invocation = npmInvocation(arguments_);
  return startService(invocation.command, invocation.arguments, environment);
};

const signalOwnedProcessGroup = (processGroupId, signal) => {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
};

const stopService = async (service, options = {}) => {
  const child = service?.child;
  if (child === undefined) {
    return;
  }
  const processGroupId = service.processGroupId;
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    if (service.spawnError !== undefined) {
      return;
    }
    throw new DogfoodError(
      "service-shutdown-unverifiable",
      "A local service has no verifiable process-group identity.",
      EXIT.internal
    );
  }
  if (!processGroupExists(processGroupId)) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new DogfoodError(
      "service-shutdown-ownership-lost",
      "A local service leader exited while its process group remained alive; shutdown ownership cannot be proven safely.",
      EXIT.internal
    );
  }
  signalOwnedProcessGroup(processGroupId, "SIGTERM");
  const terminationGraceMs = options.terminationGraceMs ?? 15_000;
  if (await waitForProcessGroupExit(processGroupId, terminationGraceMs)) {
    return;
  }
  signalOwnedProcessGroup(processGroupId, "SIGKILL");
  const forceSettlementGraceMs =
    options.forceSettlementGraceMs ?? COMMAND_FORCE_SETTLEMENT_GRACE_MS;
  if (
    !(await waitForProcessGroupExit(processGroupId, forceSettlementGraceMs))
  ) {
    throw new DogfoodError(
      "service-shutdown-failed",
      "A local service process group remained alive after forced shutdown.",
      EXIT.internal
    );
  }
};

const installInterruptGuard = (controller, signalHost = process) => {
  const signals = ["SIGINT", "SIGTERM"];
  let count = 0;
  const handleSignal = () => {
    count += 1;
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  for (const signal of signals) {
    signalHost.on(signal, handleSignal);
  }
  return Object.freeze({
    count: () => count,
    dispose: () => {
      for (const signal of signals) {
        signalHost.off(signal, handleSignal);
      }
    },
  });
};

const assertServiceAlive = async (service, label, signal) => {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, 1500);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          new DogfoodError(
            "run-interrupted",
            "The dogfood run was interrupted.",
            EXIT.interrupted
          )
        );
      },
      { once: true }
    );
  });
  if (
    service.spawnError !== undefined ||
    service.child?.exitCode !== null ||
    service.child?.signalCode !== null
  ) {
    throw new DogfoodError(
      "service-start-failed",
      `${label} exited before readiness; diagnostics are withheld.`,
      EXIT.liveFailure
    );
  }
};

const waitForApi = async (endpoint, service, signal) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (
      service.spawnError !== undefined ||
      service.child?.exitCode !== null ||
      service.child?.signalCode !== null
    ) {
      throw new DogfoodError(
        "api-start-failed",
        "The API exited before readiness; diagnostics are withheld.",
        EXIT.liveFailure
      );
    }
    try {
      const response = await fetch(`${endpoint}/readyz`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      if (signal.aborted) {
        throw new DogfoodError(
          "run-interrupted",
          "The dogfood run was interrupted.",
          EXIT.interrupted
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new DogfoodError(
    "api-readiness-timeout",
    "The API did not become ready within 45 seconds.",
    EXIT.liveFailure
  );
};

const applyRunOption = (parsed, argument, value) => {
  if (argument === "--country") {
    parsed.country = value;
    return;
  }
  if (argument === "--industry") {
    parsed.industry = value;
    return;
  }
  if (argument === "--title") {
    parsed.title = value;
    return;
  }
  parsed.timeoutMs = Number(value);
};

const validateRunOptions = (parsed) => {
  if (!COUNTRY_PATTERN.test(parsed.country)) {
    throw usageError("--country must be an uppercase ISO alpha-2 code.");
  }
  if (parsed.industry !== "gaming" && parsed.industry !== "software") {
    throw usageError("--industry must be gaming or software.");
  }
  if (
    parsed.title !== undefined &&
    (parsed.title.trim() !== parsed.title ||
      parsed.title.length === 0 ||
      parsed.title.length > 120)
  ) {
    throw usageError(
      "--title must contain 1 to 120 characters without surrounding whitespace."
    );
  }
  if (
    !Number.isSafeInteger(parsed.timeoutMs) ||
    parsed.timeoutMs < 60_000 ||
    parsed.timeoutMs > 900_000
  ) {
    throw usageError("--timeout-ms must be an integer from 60000 to 900000.");
  }
  if (!parsed.confirmProviderCalls) {
    throw usageError(
      "run requires --confirm-provider-calls because it can consume provider quota."
    );
  }
};

const parseRunArguments = (arguments_) => {
  const parsed = {
    command: "run",
    confirmProviderCalls: false,
    country: "ES",
    industry: "software",
    timeoutMs: 600_000,
    title: undefined,
  };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (seen.has(argument)) {
      throw usageError(`Duplicate option: ${argument}.`);
    }
    seen.add(argument);
    if (argument === "--confirm-provider-calls") {
      parsed.confirmProviderCalls = true;
      continue;
    }
    if (
      !["--country", "--industry", "--timeout-ms", "--title"].includes(argument)
    ) {
      throw usageError(`Unknown option: ${argument}.`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw usageError(`${argument} requires a value.`);
    }
    index += 1;
    applyRunOption(parsed, argument, value);
  }
  validateRunOptions(parsed);
  return parsed;
};

const parseArguments = (arguments_) => {
  const [command, ...options] = arguments_;
  if (command === undefined || command === "--help" || command === "help") {
    return { command: "help" };
  }
  if (command === "preflight") {
    if (options.length > 0) {
      throw usageError("preflight does not accept options.");
    }
    return { command };
  }
  if (command === "run") {
    return parseRunArguments(options);
  }
  throw usageError(`Unknown command: ${command}.`);
};

const readPrivateEnvironmentFile = async (file) => {
  let handle;
  try {
    handle = await open(file, READ_NOFOLLOW_FLAGS);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw configurationError(
      "provider-env-unavailable",
      "The provider environment file is unavailable or is a symlink."
    );
  }
  try {
    const metadata = await handle.stat();
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a mask.
    const isPrivate = (metadata.mode & 0o077) === 0;
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_ENV_FILE_BYTES ||
      !isPrivate
    ) {
      throw configurationError(
        "provider-env-unsafe",
        ".env.local must be a non-empty private regular file no larger than 64 KiB."
      );
    }
    const values = {};
    const source = await handle.readFile("utf8");
    for (const [index, sourceLine] of source.split(NEWLINE_PATTERN).entries()) {
      const line = sourceLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      const match = ENV_LINE_PATTERN.exec(line);
      if (match === null) {
        throw configurationError(
          "provider-env-invalid",
          `.env.local line ${index + 1} is invalid.`
        );
      }
      const [, name, rawValue] = match;
      if (!PROVIDER_VARIABLES.includes(name)) {
        continue;
      }
      if (Object.hasOwn(values, name)) {
        throw configurationError(
          "provider-env-invalid",
          `.env.local contains a duplicate ${name} entry.`
        );
      }
      if (
        rawValue.length === 0 ||
        rawValue.trim() !== rawValue ||
        FORBIDDEN_ENV_LITERAL_PATTERN.test(rawValue)
      ) {
        throw configurationError(
          "provider-env-invalid",
          `${name} must be an unquoted literal without whitespace or shell expansion.`
        );
      }
      values[name] = rawValue;
    }
    return values;
  } finally {
    await handle.close();
  }
};

const loadProviderEnvironment = async () => {
  const fromFile = await readPrivateEnvironmentFile(DEFAULT_PROVIDER_ENV_FILE);
  const environment = {};
  for (const name of PROVIDER_VARIABLES) {
    const value = process.env[name] ?? fromFile[name];
    if (
      value === undefined ||
      value.length === 0 ||
      value.trim() !== value ||
      WHITESPACE_PATTERN.test(value)
    ) {
      throw configurationError(
        "provider-key-missing",
        `${name} must be present in the process environment or private .env.local.`
      );
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
};

const readPlanningManifest = async () => {
  let handle;
  try {
    handle = await open(PLANNING_FILE, READ_NOFOLLOW_FLAGS);
  } catch {
    throw configurationError(
      "planning-file-unavailable",
      "The tracked B2B planning manifest is unavailable or is a symlink."
    );
  }
  try {
    const metadata = await handle.stat();
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a mask.
    const isOperatorSafe = (metadata.mode & 0o022) === 0;
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_PLANNING_FILE_BYTES ||
      !isOperatorSafe
    ) {
      throw configurationError(
        "planning-file-unsafe",
        "The B2B planning manifest must be a non-empty regular file no larger than 1 MiB and not group/world writable."
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw configurationError(
        "planning-json-invalid",
        "The B2B planning manifest is not valid JSON."
      );
    }
    return manifest;
  } finally {
    await handle.close();
  }
};

const inspectPlanningManifest = (manifest) => {
  const planning = manifest?.planning;
  if (
    manifest?.formatVersion !== "1.0.0" ||
    typeof planning?.workspaceId !== "string" ||
    !Array.isArray(planning?.authorities)
  ) {
    throw configurationError(
      "planning-shape-invalid",
      "The B2B planning manifest does not expose the supported workspace and authority shape."
    );
  }
  const authorityFor = {};
  for (const capabilityId of REQUIRED_CAPABILITIES) {
    const authority = planning.authorities.find((candidate) =>
      candidate?.capabilities?.some(
        (capability) =>
          capability?.capabilityId === capabilityId &&
          capability?.capabilityVersion === "1.0.0"
      )
    );
    if (authority === undefined) {
      throw configurationError(
        "planning-capability-missing",
        `The B2B planning manifest does not admit ${capabilityId}@1.0.0.`
      );
    }
    authorityFor[capabilityId] = authority;
  }
  const authorities = Object.values(authorityFor);
  const workspaceId = planning.workspaceId;
  const actorId = authorities[0]?.subjectActorId;
  if (
    typeof actorId !== "string" ||
    actorId.length === 0 ||
    authorities.some(
      (authority) =>
        authority.workspaceId !== workspaceId ||
        authority.subjectActorId !== actorId ||
        authority.deadline <= Date.now() + 900_000
    )
  ) {
    throw configurationError(
      "planning-authority-inconsistent",
      "B2B authorities must share one workspace, one actor and a future dogfood deadline."
    );
  }
  return Object.freeze({
    actorId,
    authorities: Object.freeze(
      Object.fromEntries(
        Object.entries(authorityFor).map(([capabilityId, authority]) => [
          capabilityId,
          authority.authorityEnvelopeId,
        ])
      )
    ),
    workspaceId,
  });
};

const jsonOutput = (result, label, exitCode = EXIT.liveFailure) => {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new DogfoodError(
      "command-output-invalid",
      `${label} did not return one JSON document.`,
      exitCode
    );
  }
};

const preflight = async () => {
  if (process.version !== "v24.14.0") {
    throw configurationError(
      "node-version-invalid",
      `Node v24.14.0 is required; detected ${process.version}.`
    );
  }
  const npmVersion = (
    await runNpmCommand(["--version"], {
      label: "npm version check",
      timeoutMs: 15_000,
    })
  ).stdout.trim();
  if (npmVersion !== "10.9.4") {
    throw configurationError(
      "npm-version-invalid",
      `npm 10.9.4 is required; detected ${npmVersion || "unknown"}.`
    );
  }
  const providerEnvironment = await loadProviderEnvironment();
  const planning = inspectPlanningManifest(await readPlanningManifest());
  await runNpmCommand(
    [
      "run",
      "--silent",
      "bootstrap:planning",
      "-w",
      "@kurobara/api",
      "--",
      "--check",
      "--file",
      PLANNING_FILE,
    ],
    {
      environment: baseEnvironment(),
      exitCode: EXIT.configuration,
      label: "B2B planning manifest check",
      timeoutMs: 60_000,
    }
  );
  await runCommand("docker", ["info"], {
    label: "Docker daemon check",
    timeoutMs: 30_000,
  });
  await runCommand("docker", ["compose", "version"], {
    label: "Docker Compose check",
    timeoutMs: 15_000,
  });
  return {
    planning,
    providerEnvironment,
    report: {
      command: "preflight",
      docker: "available",
      live_provider_calls: false,
      node_version: process.version.slice(1),
      npm_version: npmVersion,
      planning_manifest: path.relative(REPOSITORY_ROOT, PLANNING_FILE),
      provider_credentials: {
        hunter: "available",
        prospeo: "available",
      },
      status: "ready",
    },
  };
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const { port } = address;
      server.close((error) =>
        error === undefined ? resolve(port) : reject(error)
      );
    });
  });

const distinctPorts = async (count) => {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(await freePort());
  }
  return [...ports];
};

const writePrivateFile = async (file, content) => {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createRunState = async (dependencies = {}) => {
  const createStateDirectory =
    dependencies.createStateDirectory ??
    (() => mkdtemp(path.join(tmpdir(), "kurobara-b2b-dogfood.")));
  const allocateDistinctPorts =
    dependencies.allocateDistinctPorts ?? distinctPorts;
  const writeStateFile = dependencies.writeStateFile ?? writePrivateFile;
  let stateDirectory;
  try {
    stateDirectory = await createStateDirectory();
    await chmod(stateDirectory, 0o700);
    const [apiPort, dashboardPort, grpcPort, postgresPort] =
      await allocateDistinctPorts(4);
    const suffix = randomBytes(8).toString("hex");
    const state = {
      api: undefined,
      apiPort,
      composeEnvFile: path.join(stateDirectory, "compose.env"),
      composeProject: `kurobara-b2b-dogfood-${suffix}`,
      dashboardPort,
      databasePassword: `dogfood_${randomBytes(24).toString("hex")}`,
      exportFile: path.join(stateDirectory, "contacts.csv"),
      grpcPort,
      postgresPort,
      stateDirectory,
      worker: undefined,
    };
    await writeStateFile(
      state.composeEnvFile,
      [
        `COMPOSE_PROJECT_NAME=${state.composeProject}`,
        `HATCHET_DASHBOARD_PORT=${dashboardPort}`,
        `HATCHET_GRPC_PORT=${grpcPort}`,
        `HATCHET_POSTGRES_PASSWORD=dogfood_${randomBytes(24).toString("hex")}`,
        `KUROBARA_POSTGRES_PORT=${postgresPort}`,
        `KUROBARA_POSTGRES_PASSWORD=${state.databasePassword}`,
        "",
      ].join("\n")
    );
    return state;
  } catch (error) {
    if (stateDirectory !== undefined) {
      try {
        await rm(stateDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new DogfoodError(
          "state-construction-cleanup-failed",
          `Dogfood state construction failed and private recovery state remains at ${stateDirectory}.`,
          EXIT.internal,
          { cause: cleanupError }
        );
      }
    }
    throw error;
  }
};

const composeRuntimeEnvironments = (
  runtimeEnvironment,
  providerEnvironment
) => {
  const {
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: privacySecret,
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION: privacySecretVersion,
    ...nonSecretRuntimeEnvironment
  } = runtimeEnvironment;
  const privacyEnvironment = {
    ...(privacySecret === undefined
      ? {}
      : { KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: privacySecret }),
    ...(privacySecretVersion === undefined
      ? {}
      : {
          KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION: privacySecretVersion,
        }),
  };
  // The API builds non-secret route descriptors from credential presence only;
  // provider effects execute exclusively in the worker. Presence markers keep
  // route planning exact without copying real provider credentials into the API.
  const providerPresenceEnvironment = Object.fromEntries(
    PROVIDER_VARIABLES.map((name) => [name, "configured-in-worker"])
  );
  return Object.freeze({
    api: Object.freeze({
      ...nonSecretRuntimeEnvironment,
      ...privacyEnvironment,
      ...providerPresenceEnvironment,
    }),
    bootstrap: Object.freeze(nonSecretRuntimeEnvironment),
    worker: Object.freeze({
      ...nonSecretRuntimeEnvironment,
      ...privacyEnvironment,
      ...providerEnvironment,
    }),
  });
};

const composeArguments = (state, tail) => [
  "compose",
  "--env-file",
  state.composeEnvFile,
  "--file",
  COMPOSE_FILE,
  "--project-directory",
  REPOSITORY_ROOT,
  "--project-name",
  state.composeProject,
  ...tail,
];

const runCli = async (arguments_, environment, options) =>
  jsonOutput(
    await runNpmCommand(["run", "--silent", "kurobara", "--", ...arguments_], {
      environment,
      exitCode: EXIT.liveFailure,
      label: options.label,
      providerCallsMayHaveOccurred:
        options.providerCallsMayHaveOccurred ?? false,
      requiredService: options.requiredService,
      requiredServiceLabel: options.requiredServiceLabel,
      sensitive: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }),
    options.label
  );

const assertReadyGeneration = (snapshot, label) => {
  if (
    snapshot?.terminal !== true ||
    snapshot?.state !== "completed" ||
    snapshot?.materialization_state !== "ready" ||
    !Number.isInteger(snapshot?.record_count) ||
    snapshot.record_count < 1
  ) {
    const diagnostic = [
      ["state", snapshot?.state],
      ["materialization", snapshot?.materialization_state],
      ["records", snapshot?.record_count],
      ["calls", snapshot?.counters?.calls],
      ["returned", snapshot?.counters?.returned],
      ["accepted", snapshot?.counters?.accepted],
      ["rejected", snapshot?.counters?.rejected],
    ]
      .map(([key, value]) =>
        typeof value === "string" || Number.isSafeInteger(value)
          ? `${key}=${value}`
          : `${key}=unknown`
      )
      .join(", ");
    throw new DogfoodError(
      "generation-not-ready",
      `${label} did not converge to one ready result (${diagnostic}).`,
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
};

const parseCsvRow = (line) => {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) {
    throw new DogfoodError(
      "export-csv-invalid",
      "The final export contains an unterminated CSV field.",
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
  values.push(current);
  return values;
};

const verifyContactExport = async (file) => {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0 || metadata.mode % 64 !== 0) {
    throw new DogfoodError(
      "export-file-unsafe",
      "The final contact export was not written as a private non-empty file.",
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
  const source = await readFile(file, "utf8");
  const rows = source.split(NEWLINE_PATTERN).filter((line) => line.length > 0);
  if (rows.length !== 2) {
    throw new DogfoodError(
      "export-cardinality-invalid",
      "The final contact export does not contain exactly one data row.",
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
  const headers = parseCsvRow(rows[0]);
  const values = parseCsvRow(rows[1]);
  const workEmail = values[headers.indexOf("work_email")];
  const workEmailStatus = values[headers.indexOf("work_email_status")];
  const workEmailVerification =
    values[headers.indexOf("work_email_verification")];
  if (
    typeof workEmail !== "string" ||
    !workEmail.includes("@") ||
    workEmailStatus !== "found" ||
    workEmailVerification !== "valid"
  ) {
    throw new DogfoodError(
      "work-email-not-verified",
      "The bounded export did not contain one valid verified work email.",
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
};

const remainingTime = (deadline) => {
  const remaining = deadline - Date.now();
  if (remaining < 1000) {
    throw new DogfoodError(
      "run-timeout",
      "The bounded dogfood deadline elapsed.",
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred: true }
    );
  }
  return remaining;
};

const runDogfood = async (options, preflightResult) => {
  const state = await createRunState();
  const controller = new AbortController();
  const deadline = Date.now() + options.timeoutMs;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const interruptGuard = installInterruptGuard(controller);
  let providerCallsMayHaveOccurred = false;
  const cleanupFailures = [];
  let stateDirectoryRemoved = false;
  let runFailure;
  let report;
  try {
    const startLocalRuntime = async () => {
      await runCommand(
        "docker",
        composeArguments(state, [
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "180",
          "hatchet",
          "kurobara-postgres",
        ]),
        {
          label: "isolated Hatchet and PostgreSQL startup",
          signal: controller.signal,
          timeoutMs: Math.min(240_000, remainingTime(deadline)),
        }
      );
      const token = (
        await runCommand(
          "docker",
          composeArguments(state, [
            "exec",
            "-T",
            "hatchet",
            "cat",
            "/config/authdisabled-token",
          ]),
          {
            label: "Hatchet local token readback",
            sensitive: true,
            signal: controller.signal,
            timeoutMs: Math.min(30_000, remainingTime(deadline)),
          }
        )
      ).stdout.trim();
      if (token.length === 0 || token.length > 8192 || !token.includes(".")) {
        throw new DogfoodError(
          "hatchet-token-invalid",
          "The local Hatchet fixture did not return a structurally valid token.",
          EXIT.liveFailure
        );
      }
      const databaseUrl = `postgres://kurobara:${encodeURIComponent(
        state.databasePassword
      )}@127.0.0.1:${state.postgresPort}/kurobara`;
      const privacySecret = randomBytes(48).toString("base64url");
      const runtimeEnvironment = {
        ...baseEnvironment(),
        KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: privacySecret,
        KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION: "v1",
        KUROBARA_DATABASE_URL: databaseUrl,
        KUROBARA_PROVIDER_ORDER: "prospeo,hunter",
        NODE_ENV: "development",
      };
      const environments = composeRuntimeEnvironments(
        runtimeEnvironment,
        preflightResult.providerEnvironment
      );
      await runNpmCommand(
        [
          "run",
          "--silent",
          "bootstrap:planning",
          "-w",
          "@kurobara/api",
          "--",
          "--apply",
          "--file",
          PLANNING_FILE,
        ],
        {
          environment: environments.bootstrap,
          exitCode: EXIT.liveFailure,
          label: "B2B planning bootstrap",
          sensitive: true,
          signal: controller.signal,
          timeoutMs: Math.min(90_000, remainingTime(deadline)),
        }
      );
      const keyResult = await runNpmCommand(
        ["run", "--silent", "bootstrap:api-key", "-w", "@kurobara/api"],
        {
          environment: {
            ...environments.bootstrap,
            KUROBARA_BOOTSTRAP_ACTOR_ID: preflightResult.planning.actorId,
            KUROBARA_BOOTSTRAP_KEY_LABEL: "dogfood",
            KUROBARA_BOOTSTRAP_PERMISSIONS: API_KEY_PERMISSIONS.join(","),
            KUROBARA_BOOTSTRAP_WORKSPACE_ID:
              preflightResult.planning.workspaceId,
          },
          exitCode: EXIT.liveFailure,
          label: "ephemeral API key bootstrap",
          sensitive: true,
          signal: controller.signal,
          timeoutMs: Math.min(90_000, remainingTime(deadline)),
        }
      );
      const keyDocument = jsonOutput(keyResult, "ephemeral API key bootstrap");
      if (
        typeof keyDocument.presented_key !== "string" ||
        keyDocument.presented_key.length === 0
      ) {
        throw new DogfoodError(
          "api-key-output-invalid",
          "The ephemeral API key bootstrap returned no credential.",
          EXIT.liveFailure
        );
      }
      const apiKeyFile = path.join(state.stateDirectory, "api-key");
      await writePrivateFile(apiKeyFile, `${keyDocument.presented_key}\n`);
      const endpoint = `http://127.0.0.1:${state.apiPort}`;
      state.api = startNpmService(["run", "--silent", "start:api"], {
        ...environments.api,
        KUROBARA_API_HOST: "127.0.0.1",
        KUROBARA_API_PORT: String(state.apiPort),
      });
      await assertServiceAlive(state.api, "API", controller.signal);
      await waitForApi(endpoint, state.api, controller.signal);
      state.worker = startNpmService(["run", "--silent", "start:worker"], {
        ...environments.worker,
        HATCHET_CLIENT_API_URL: `http://127.0.0.1:${state.dashboardPort}`,
        HATCHET_CLIENT_HOST_PORT: `127.0.0.1:${state.grpcPort}`,
        HATCHET_CLIENT_NAMESPACE: "kurobara-b2b-dogfood",
        HATCHET_CLIENT_TLS_STRATEGY: "none",
        HATCHET_CLIENT_TOKEN: token,
        KUROBARA_DISPATCHER_ID: "b2b-dogfood-run-dispatcher",
        KUROBARA_LEAF_OUTBOX_MAX_ATTEMPTS: "1",
        KUROBARA_LEAF_DISPATCHER_ID: "b2b-dogfood-leaf-dispatcher",
        KUROBARA_LEAF_EFFECT_ADAPTER: "configured-providers",
        KUROBARA_LEAF_EFFECT_RECONCILER_INITIAL_DELAY_MS: "1000",
        KUROBARA_LEAF_EFFECT_RECONCILER_ID: "b2b-dogfood-effect-reconciler",
        KUROBARA_LEAF_EFFECT_RECONCILER_MAX_ATTEMPTS: "1",
        KUROBARA_LEAF_EFFECT_RECONCILER_RETRY_DELAY_MS: "1000",
        KUROBARA_RECONCILER_ID: "b2b-dogfood-run-reconciler",
        KUROBARA_ROUTE_SCHEDULER_ID: "b2b-dogfood-route-scheduler",
        KUROBARA_OUTBOX_MAX_ATTEMPTS: "1",
        KUROBARA_WORKER_ID: "b2b-dogfood-worker",
      });
      await assertServiceAlive(state.worker, "worker", controller.signal);
      return {
        apiKeyFile,
        cliEnvironment: baseEnvironment(),
        endpoint,
      };
    };
    const { apiKeyFile, cliEnvironment, endpoint } = await startLocalRuntime();
    const runRuntimeCli = (arguments_, options) =>
      runCli(arguments_, cliEnvironment, {
        ...options,
        requiredService: state.worker,
        requiredServiceLabel: "Kurobara worker",
      });
    const runCompanyDiscovery = async () => {
      const suffix = randomBytes(8).toString("hex");
      const operationDeadline = deadline - 5000;
      const companyDatasetId = `dataset-company-dogfood-${suffix}`;
      const companyArguments = [
        "company",
        "search",
        "--api-key-file",
        apiKeyFile,
        "--endpoint",
        endpoint,
        "--authority-envelope-id",
        preflightResult.planning.authorities["organizations.discover"],
        "--budget-limit",
        "1",
        "--budget-unit",
        "requests",
        "--country",
        options.country,
        "--dataset-id",
        companyDatasetId,
        "--dataset-name",
        "Bounded B2B dogfood companies",
        "--deadline-ms",
        String(operationDeadline),
        "--discovery-id",
        `discovery-company-dogfood-${suffix}`,
        "--employee-maximum",
        "1000",
        "--employee-minimum",
        "51",
        "--industry",
        options.industry,
        "--max-calls",
        "1",
        "--max-companies",
        String(MAX_DOGFOOD_COMPANIES),
        "--max-pages",
        "1",
      ];
      const companyDryRun = await runRuntimeCli(
        [...companyArguments, "--mode", "dry-run"],
        {
          label: "company dry-run",
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (companyDryRun?.state !== "planned") {
        throw new DogfoodError(
          "company-plan-invalid",
          "The bounded company dry-run was not planned.",
          EXIT.liveFailure
        );
      }
      providerCallsMayHaveOccurred = true;
      const companyStart = await runRuntimeCli(
        [...companyArguments, "--mode", "start"],
        {
          label: "company start",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (typeof companyStart?.generation_id !== "string") {
        throw new DogfoodError(
          "company-generation-invalid",
          "The bounded company start returned no generation.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const companySnapshot = await runRuntimeCli(
        [
          "company",
          "watch",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          companyStart.generation_id,
          "--poll-interval-ms",
          "1000",
          "--timeout-ms",
          String(Math.min(180_000, remainingTime(deadline))),
        ],
        {
          label: "company watch",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(190_000, remainingTime(deadline)),
        }
      );
      assertReadyGeneration(companySnapshot, "Company generation");
      const companyResults = await runRuntimeCli(
        [
          "company",
          "results",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          companyStart.generation_id,
          "--limit",
          String(MAX_DOGFOOD_COMPANIES),
          "--after-ordinal",
          "0",
        ],
        {
          label: "company results",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      const companyCount = companyResults?.items?.length;
      if (
        !Number.isSafeInteger(companyCount) ||
        companyCount < 1 ||
        companyCount > MAX_DOGFOOD_COMPANIES
      ) {
        throw new DogfoodError(
          "company-cardinality-invalid",
          "The bounded company readback exceeded its one-to-three company envelope.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      return { companyCount, companyStart, operationDeadline, suffix };
    };
    const { companyCount, companyStart, operationDeadline, suffix } =
      await runCompanyDiscovery();
    const runContactPipeline = async () => {
      const contactDatasetId = `dataset-contact-dogfood-${suffix}`;
      const contactArguments = [
        "contact",
        "search",
        "--api-key-file",
        apiKeyFile,
        "--endpoint",
        endpoint,
        "--authority-envelope-id",
        preflightResult.planning.authorities["contacts.discover"],
        "--budget-limit",
        "1",
        "--budget-unit",
        "requests",
        "--company-country",
        options.country,
        "--dataset-id",
        contactDatasetId,
        "--dataset-name",
        "Bounded B2B dogfood contact",
        "--deadline-ms",
        String(operationDeadline),
        "--discovery-id",
        `discovery-contact-dogfood-${suffix}`,
        "--max-calls",
        "1",
        "--max-companies",
        String(MAX_DOGFOOD_COMPANIES),
        "--max-contacts-per-company",
        "1",
        "--max-contacts-total",
        String(MAX_DOGFOOD_CONTACTS),
        "--max-pages",
        "1",
        "--organization-generation-id",
        companyStart.generation_id,
        ...(options.title === undefined ? [] : ["--title", options.title]),
      ];
      const contactDryRun = await runRuntimeCli(
        [...contactArguments, "--mode", "dry-run"],
        {
          label: "contact dry-run",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (contactDryRun?.state !== "planned") {
        throw new DogfoodError(
          "contact-plan-invalid",
          "The bounded contact dry-run was not planned.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const contactStart = await runRuntimeCli(
        [...contactArguments, "--mode", "start"],
        {
          label: "contact start",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (typeof contactStart?.generation_id !== "string") {
        throw new DogfoodError(
          "contact-generation-invalid",
          "The bounded contact start returned no generation.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const contactSnapshot = await runRuntimeCli(
        [
          "company",
          "watch",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          contactStart.generation_id,
          "--poll-interval-ms",
          "1000",
          "--timeout-ms",
          String(Math.min(180_000, remainingTime(deadline))),
        ],
        {
          label: "contact watch",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(190_000, remainingTime(deadline)),
        }
      );
      assertReadyGeneration(contactSnapshot, "Contact generation");
      const contactResults = await runRuntimeCli(
        [
          "contact",
          "results",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          contactStart.generation_id,
          "--limit",
          String(MAX_DOGFOOD_CONTACTS),
          "--after-ordinal",
          "0",
        ],
        {
          label: "contact results",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      const contactCount = contactResults?.items?.length;
      const contactRecordId = contactResults?.items?.[0]?.candidate?.contact_id;
      if (
        !Number.isSafeInteger(contactCount) ||
        contactCount < 1 ||
        contactCount > MAX_DOGFOOD_CONTACTS ||
        typeof contactRecordId !== "string" ||
        contactRecordId.length === 0
      ) {
        throw new DogfoodError(
          "contact-cardinality-invalid",
          "The bounded contact readback exceeded its one-to-three contact envelope.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const identity = await runRuntimeCli(
        [
          "contact",
          "reveal-identity",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--authority-envelope-id",
          preflightResult.planning.authorities["contacts.identity.reveal"],
          "--budget-limit",
          "1",
          "--budget-unit",
          "requests",
          "--contact-dataset-id",
          contactDatasetId,
          "--deadline-ms",
          String(operationDeadline),
          "--operation-id",
          `identity-dogfood-${suffix}`,
          "--record-id",
          contactRecordId,
        ],
        {
          label: "contact identity reveal",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (
        typeof identity?.generation_id !== "string" ||
        typeof identity?.result_dataset_id !== "string"
      ) {
        throw new DogfoodError(
          "identity-generation-invalid",
          "The identity derivation returned no durable generation and dataset.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const identitySnapshot = await runRuntimeCli(
        [
          "company",
          "watch",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          identity.generation_id,
          "--poll-interval-ms",
          "1000",
          "--timeout-ms",
          String(Math.min(180_000, remainingTime(deadline))),
        ],
        {
          label: "identity watch",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(190_000, remainingTime(deadline)),
        }
      );
      assertReadyGeneration(identitySnapshot, "Identity generation");
      const workEmail = await runRuntimeCli(
        [
          "contact",
          "enrich-email",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--authority-envelope-id",
          preflightResult.planning.authorities["contacts.work-email.resolve"],
          "--budget-limit",
          "1",
          "--budget-unit",
          "requests",
          "--contact-dataset-id",
          identity.result_dataset_id,
          "--deadline-ms",
          String(operationDeadline),
          "--operation-id",
          `work-email-dogfood-${suffix}`,
          "--record-id",
          contactRecordId,
        ],
        {
          label: "contact work-email resolution",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(30_000, remainingTime(deadline)),
        }
      );
      if (
        typeof workEmail?.generation_id !== "string" ||
        typeof workEmail?.result_dataset_id !== "string"
      ) {
        throw new DogfoodError(
          "work-email-generation-invalid",
          "The work-email derivation returned no durable generation and dataset.",
          EXIT.liveFailure,
          { providerCallsMayHaveOccurred }
        );
      }
      const workEmailSnapshot = await runRuntimeCli(
        [
          "company",
          "watch",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--generation-id",
          workEmail.generation_id,
          "--poll-interval-ms",
          "1000",
          "--timeout-ms",
          String(Math.min(180_000, remainingTime(deadline))),
        ],
        {
          label: "work-email watch",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(190_000, remainingTime(deadline)),
        }
      );
      assertReadyGeneration(workEmailSnapshot, "Work-email generation");
      await runRuntimeCli(
        [
          "dataset",
          "export",
          "--api-key-file",
          apiKeyFile,
          "--endpoint",
          endpoint,
          "--dataset-id",
          workEmail.result_dataset_id,
          "--format",
          "csv",
          "--output",
          state.exportFile,
          "--max-bytes",
          "1048576",
          "--timeout-ms",
          String(Math.min(120_000, remainingTime(deadline))),
        ],
        {
          label: "contact dataset export",
          providerCallsMayHaveOccurred,
          signal: controller.signal,
          timeoutMs: Math.min(130_000, remainingTime(deadline)),
        }
      );
      await verifyContactExport(state.exportFile);
      return {
        bounds: {
          companies: MAX_DOGFOOD_COMPANIES,
          contacts: MAX_DOGFOOD_CONTACTS,
          max_provider_requests: 4,
        },
        command: "run",
        cleanup: "pending",
        proof: {
          api: "ready",
          company_records: companyCount,
          contact_records: contactCount,
          export: "private-csv-verified",
          hatchet: "executed",
          identity: "ready",
          postgres: "durable-during-run",
          providers: ["hunter", "prospeo"],
          work_email: "found-and-valid",
        },
        status: "passed",
      };
    };
    report = await runContactPipeline();
  } catch (error) {
    runFailure = error;
  } finally {
    clearTimeout(timeout);
    for (const service of [state.worker, state.api]) {
      try {
        await stopService(service);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    let infrastructureRemoved = false;
    try {
      await runCommand(
        "docker",
        composeArguments(state, ["down", "--volumes", "--remove-orphans"]),
        {
          label: "isolated infrastructure cleanup",
          timeoutMs: 120_000,
        }
      );
      infrastructureRemoved = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (infrastructureRemoved) {
      try {
        await rm(state.stateDirectory, { force: true, recursive: true });
        stateDirectoryRemoved = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length === 0 && report !== undefined) {
      report.cleanup = "completed";
    }
    interruptGuard.dispose();
  }
  if (cleanupFailures.length > 0) {
    const recovery = stateDirectoryRemoved
      ? "The private state directory was removed, but local process or infrastructure shutdown was not fully proven."
      : `Private recovery state remains at ${state.stateDirectory}.`;
    throw new DogfoodError(
      "cleanup-failed",
      `Cleanup failed for Compose project ${state.composeProject}. ${recovery}`,
      EXIT.liveFailure,
      { providerCallsMayHaveOccurred }
    );
  }
  if (runFailure !== undefined) {
    if (runFailure instanceof DogfoodError) {
      runFailure.providerCallsMayHaveOccurred ||= providerCallsMayHaveOccurred;
    }
    throw runFailure;
  }
  return report;
};

const safeError = (error) => {
  if (error instanceof DogfoodError) {
    return error;
  }
  return new DogfoodError(
    "unexpected-error",
    "The B2B dogfood command failed unexpectedly.",
    EXIT.internal
  );
};

const main = async () => {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.command === "help") {
      process.stdout.write(HELP);
      return;
    }
    const checked = await preflight();
    if (parsed.command === "preflight") {
      process.stdout.write(`${JSON.stringify(checked.report)}\n`);
      return;
    }
    const report = await runDogfood(parsed, checked);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const safe = safeError(error);
    process.stderr.write(
      `${JSON.stringify({
        code: safe.code,
        message: safe.message,
        provider_calls_may_have_occurred: safe.providerCallsMayHaveOccurred,
        status: "error",
      })}\n`
    );
    process.exitCode = safe.exitCode;
  }
};

export const dogfoodTestHelpers =
  process.env.KUROBARA_DOGFOOD_ENABLE_TEST_HELPERS === "1"
    ? Object.freeze({
        composeRuntimeEnvironments,
        createRunState,
        installInterruptGuard,
        parseArguments,
        processGroupExists,
        runCommand,
        startService,
        stopService,
      })
    : undefined;

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  await main();
}
