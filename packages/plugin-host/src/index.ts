import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  definePluginAdapter,
  PLUGIN_PROTOCOL_API_VERSION,
  PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES,
  type PluginAdapterV1,
  type PluginClassifyErrorRequest,
  type PluginClassifyErrorResult,
  type PluginDescribeResult,
  type PluginEstimateRequest,
  type PluginEstimateResult,
  type PluginExecuteRequest,
  type PluginExecuteResult,
  type PluginHealthRequest,
  type PluginHealthResult,
  type PluginJsonValue,
  type PluginLookupRequest,
  type PluginLookupResult,
  type PluginManifestV1,
  type PluginNormalizeRequest,
  type PluginNormalizeResult,
  type PluginProtocolMethod,
  type PluginProtocolRequest,
  type PluginProtocolResult,
  type PluginValidateConfigRequest,
  type PluginValidateConfigResult,
  validatePluginJson,
  validatePluginManifest,
  validatePluginProtocolMessage,
  validatePluginSidecarJsonRpcFrame,
} from "@kurobara/plugin-sdk";

import { parseStrictJson } from "./strict-json.ts";

const DEFAULT_CALL_TIMEOUT_MS = 5000;
const MAX_CALL_TIMEOUT_MS = 300_000;
const MIN_CALL_TIMEOUT_MS = 100;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_UTF16_LENGTH = 4096;
const STDERR_MAX_BYTES = 16_384;
const TERMINATE_GRACE_MS = 100;
const KILL_WAIT_MS = 1000;
const MAX_CALL_ID = 9_999_999_999_999_999n;

export const PLUGIN_HOST_ERROR_REASON_CODES = [
  "plugin-host-options-invalid",
  "plugin-host-admission-rejected",
  "plugin-host-spawn-failed",
  "plugin-host-describe-mismatch",
  "plugin-host-busy",
  "plugin-host-closed",
  "plugin-host-deadline-exceeded",
  "plugin-host-quote-expired",
  "plugin-host-frame-invalid",
  "plugin-host-frame-limit-exceeded",
  "plugin-host-process-exited",
  "plugin-host-timeout",
] as const;

export type PluginHostErrorReasonCode =
  (typeof PLUGIN_HOST_ERROR_REASON_CODES)[number];

export class PluginHostError extends Error {
  readonly method?: PluginProtocolMethod;
  readonly reasonCode: PluginHostErrorReasonCode;

  constructor(
    reasonCode: PluginHostErrorReasonCode,
    method?: PluginProtocolMethod
  ) {
    super(`Development plugin host rejected the operation: ${reasonCode}.`);
    this.name = "PluginHostError";
    this.reasonCode = reasonCode;
    this.method = method;
  }
}

export interface DevelopmentPluginHostOptions {
  readonly arguments?: readonly string[];
  readonly callTimeoutMs?: number;
  readonly executablePath: string;
  readonly expectedManifest: unknown;
  readonly workingDirectory: string;
}

export interface DevelopmentPluginHost {
  call<Method extends PluginProtocolMethod>(
    method: Method,
    payload: PluginProtocolRequest<Method>
  ): Promise<PluginProtocolResult<Method>>;

  close(): Promise<void>;
  readonly manifest: PluginManifestV1;
}

interface ValidatedHostOptions {
  readonly arguments: readonly string[];
  readonly callTimeoutMs: number;
  readonly executablePath: string;
  readonly expectedManifest: PluginManifestV1;
  readonly workingDirectory: string;
}

interface PendingInvocation {
  readonly limits: InvocationLimits;
  readonly method: Exclude<PluginProtocolMethod, "describe">;
}

interface InvocationLimits {
  readonly callExpiresAtMs: number;
  readonly deadlineAtMs?: number;
  readonly quoteExpiresAtMs?: number;
}

type NonDescribeMethod = Exclude<PluginProtocolMethod, "describe">;
type NonDescribeRequest =
  | PluginClassifyErrorRequest
  | PluginEstimateRequest
  | PluginExecuteRequest
  | PluginHealthRequest
  | PluginLookupRequest
  | PluginNormalizeRequest
  | PluginValidateConfigRequest;

interface ActiveChildRun<Result> {
  readonly preDispatchError?: PluginHostError;
  readonly result: Promise<Result>;
  terminate(): Promise<void>;
}

