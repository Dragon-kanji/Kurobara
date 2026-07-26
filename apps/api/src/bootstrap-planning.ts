import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  createPostgresRuntime,
  DatabasePayloadError,
  ImmutableRecordConflictError,
  type PlanningBundleManifest,
  PlanningDefaultsConflictError,
  type PostgresRuntime,
  parsePlanningBundleManifest,
} from "@kurobara/adapter-postgres";
import { validatePlanningBundle } from "@kurobara/application";
import { type ParseError, parse, visit } from "jsonc-parser";

import { ApiConfigError, parseApiDatabaseUrl } from "./config.ts";

const MAX_MANIFEST_BYTES = 1_048_576;

type PlanningOperatorMode = "apply" | "check" | "read";

type PlanningOperatorArguments =
  | Readonly<{ file: string; mode: "apply" | "check" }>
  | Readonly<{ mode: "read"; workspaceId: string }>;

type LoadedPlanningManifest = Readonly<{
  manifest: PlanningBundleManifest;
  sourceSha256: string;
}>;

type MutationState =
  | "applied-unverified"
  | "applied-verified"
  | "not-started"
  | "rolled-back"
  | "unknown";

export class PlanningOperatorError extends Error {
  readonly code: string;
  readonly mutationState: MutationState;

  constructor(code: string, message: string, mutationState: MutationState) {
    super(message);
    this.code = code;
    this.mutationState = mutationState;
    this.name = "PlanningOperatorError";
  }
}

const usageError = (): PlanningOperatorError =>
  new PlanningOperatorError(
    "usage-invalid",
    "Use --check/--apply with --file <path>, or --read with --workspace <id>.",
    "not-started"
  );

const modeForArgument = (
  argument: string
): PlanningOperatorMode | undefined => {
  if (argument === "--apply") {
    return "apply";
  }
  if (argument === "--check") {
    return "check";
  }
  if (argument === "--read") {
    return "read";
  }
};

const VALUE_ARGUMENTS = new Set(["--file", "--workspace"]);

export const parsePlanningOperatorArguments = (
  args: readonly string[]
): PlanningOperatorArguments => {
  let mode: PlanningOperatorMode | undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const parsedMode = modeForArgument(argument ?? "");
    if (parsedMode !== undefined) {
      if (mode !== undefined) {
        throw usageError();
      }
      mode = parsedMode;
      continue;
    }
    if (argument !== undefined && VALUE_ARGUMENTS.has(argument)) {
      const value = args[index + 1];
      if (values.has(argument) || value === undefined || value.length === 0) {
        throw usageError();
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw usageError();
  }
  const file = values.get("--file");
  const workspaceId = values.get("--workspace");
  if (mode === "read" && workspaceId !== undefined && file === undefined) {
    return { mode, workspaceId };
  }
  if (
    (mode === "apply" || mode === "check") &&
    file !== undefined &&
    workspaceId === undefined
  ) {
    return { file, mode };
  }
  if (mode === undefined) {
    throw usageError();
  }
  throw usageError();
};

const stringIsIJson = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return false;
    }
  }
  return true;
};

const isIJson = (value: unknown): boolean => {
  if (typeof value === "string") {
    return stringIsIJson(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isIJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).every(
      ([key, item]) => stringIsIJson(key) && isIJson(item)
    );
  }
  return value === null || typeof value === "boolean";
};