type JsonObject = Readonly<{ [key: string]: PluginJsonValue }>;

const isJsonObject = (value: PluginJsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyBoundedString = (
  value: PluginJsonValue | undefined
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ARGUMENT_UTF16_LENGTH &&
  !value.includes("\u0000");

const validateArguments = (
  candidate: PluginJsonValue | undefined
): readonly string[] | undefined => {
  if (candidate === undefined) {
    return [];
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_ARGUMENTS) {
    return;
  }
  const arguments_: string[] = [];
  for (const argument of candidate) {
    if (
      typeof argument !== "string" ||
      argument.length > MAX_ARGUMENT_UTF16_LENGTH ||
      argument.includes("\u0000")
    ) {
      return;
    }
    arguments_.push(argument);
  }
  return Object.freeze(arguments_);
};

const validatedTimeout = (
  candidate: PluginJsonValue | undefined
): number | undefined => {
  if (candidate === undefined) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= MIN_CALL_TIMEOUT_MS &&
    candidate <= MAX_CALL_TIMEOUT_MS
    ? candidate
    : undefined;
};

const validateFilesystemTargets = async (
  executablePath: string,
  workingDirectory: string
): Promise<void> => {
  try {
    const [executable, directory] = await Promise.all([
      stat(executablePath),
      stat(workingDirectory),
      access(executablePath, fsConstants.X_OK),
    ]);
    if (!(executable.isFile() && directory.isDirectory())) {
      throw new PluginHostError("plugin-host-options-invalid");
    }
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw error;
    }
    throw new PluginHostError("plugin-host-options-invalid");
  }
};

const validateHostOptions = async (
  candidate: unknown
): Promise<ValidatedHostOptions> => {
  const snapshot = validatePluginJson(candidate);
  if (!snapshot.ok) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  if (!isJsonObject(snapshot.value)) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  const options = snapshot.value;
  const requiredKeys = [
    "executablePath",
    "expectedManifest",
    "workingDirectory",
  ];
  const allowedKeys = [...requiredKeys, "arguments", "callTimeoutMs"];
  const hasRequiredKeys = requiredKeys.every((key) =>
    Object.hasOwn(options, key)
  );
  const hasOnlyAllowedKeys = Object.keys(options).every((key) =>
    allowedKeys.includes(key)
  );
  if (!(hasRequiredKeys && hasOnlyAllowedKeys)) {
    throw new PluginHostError("plugin-host-options-invalid");
  }

  const executablePath = options.executablePath;
  const workingDirectory = options.workingDirectory;
  const arguments_ = validateArguments(options.arguments);
  const callTimeoutMs = validatedTimeout(options.callTimeoutMs);
  if (!nonEmptyBoundedString(executablePath)) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  if (!nonEmptyBoundedString(workingDirectory)) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  if (!(isAbsolute(executablePath) && isAbsolute(workingDirectory))) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  if (arguments_ === undefined) {
    throw new PluginHostError("plugin-host-options-invalid");
  }
  if (callTimeoutMs === undefined) {
    throw new PluginHostError("plugin-host-options-invalid");
  }

  const manifest = validatePluginManifest(options.expectedManifest);
  if (!manifest.ok) {
    throw new PluginHostError("plugin-host-admission-rejected");
  }
  if (
    manifest.manifest.auth.modes.length !== 1 ||
    manifest.manifest.auth.modes[0] !== "none" ||
    manifest.manifest.permissions.egress.hosts.length !== 0
  ) {
    throw new PluginHostError("plugin-host-admission-rejected");
  }

  await validateFilesystemTargets(executablePath, workingDirectory);
  return Object.freeze({
    arguments: arguments_,
    callTimeoutMs,
    executablePath,
    expectedManifest: manifest.manifest,
    workingDirectory,
  });
};

const frameError = (
  reasonCode: "plugin-host-frame-invalid" | "plugin-host-frame-limit-exceeded",
  method: PluginProtocolMethod
): PluginHostError => new PluginHostError(reasonCode, method);

const parseResponseFrame = <Method extends PluginProtocolMethod>(
  bytes: Buffer,
  id: string,
  method: Method
): PluginProtocolResult<Method> => {
  if (
    bytes.length < 2 ||
    bytes.length > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 1 ||
    bytes.at(-1) !== 0x0a
  ) {
    throw frameError(
      bytes.length > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 1
        ? "plugin-host-frame-limit-exceeded"
        : "plugin-host-frame-invalid",
      method
    );
  }
  const body = bytes.subarray(0, -1);
  if (
    body.length === 0 ||
    body.length > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES ||
    body.includes(0x0a) ||
    body.includes(0x0d) ||
    (body.length >= 3 &&
      body[0] === 0xef &&
      body[1] === 0xbb &&
      body[2] === 0xbf)
  ) {
    throw frameError(
      body.length > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES
        ? "plugin-host-frame-limit-exceeded"
        : "plugin-host-frame-invalid",
      method
    );
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const strictJson = parseStrictJson(text);
    if (!strictJson.ok) {
      throw frameError("plugin-host-frame-invalid", method);
    }
    parsed = strictJson.value;
  } catch {
    throw frameError("plugin-host-frame-invalid", method);
  }
  const frame = validatePluginSidecarJsonRpcFrame(parsed);
  if (!frame.ok) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  if (!("result" in frame.frame)) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  if (frame.frame.id !== id) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  const message = validatePluginProtocolMessage(frame.frame.result);
  if (!message.ok) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  if (
    !(
      message.message.direction === "result" &&
      message.message.method === method
    )
  ) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  return message.message.payload as PluginProtocolResult<Method>;
};

const requestFrame = <Method extends PluginProtocolMethod>(
  id: string,
  method: Method,
  payload: PluginProtocolRequest<Method>
): Buffer => {
  const message = validatePluginProtocolMessage({
    apiVersion: PLUGIN_PROTOCOL_API_VERSION,
    direction: "request",
    method,
    payload,
  });
  if (!message.ok) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  if (
    !(
      message.message.direction === "request" &&
      message.message.method === method
    )
  ) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  const frame = validatePluginSidecarJsonRpcFrame({
    id,
    jsonrpc: "2.0",
    method: `plugin.${method}`,
    params: message.message,
  });
  if (!frame.ok) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  if (!("params" in frame.frame)) {
    throw frameError("plugin-host-frame-invalid", method);
  }
  const serialized = Buffer.from(`${JSON.stringify(frame.frame)}\n`, "utf8");
  if (serialized.length > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 1) {
    throw frameError("plugin-host-frame-limit-exceeded", method);
  }
  return serialized;
};

const invocationLimits = (
  timeoutMs: number,
  now: number,
  deadlineAtMs?: number,
  quoteExpiresAtMs?: number
): InvocationLimits =>
  Object.freeze({
    callExpiresAtMs: now + timeoutMs,
    deadlineAtMs,
    quoteExpiresAtMs,
  });

const preDispatchTimingError = (
  limits: InvocationLimits,
  method: PluginProtocolMethod,
  now: number
): PluginHostError | undefined => {
  if (limits.deadlineAtMs !== undefined && limits.deadlineAtMs - now - 1 <= 0) {
    return new PluginHostError("plugin-host-deadline-exceeded", method);
  }
  if (limits.quoteExpiresAtMs !== undefined && limits.quoteExpiresAtMs <= now) {
    return new PluginHostError("plugin-host-quote-expired", method);
  }
  if (limits.callExpiresAtMs <= now) {
    return new PluginHostError("plugin-host-timeout", method);
  }
};

interface InvocationTimer {
  readonly delayMs: number;
  readonly error: PluginHostError;
}

const invocationTimer = (
  limits: InvocationLimits,
  method: PluginProtocolMethod,
  now: number
): InvocationTimer => {
  const deadlineTimerAtMs =
    limits.deadlineAtMs === undefined
      ? Number.POSITIVE_INFINITY
      : limits.deadlineAtMs - 1;
  if (deadlineTimerAtMs <= limits.callExpiresAtMs) {
    return {
      delayMs: Math.max(1, deadlineTimerAtMs - now),
      error: new PluginHostError("plugin-host-deadline-exceeded", method),
    };
  }
  return {
    delayMs: Math.max(1, limits.callExpiresAtMs - now),
    error: new PluginHostError("plugin-host-timeout", method),
  };
};

const completionTimingError = (
  limits: InvocationLimits,
  method: PluginProtocolMethod,
  now: number
): PluginHostError | undefined => {
  if (limits.deadlineAtMs !== undefined && limits.deadlineAtMs <= now) {
    return new PluginHostError("plugin-host-deadline-exceeded", method);
  }
  if (limits.callExpiresAtMs <= now) {
    return new PluginHostError("plugin-host-timeout", method);
  }
};

const createChildRun = <Method extends PluginProtocolMethod>(
  options: ValidatedHostOptions,
  id: string,
  method: Method,
  payload: PluginProtocolRequest<Method>,
  limits: InvocationLimits
): ActiveChildRun<PluginProtocolResult<Method>> => {
  const outbound = requestFrame(id, method, payload);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executablePath, options.arguments, {
      cwd: options.workingDirectory,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new PluginHostError("plugin-host-spawn-failed", method);
  }

  let closed = false;
  let settled = false;
  let stderrBytes = 0;
  let stdoutBytes = 0;
  const stdoutChunks: Buffer[] = [];
  let failure: PluginHostError | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let finalTimer: NodeJS.Timeout | undefined;
  let callTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (reason: PluginHostError) => void;
  let resolveTerminated!: () => void;
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });

  const cleanupTimers = (): void => {
    if (callTimer) {
      clearTimeout(callTimer);
    }
    if (killTimer) {
      clearTimeout(killTimer);
    }
    if (finalTimer) {
      clearTimeout(finalTimer);
    }
  };

  const settleFailure = (error: PluginHostError): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupTimers();
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    rejectResult(error);
    resolveTerminated();
  };

  const settleFromClose = (exitCode: number | null): void => {
    if (settled) {
      return;
    }
    if (failure) {
      settleFailure(failure);
      return;
    }
    if (exitCode !== 0) {
      settleFailure(new PluginHostError("plugin-host-process-exited", method));
      return;
    }
    const timingError = completionTimingError(limits, method, Date.now());
    if (timingError) {
      settleFailure(timingError);
      return;
    }
    try {
      const result = parseResponseFrame(
        Buffer.concat(stdoutChunks, stdoutBytes),
        id,
        method
      );
      settled = true;
      cleanupTimers();
      resolveResult(result);
      resolveTerminated();
    } catch (error) {
      settleFailure(
        error instanceof PluginHostError
          ? error
          : new PluginHostError("plugin-host-frame-invalid", method)
      );
    }
  };

  const beginTermination = (error: PluginHostError): void => {
    failure ??= error;
    if (closed) {
      settleFailure(failure);
      return;
    }
    child.stdin.destroy();
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, TERMINATE_GRACE_MS);
    finalTimer ??= setTimeout(() => {
      if (!closed) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settleFailure(failure ?? error);
      }
    }, KILL_WAIT_MS);
  };

  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (failure || settled) {
      return;
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes > PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 1) {
      beginTermination(
        new PluginHostError("plugin-host-frame-limit-exceeded", method)
      );
      return;
    }
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (failure || settled) {
      return;
    }
    stderrBytes += chunk.length;
    if (stderrBytes > STDERR_MAX_BYTES) {
      beginTermination(
        new PluginHostError("plugin-host-frame-limit-exceeded", method)
      );
    }
  });
  child.stdin.on("error", () => {
    beginTermination(new PluginHostError("plugin-host-process-exited", method));
  });
  child.on("error", () => {
    beginTermination(new PluginHostError("plugin-host-spawn-failed", method));
  });
  child.on("close", (exitCode) => {
    closed = true;
    settleFromClose(exitCode);
  });

  const dispatchNow = Date.now();
  const dispatchError = preDispatchTimingError(limits, method, dispatchNow);
  if (dispatchError) {
    beginTermination(dispatchError);
  } else {
    const timer = invocationTimer(limits, method, dispatchNow);
    callTimer = setTimeout(() => {
      beginTermination(timer.error);
    }, timer.delayMs);
    child.stdin.end(outbound);
  }

  return {
    preDispatchError: dispatchError,
    result: result as Promise<PluginProtocolResult<Method>>,
    terminate: async () => {
      if (!settled) {
        beginTermination(new PluginHostError("plugin-host-closed", method));
      }
      await terminated;
    },
  };
};

const invokeAdapter = async <Method extends PluginProtocolMethod>(
  adapter: PluginAdapterV1,
  method: Method,
  payload: PluginProtocolRequest<Method>
): Promise<PluginProtocolResult<Method>> => {
  switch (method) {
    case "describe":
      return adapter.describe() as PluginProtocolResult<Method>;
    case "validateConfig":
      return (await adapter.validateConfig(
        payload as PluginValidateConfigRequest
      )) as PluginProtocolResult<Method>;
    case "estimate":
      return (await adapter.estimate(
        payload as PluginEstimateRequest
      )) as PluginProtocolResult<Method>;
    case "execute":
      return (await adapter.execute(
        payload as PluginExecuteRequest
      )) as PluginProtocolResult<Method>;
    case "lookup":
      return (await adapter.lookup(
        payload as PluginLookupRequest
      )) as PluginProtocolResult<Method>;
    case "normalize":
      return (await adapter.normalize(
        payload as PluginNormalizeRequest
      )) as PluginProtocolResult<Method>;
    case "health":
      return (await adapter.health(
        payload as PluginHealthRequest
      )) as PluginProtocolResult<Method>;
    case "classifyError":
      return (await adapter.classifyError(
        payload as PluginClassifyErrorRequest
      )) as PluginProtocolResult<Method>;
    default:
      throw new PluginHostError("plugin-host-frame-invalid");
  }
};