const parseStrictJson = (text: string): unknown => {
  if (text.charCodeAt(0) === 0xfe_ff) {
    throw new PlanningOperatorError(
      "json-invalid",
      "The planning manifest must not contain a byte-order mark.",
      "not-started"
    );
  }
  const objectProperties: Set<string>[] = [];
  let duplicateKey = false;
  let prototypeKey = false;
  const errors: ParseError[] = [];
  visit(
    text,
    {
      onError: () => {
        // Syntax diagnostics are collected by the strict parse below.
      },
      onObjectBegin: () => {
        objectProperties.push(new Set());
      },
      onObjectEnd: () => {
        objectProperties.pop();
      },
      onObjectProperty: (property) => {
        if (property === "__proto__") {
          prototypeKey = true;
        }
        const properties = objectProperties.at(-1);
        if (properties?.has(property) === true) {
          duplicateKey = true;
        }
        properties?.add(property);
      },
    },
    { allowTrailingComma: false, disallowComments: true }
  );
  if (duplicateKey) {
    throw new PlanningOperatorError(
      "duplicate-key",
      "The planning manifest must not contain duplicate object keys.",
      "not-started"
    );
  }
  if (prototypeKey) {
    throw new PlanningOperatorError(
      "json-invalid",
      "The planning manifest must not contain prototype-mutating keys.",
      "not-started"
    );
  }
  const value: unknown = parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  }) as unknown;
  if (errors.length > 0) {
    throw new PlanningOperatorError(
      "json-invalid",
      "The planning manifest must contain strict JSON.",
      "not-started"
    );
  }
  if (!isIJson(value)) {
    throw new PlanningOperatorError(
      "json-invalid",
      "The planning manifest must conform to I-JSON string and number limits.",
      "not-started"
    );
  }
  return value;
};

const readBoundedFile = async (handle: FileHandle): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total
    );
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  return buffer.subarray(0, total);
};

export const loadPlanningManifest = async (
  file: string
): Promise<LoadedPlanningManifest> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: Node file flags are a bitmask by contract.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new PlanningOperatorError(
      "file-unsafe",
      "The planning manifest could not be opened as a regular non-symlink file.",
      "not-started"
    );
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_MANIFEST_BYTES ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a mask.
      (metadata.mode & 0o022) !== 0
    ) {
      throw new PlanningOperatorError(
        "file-unsafe",
        "The planning manifest must be a non-empty regular file of at most 1 MiB and not group/world writable.",
        "not-started"
      );
    }
    const bytes = await readBoundedFile(handle);
    if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
      throw new PlanningOperatorError(
        "file-too-large",
        "The planning manifest must contain between 1 byte and 1 MiB.",
        "not-started"
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PlanningOperatorError(
        "utf8-invalid",
        "The planning manifest must be valid UTF-8.",
        "not-started"
      );
    }
    const parsed = parseStrictJson(text);
    let manifest: PlanningBundleManifest;
    try {
      manifest = parsePlanningBundleManifest(parsed);
    } catch (error) {
      if (error instanceof DatabasePayloadError) {
        throw new PlanningOperatorError(
          "manifest-invalid",
          "The planning manifest does not match the supported format.",
          "not-started"
        );
      }
      throw error;
    }
    return {
      manifest,
      sourceSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally {
    await handle.close();
  }
};

const verifyPlanningReadback = async (
  runtime: PostgresRuntime,
  manifest: PlanningBundleManifest,
  expectedDefaultsRevision: number
): Promise<void> => {
  const verified = await runtime.verifyPlanningBundle(
    manifest.planning,
    expectedDefaultsRevision
  );
  if (!verified) {
    throw new PlanningOperatorError(
      "readback-failed",
      "The committed planning bundle did not match its database readback.",
      "applied-unverified"
    );
  }
};

const parseDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>>
): string => {
  try {
    return parseApiDatabaseUrl(environment);
  } catch (error) {
    if (error instanceof ApiConfigError) {
      throw new PlanningOperatorError(
        "config-invalid",
        "KUROBARA_DATABASE_URL must be a valid configured PostgreSQL URL.",
        "not-started"
      );
    }
    throw error;
  }
};

const counts = (manifest: PlanningBundleManifest) => ({
  authorities: manifest.planning.authorities.length,
  policies: manifest.planning.policies.length,
  pricing: manifest.planning.pricing.length,
  workflows: manifest.planning.workflows.length,
});