class DevelopmentPluginHostImplementation implements DevelopmentPluginHost {
  readonly manifest: PluginManifestV1;
  readonly #adapter: PluginAdapterV1;
  readonly #options: ValidatedHostOptions;
  #activeRun: ActiveChildRun<unknown> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #inFlight = false;
  #nextCallId: bigint;
  #pendingInvocation: PendingInvocation | undefined;

  constructor(
    options: ValidatedHostOptions,
    manifest: PluginManifestV1,
    nextCallId: bigint
  ) {
    this.#options = options;
    this.manifest = manifest;
    this.#nextCallId = nextCallId;
    this.#adapter = definePluginAdapter({
      classifyError: (request): Promise<PluginClassifyErrorResult> =>
        this.#invokeRemote("classifyError", request),
      describe: (): PluginDescribeResult => ({ manifest: this.manifest }),
      estimate: (request): Promise<PluginEstimateResult> =>
        this.#invokeRemote("estimate", request),
      execute: (request): Promise<PluginExecuteResult> =>
        this.#invokeRemote("execute", request),
      health: (request): Promise<PluginHealthResult> =>
        this.#invokeRemote("health", request),
      lookup: (request): Promise<PluginLookupResult> =>
        this.#invokeRemote("lookup", request),
      normalize: (request): Promise<PluginNormalizeResult> =>
        this.#invokeRemote("normalize", request),
      validateConfig: (request): Promise<PluginValidateConfigResult> =>
        this.#invokeRemote("validateConfig", request),
    });
  }

  async call<Method extends PluginProtocolMethod>(
    method: Method,
    payload: PluginProtocolRequest<Method>
  ): Promise<PluginProtocolResult<Method>> {
    if (this.#closed) {
      throw new PluginHostError("plugin-host-closed", method);
    }
    if (this.#inFlight) {
      throw new PluginHostError("plugin-host-busy", method);
    }

    const accepted = validatePluginProtocolMessage({
      apiVersion: PLUGIN_PROTOCOL_API_VERSION,
      direction: "request",
      method,
      payload,
    });
    if (!accepted.ok) {
      throw new PluginHostError("plugin-host-frame-invalid", method);
    }
    if (
      !(
        accepted.message.direction === "request" &&
        accepted.message.method === method
      )
    ) {
      throw new PluginHostError("plugin-host-frame-invalid", method);
    }
    if (method === "describe") {
      return this.#adapter.describe() as PluginProtocolResult<Method>;
    }

    const limits = this.#preflight(
      method as NonDescribeMethod,
      accepted.message.payload as NonDescribeRequest
    );
    this.#inFlight = true;
    this.#pendingInvocation = {
      limits,
      method,
    } as PendingInvocation;
    try {
      let result: PluginProtocolResult<Method>;
      try {
        result = await invokeAdapter(
          this.#adapter,
          method,
          accepted.message.payload as PluginProtocolRequest<Method>
        );
      } catch (error) {
        throw this.#activeRun?.preDispatchError ?? error;
      }
      const preDispatchError = this.#activeRun?.preDispatchError;
      if (preDispatchError) {
        throw preDispatchError;
      }
      return result;
    } finally {
      this.#activeRun = undefined;
      this.#pendingInvocation = undefined;
      this.#inFlight = false;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#activeRun?.terminate() ?? Promise.resolve();
    return this.#closePromise;
  }

  #callId(operationKey?: string): string {
    if (this.#nextCallId > MAX_CALL_ID) {
      throw new PluginHostError("plugin-host-frame-limit-exceeded");
    }
    let id = `host-call-${this.#nextCallId}`;
    this.#nextCallId += 1n;
    if (id === operationKey) {
      if (this.#nextCallId > MAX_CALL_ID) {
        throw new PluginHostError("plugin-host-frame-limit-exceeded");
      }
      id = `host-call-${this.#nextCallId}`;
      this.#nextCallId += 1n;
    }
    return id;
  }

  #invokeRemote<Method extends Exclude<PluginProtocolMethod, "describe">>(
    method: Method,
    payload: PluginProtocolRequest<Method>
  ): Promise<PluginProtocolResult<Method>> {
    const pending = this.#pendingInvocation;
    if (!pending || pending.method !== method) {
      throw new PluginHostError("plugin-host-closed", method);
    }
    const operationKey =
      method === "execute" || method === "lookup"
        ? (payload as PluginExecuteRequest | PluginLookupRequest).operationKey
        : undefined;
    const run = createChildRun(
      this.#options,
      this.#callId(operationKey),
      method,
      payload,
      pending.limits
    );
    this.#activeRun = run as ActiveChildRun<unknown>;
    return run.result;
  }

  #preflight(
    method: NonDescribeMethod,
    payload: NonDescribeRequest
  ): InvocationLimits {
    const now = Date.now();
    let timeoutMs = this.#options.callTimeoutMs;
    if (method === "validateConfig") {
      return invocationLimits(timeoutMs, now);
    }

    const request = payload as Exclude<
      NonDescribeRequest,
      PluginValidateConfigRequest
    >;
    const remainingMs = request.context.deadlineAtMs - now - 1;
    if (remainingMs <= 0) {
      throw new PluginHostError("plugin-host-deadline-exceeded", method);
    }
    let quoteExpiresAtMs: number | undefined;
    if (method === "execute") {
      const execute = request as PluginExecuteRequest;
      if (execute.quote.expiresAtMs <= now) {
        throw new PluginHostError("plugin-host-quote-expired", method);
      }
      quoteExpiresAtMs = execute.quote.expiresAtMs;
      timeoutMs = Math.min(
        timeoutMs,
        this.manifest.execution.timeouts.executeMs
      );
    } else if (method === "lookup") {
      timeoutMs = Math.min(
        timeoutMs,
        this.manifest.execution.timeouts.lookupMs
      );
    }
    return invocationLimits(
      timeoutMs,
      now,
      request.context.deadlineAtMs,
      quoteExpiresAtMs
    );
  }
}

// biome-ignore lint/style/useUnifiedTypeSignatures: Retain a discoverable typed overload while validating unknown runtime input.
export function startDevelopmentPluginHost(
  options: DevelopmentPluginHostOptions
): Promise<DevelopmentPluginHost>;
export function startDevelopmentPluginHost(
  options: unknown
): Promise<DevelopmentPluginHost>;
export async function startDevelopmentPluginHost(
  options: unknown
): Promise<DevelopmentPluginHost> {
  const validated = await validateHostOptions(options);
  const describeRun = createChildRun(
    validated,
    "host-call-1",
    "describe",
    {},
    invocationLimits(validated.callTimeoutMs, Date.now())
  );
  let described: PluginDescribeResult;
  try {
    described = await describeRun.result;
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw error;
    }
    throw new PluginHostError("plugin-host-spawn-failed", "describe");
  }
  const manifest = validatePluginManifest(described.manifest);
  if (!manifest.ok) {
    throw new PluginHostError("plugin-host-describe-mismatch", "describe");
  }
  if (!isDeepStrictEqual(manifest.manifest, validated.expectedManifest)) {
    throw new PluginHostError("plugin-host-describe-mismatch", "describe");
  }
  return new DevelopmentPluginHostImplementation(
    validated,
    manifest.manifest,
    2n
  );
}