const runPlanningRead = async (
  command: Extract<PlanningOperatorArguments, { mode: "read" }>,
  environment: Readonly<Record<string, string | undefined>>
): Promise<Readonly<Record<string, unknown>>> => {
  const runtime = createPostgresRuntime(parseDatabaseUrl(environment));
  let operationFailed = false;
  try {
    await runtime.verifyMigrations();
    const readback = await runtime.readPlanningState(command.workspaceId);
    return {
      database_verified: true,
      mutation_state: "not-started",
      operation: "planning.bundle",
      state: readback ?? null,
      status: readback === undefined ? "not-configured" : "available",
      workspace_id: command.workspaceId,
    };
  } catch (error) {
    operationFailed = true;
    if (error instanceof PlanningOperatorError) {
      throw error;
    }
    throw new PlanningOperatorError(
      "read-failed",
      "The planning state could not be read from the configured database.",
      "not-started"
    );
  } finally {
    await runtime.close().catch(() => {
      if (!operationFailed) {
        throw new PlanningOperatorError(
          "database-close-failed",
          "The planning database connection could not be closed cleanly.",
          "not-started"
        );
      }
    });
  }
};

const runPlanningManifestCommand = async (
  command: Extract<PlanningOperatorArguments, { file: string }>,
  environment: Readonly<Record<string, string | undefined>>
): Promise<Readonly<Record<string, unknown>>> => {
  const loaded = await loadPlanningManifest(command.file);
  const validation = validatePlanningBundle(loaded.manifest.planning);
  if (!validation.ok) {
    throw new PlanningOperatorError(
      "manifest-invalid",
      "The planning manifest contains a workflow that cannot be compiled.",
      "not-started"
    );
  }
  if (command.mode === "check") {
    return {
      counts: counts(loaded.manifest),
      database_verified: false,
      operation: "planning.bundle",
      source_sha256: loaded.sourceSha256,
      status: "valid",
      workspace_id: loaded.manifest.planning.workspaceId,
    };
  }

  const runtime = createPostgresRuntime(parseDatabaseUrl(environment));
  let closeMutationState: MutationState = "not-started";
  let operationFailed = false;
  try {
    await runtime.migrate();
    let applied: Awaited<ReturnType<PostgresRuntime["bootstrapPlanning"]>>;
    try {
      applied = await runtime.bootstrapPlanning(loaded.manifest.planning);
    } catch (error) {
      if (error instanceof ImmutableRecordConflictError) {
        throw new PlanningOperatorError(
          "immutable-record-conflict",
          "The planning bundle conflicts with an immutable stored snapshot.",
          "rolled-back"
        );
      }
      if (error instanceof PlanningDefaultsConflictError) {
        throw new PlanningOperatorError(
          "planning-defaults-conflict",
          "The planning defaults changed since the operator read them.",
          "rolled-back"
        );
      }
      throw error;
    }
    closeMutationState = "applied-unverified";
    await verifyPlanningReadback(
      runtime,
      loaded.manifest,
      applied.defaults.current.revision
    );
    closeMutationState = "applied-verified";
    return {
      apply: applied,
      mutation_state: "applied-verified",
      operation: "planning.bundle",
      source_sha256: loaded.sourceSha256,
      status: applied.status,
      workspace_id: applied.workspaceId,
    };
  } catch (error) {
    operationFailed = true;
    if (error instanceof PlanningOperatorError) {
      throw error;
    }
    throw new PlanningOperatorError(
      "apply-failed",
      "The planning bundle apply failed; inspect the database before retrying.",
      "unknown"
    );
  } finally {
    await runtime.close().catch(() => {
      if (!operationFailed) {
        throw new PlanningOperatorError(
          "database-close-failed",
          "The planning database connection could not be closed cleanly.",
          closeMutationState
        );
      }
    });
  }
};

export const runPlanningOperator = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): Promise<Readonly<Record<string, unknown>>> => {
  const command = parsePlanningOperatorArguments(args);
  return command.mode === "read"
    ? runPlanningRead(command, environment)
    : runPlanningManifestCommand(command, environment);
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runPlanningOperator(process.argv.slice(2), process.env)
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error: unknown) => {
      const safeError =
        error instanceof PlanningOperatorError
          ? error
          : new PlanningOperatorError(
              "operator-failed",
              "The planning operator failed.",
              "unknown"
            );
      console.error(
        JSON.stringify({
          code: safeError.code,
          message: safeError.message,
          mutation_state: safeError.mutationState,
          operation: "planning.bundle",
          status: "error",
        })
      );
      process.exitCode = safeError.code === "usage-invalid" ? 2 : 4;
    });
}
