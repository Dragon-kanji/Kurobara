import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import onboardingContract from "@kurobara/contracts/cli-onboarding.json" with {
  type: "json",
};

import packageManifest from "../../../package.json" with { type: "json" };
import {
  applySetupPlan,
  createSetupPlan,
  documentFingerprint,
  type Environment,
  type KurobaraConfiguration,
  migrateConfiguration,
  ONBOARDING_SCHEMA_VERSION,
  OnboardingConfigError,
  onboardingPaths,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  readConfiguration,
  readPlanFile,
  readSetupState,
  SecretStore,
  writePlanFile,
} from "./onboarding-config.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3000";
const MAX_INPUT_BYTES = 16_384;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PINK = "\u001b[38;5;198m";
const WHITE = "\u001b[97m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const LINE_BREAK_PATTERN = /\r?\n/u;
const TRAILING_NEWLINE_PATTERN = /\r?\n$/u;

export type OnboardingWritable = Readonly<{
  isTTY?: boolean;
  write: (chunk: string | Uint8Array) => unknown;
}>;

export type OnboardingReadable = AsyncIterable<unknown> &
  Readonly<{
    isTTY?: boolean;
    off?: (event: "data", listener: (chunk: unknown) => void) => unknown;
    on?: (event: "data", listener: (chunk: unknown) => void) => unknown;
    pause?: () => unknown;
    resume?: () => unknown;
    setRawMode?: (mode: boolean) => unknown;
  }>;

export type ProcessRequest = Readonly<{
  args: readonly string[];
  command: string;
  cwd?: string;
  environment: Environment;
  inheritOutput?: boolean;
}>;

export type ProcessResult = Readonly<{
  code: number;
  stderr: string;
  stdout: string;
}>;

export type OnboardingInvocation = Readonly<{
  argv: readonly string[];
  environment: Environment;
  fetch?: typeof fetch;
  processRunner?: (request: ProcessRequest) => Promise<ProcessResult>;
  signal?: AbortSignal;
  stderr: OnboardingWritable;
  stdin: OnboardingReadable;
  stdout: OnboardingWritable;
  wait?: (milliseconds: number) => Promise<void>;
}>;

type NextAction = Readonly<{
  argv: readonly string[];
  destructive: boolean;
  id: string;
  label: string;
  requires_confirmation: boolean;
}>;

type MachineResult = Readonly<{
  blocked_steps: readonly string[];
  command: string;
  completed_steps: readonly string[];
  next_actions: readonly NextAction[];
  ok: true;
  requires_confirmation: boolean;
  schema_version: typeof ONBOARDING_SCHEMA_VERSION;
  warnings: readonly string[];
}> &
  Readonly<Record<string, unknown>>;

type MachineProblem = Readonly<{
  blocked_steps: readonly string[];
  command: string;
  completed_steps: readonly string[];
  next_actions: readonly NextAction[];
  ok: false;
  problem: Readonly<{
    code: string;
    retryable: boolean;
    status: 0;
    title: string;
    type: "about:blank";
  }>;
  requires_confirmation: boolean;
  schema_version: typeof ONBOARDING_SCHEMA_VERSION;
  warnings: readonly string[];
}>;

class OnboardingCliError extends Error {
  readonly blockedSteps: readonly string[];
  readonly code: string;
  readonly exitCode: number;
  readonly nextActions: readonly NextAction[];
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    exitCode: number,
    nextActions: readonly NextAction[] = [],
    retryable = false,
    blockedSteps: readonly string[] = [code]
  ) {
    super(message);
    this.blockedSteps = blockedSteps;
    this.code = code;
    this.exitCode = exitCode;
    this.name = "OnboardingCliError";
    this.nextActions = nextActions;
    this.retryable = retryable;
  }
}

type Presentation = Readonly<{
  color: boolean;
  machine: boolean;
  motion: boolean;
  nonInteractive: boolean;
}>;

const action = (
  id: string,
  label: string,
  argv: readonly string[],
  requiresConfirmation = false,
  destructive = false
): NextAction =>
  Object.freeze({
    argv: Object.freeze([...argv]),
    destructive,
    id,
    label,
    requires_confirmation: requiresConfirmation,
  });

const success = (
  command: string,
  fields: Readonly<Record<string, unknown>> = {}
): MachineResult => ({
  blocked_steps: [],
  command,
  completed_steps: [],
  next_actions: [],
  ok: true,
  requires_confirmation: false,
  schema_version: ONBOARDING_SCHEMA_VERSION,
  warnings: [],
  ...fields,
});

const writeJson = (target: OnboardingWritable, value: unknown): void => {
  target.write(`${JSON.stringify(value)}\n`);
};

const writeLine = (target: OnboardingWritable, value = ""): void => {
  target.write(`${value}\n`);
};

const globalPresentation = (
  argv: readonly string[],
  invocation: OnboardingInvocation
): Readonly<{ argv: readonly string[]; presentation: Presentation }> => {
  const machine = argv.includes("--json");
  const nonInteractive = argv.includes("--non-interactive");
  const noColor =
    argv.includes("--no-color") ||
    invocation.environment.NO_COLOR !== undefined ||
    invocation.environment.TERM === "dumb";
  const noMotion =
    argv.includes("--no-motion") ||
    machine ||
    nonInteractive ||
    invocation.environment.CI !== undefined ||
    invocation.environment.TERM === "dumb";
  return {
    argv: argv.filter(
      (argument) =>
        argument !== "--json" &&
        argument !== "--non-interactive" &&
        argument !== "--no-color" &&
        argument !== "--no-motion"
    ),
    presentation: {
      color: !noColor && invocation.stdout.isTTY === true,
      machine,
      motion: !noMotion && invocation.stdout.isTTY === true,
      nonInteractive,
    },
  };
};

const brand = (target: OnboardingWritable, color: boolean): void => {
  const pink = color ? PINK : "";
  const white = color ? WHITE : "";
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  writeLine(target, `${white}KUROBARA${reset} ${pink}◆${reset} CLI SETUP`);
  writeLine(
    target,
    `${dim}──────${reset}${pink}···●····●···${reset}${dim}──────────────${reset}`
  );
};

const renderHumanResult = (
  target: OnboardingWritable,
  result: MachineResult,
  color: boolean
): void => {
  brand(target, color);
  const title =
    typeof result.summary === "string" ? result.summary : result.command;
  writeLine(target, `${color ? PINK : ""}${title}${color ? RESET : ""}`);
  if (
    result.command === "help" &&
    Array.isArray(result.commands) &&
    Array.isArray(result.product_commands)
  ) {
    writeLine(target);
    writeLine(target, "ONBOARD & OPERATE");
    for (const command of result.commands) {
      writeLine(target, `  kurobara ${String(command)}`);
    }
    writeLine(target);
    writeLine(target, "BUILD LISTS");
    for (const command of result.product_commands) {
      writeLine(target, `  kurobara ${String(command)}`);
    }
    writeLine(target);
    writeLine(target, "Add --json for a deterministic machine response.");
  }
  for (const warning of result.warnings) {
    writeLine(target, `! ${warning}`);
  }
  for (const nextAction of result.next_actions) {
    writeLine(target, `→ ${nextAction.argv.join(" ")}`);
  }
};

const parseOptions = (
  argv: readonly string[],
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
  repeatableFlags: ReadonlySet<string> = new Set()
): Readonly<{
  booleans: ReadonlySet<string>;
  repeated: ReadonlyMap<string, readonly string[]>;
  values: ReadonlyMap<string, string>;
}> => {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      break;
    }
    if (booleanFlags.has(argument)) {
      if (booleans.has(argument)) {
        throw new OnboardingCliError(
          "cli-usage-error",
          `Duplicate flag: ${argument}.`,
          2
        );
      }
      booleans.add(argument);
      continue;
    }
    if (!valueFlags.has(argument)) {
      throw new OnboardingCliError(
        "cli-usage-error",
        `Unknown onboarding argument: ${argument}.`,
        2
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OnboardingCliError(
        "cli-usage-error",
        `${argument} requires a value.`,
        2
      );
    }
    index += 1;
    if (repeatableFlags.has(argument)) {
      const selected = repeated.get(argument) ?? [];
      selected.push(value);
      repeated.set(argument, selected);
    } else {
      if (values.has(argument)) {
        throw new OnboardingCliError(
          "cli-usage-error",
          `Duplicate flag: ${argument}.`,
          2
        );
      }
      values.set(argument, value);
    }
  }
  return { booleans, repeated, values };
};

const mapConfigurationError = (
  error: OnboardingConfigError
): OnboardingCliError => {
  const exitCode =
    error.code === "config-incompatible" ||
    error.code === "config-invalid" ||
    error.code === "config-permissions"
      ? 3
      : 69;
  return new OnboardingCliError(error.code, error.message, exitCode, [
    action("inspect", "Inspect local onboarding state", [
      "kurobara",
      "setup",
      "inspect",
      "--json",
    ]),
  ]);
};

const defaultProcessRunner = async (
  request: ProcessRequest
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: { ...process.env, ...request.environment },
      stdio: request.inheritOutput
        ? "inherit"
        : (["ignore", "pipe", "pipe"] as const),
    });
    if (request.inheritOutput) {
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code: code ?? 70, stderr: "", stdout: "" })
      );
      return;
    }
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on("data", (chunk: Uint8Array) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_PROCESS_OUTPUT_BYTES) {
        stdout.push(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_PROCESS_OUTPUT_BYTES) {
        stderr.push(chunk);
      }
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code: code ?? 70,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    );
  });

const readStreamValue = async (
  stream: OnboardingReadable,
  label: string
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    let bytes: Uint8Array | undefined;
    if (typeof chunk === "string") {
      bytes = new TextEncoder().encode(chunk);
    } else if (chunk instanceof Uint8Array) {
      bytes = chunk;
    }
    if (bytes === undefined) {
      throw new OnboardingCliError(
        "cli-input-invalid",
        `${label} yielded invalid bytes.`,
        2
      );
    }
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) {
      throw new OnboardingCliError(
        "cli-input-invalid",
        `${label} is too large.`,
        2
      );
    }
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks)
    .toString("utf8")
    .replace(TRAILING_NEWLINE_PATTERN, "");
  if (value.length === 0 || value.trim() !== value) {
    throw new OnboardingCliError(
      "cli-input-invalid",
      `${label} is empty or contains surrounding whitespace.`,
      2
    );
  }
  return value;
};

const decodeInputChunk = (chunk: unknown): string => {
  if (typeof chunk === "string") {
    return chunk;
  }
  return chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
};

type MaskedInputAction = "abort" | "complete" | "continue";

const handleMaskedCharacter = (
  character: string,
  characters: string[],
  target: OnboardingWritable
): MaskedInputAction => {
  if (character === "\u0003") {
    return "abort";
  }
  if (character === "\r" || character === "\n") {
    return "complete";
  }
  if (character === "\u007f" || character === "\b") {
    if (characters.pop() !== undefined) {
      target.write("\b \b");
    }
    return "continue";
  }
  if (characters.length < MAX_INPUT_BYTES) {
    characters.push(character);
    target.write("•");
  }
  return "continue";
};

const readMaskedSecret = (
  invocation: OnboardingInvocation
): Promise<string> => {
  const input = invocation.stdin;
  if (
    input.isTTY !== true ||
    input.setRawMode === undefined ||
    input.on === undefined ||
    input.off === undefined ||
    input.resume === undefined
  ) {
    throw new OnboardingCliError(
      "cli-non-interactive",
      "Use --stdin or --from-env when a masked TTY is unavailable.",
      2
    );
  }
  invocation.stderr.write("Secret (masked): ");
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const characters: string[] = [];
    const cleanup = (): void => {
      input.off?.("data", onData);
      input.setRawMode?.(false);
      input.pause?.();
      invocation.stderr.write("\n");
    };
    const onData = (chunk: unknown): void => {
      for (const character of decodeInputChunk(chunk)) {
        const inputAction = handleMaskedCharacter(
          character,
          characters,
          invocation.stderr
        );
        if (inputAction === "abort") {
          cleanup();
          reject(
            new OnboardingCliError(
              "cli-interrupted",
              "Secret entry was interrupted.",
              130
            )
          );
          return;
        }
        if (inputAction === "complete") {
          const value = characters.join("");
          cleanup();
          if (value.length === 0 || value.trim() !== value) {
            reject(
              new OnboardingCliError(
                "cli-input-invalid",
                "The secret is empty or contains surrounding whitespace.",
                2
              )
            );
          } else {
            resolve(value);
          }
          return;
        }
      }
    };
    input.on?.("data", onData);
  });
};

const configOrThrow = async (
  environment: Environment
): Promise<KurobaraConfiguration> => {
  const result = await readConfiguration(environment);
  if (result.kind === "current") {
    return result.config;
  }
  if (result.kind === "legacy") {
    throw new OnboardingCliError(
      "config-migration-required",
      "The local configuration requires an explicit migration.",
      3,
      [
        action("migrate", "Migrate configuration", [
          "kurobara",
          "setup",
          "migrate",
          "--json",
        ]),
      ]
    );
  }
  throw new OnboardingCliError(
    result.kind === "missing" ? "config-missing" : "config-incompatible",
    result.kind === "missing"
      ? "Kurobara is not configured."
      : `Configuration schema ${result.version} is not supported.`,
    3,
    [
      action("plan", "Create a setup plan", [
        "kurobara",
        "setup",
        "plan",
        "--profile",
        "local",
        "--json",
      ]),
    ]
  );
};

const setupInspection = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const configuration = await readConfiguration(invocation.environment);
  const state = await readSetupState(invocation.environment);
  const store = new SecretStore(invocation.environment);
  let configStatus: string = configuration.kind;
  let configVersion: string | null = null;
  if (configuration.kind === "current") {
    configStatus = "current";
    configVersion = configuration.config.schema_version;
  } else if (configuration.kind === "legacy") {
    configStatus = "migration_required";
  } else if (configuration.kind === "incompatible") {
    configVersion = configuration.version;
  }
  return success("setup.inspect", {
    completed_steps: ["detect"],
    configuration: {
      path: onboardingPaths(invocation.environment).config,
      profile:
        configuration.kind === "current" || configuration.kind === "legacy"
          ? configuration.config.profile
          : null,
      schema_version: configVersion,
      status: configStatus,
    },
    next_actions:
      configuration.kind === "current"
        ? [
            action("doctor", "Verify readiness", [
              "kurobara",
              "doctor",
              "--json",
            ]),
          ]
        : [
            action("plan", "Create a setup plan", [
              "kurobara",
              "setup",
              "plan",
              "--profile",
              "local",
              "--json",
            ]),
          ],
    runtime: {
      node: process.versions.node,
      platform: process.platform,
    },
    secret_backend: store.backend,
    state: state ?? null,
    summary: `Configuration is ${configStatus}.`,
  });
};

const setupPlan = async (argv: readonly string[]): Promise<MachineResult> => {
  const parsed = parseOptions(
    argv,
    new Set(),
    new Set(["--endpoint", "--output", "--profile", "--provider"]),
    new Set(["--provider"])
  );
  const profile = parsed.values.get("--profile") ?? "local";
  if (profile !== "local" && profile !== "remote") {
    throw new OnboardingCliError(
      "cli-usage-error",
      "Setup profile must be local or remote.",
      2
    );
  }
  const providers =
    parsed.repeated.get("--provider") ??
    (profile === "local" ? ["prospeo", "hunter"] : []);
  const plan = createSetupPlan(
    profile,
    parsed.values.get("--endpoint") ?? DEFAULT_ENDPOINT,
    providers
  );
  const output = parsed.values.get("--output");
  if (output !== undefined) {
    await writePlanFile(output, plan);
  }
  return success("setup.plan", {
    completed_steps: ["detect", "plan"],
    next_actions: [
      action("apply", "Apply this exact setup plan", [
        "kurobara",
        "setup",
        "apply",
        "--file",
        output ?? "<plan-file>",
        "--non-interactive",
        "--json",
      ]),
    ],
    plan,
    plan_path: output ?? null,
    summary:
      output === undefined
        ? "Setup plan generated without writing local state."
        : "Setup plan generated and written to the requested path.",
  });
};

const setupApply = async (
  invocation: OnboardingInvocation,
  argv: readonly string[]
): Promise<MachineResult> => {
  const parsed = parseOptions(argv, new Set(), new Set(["--file"]));
  const file = parsed.values.get("--file");
  if (file === undefined) {
    throw new OnboardingCliError(
      "cli-usage-error",
      "Setup apply requires --file.",
      2
    );
  }
  const plan = await readPlanFile(file);
  const applied = await applySetupPlan(invocation.environment, plan);
  return success("setup.apply", {
    completed_steps: applied.state.completed_steps,
    config_fingerprint: applied.state.config_fingerprint,
    next_actions: [
      action("credentials", "Configure referenced credentials", [
        "kurobara",
        "provider",
        "list",
        "--json",
      ]),
      action("doctor", "Verify readiness", ["kurobara", "doctor", "--json"]),
    ],
    profile: applied.config.profile,
    summary: "Setup plan applied and verified.",
  });
};

const setupStatus = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const configuration = await readConfiguration(invocation.environment);
  const state = await readSetupState(invocation.environment);
  const ready =
    configuration.kind === "current" &&
    state?.completed_steps.includes("verify") === true &&
    state.config_fingerprint === documentFingerprint(configuration.config);
  return success("setup.status", {
    blocked_steps: ready ? [] : ["verify"],
    completed_steps: state?.completed_steps ?? [],
    next_actions: ready
      ? [
          action("doctor", "Verify runtime readiness", [
            "kurobara",
            "doctor",
            "--json",
          ]),
        ]
      : [
          action("inspect", "Inspect configuration drift", [
            "kurobara",
            "setup",
            "inspect",
            "--json",
          ]),
        ],
    ready,
    summary: ready
      ? "Setup state is internally consistent."
      : "Setup is incomplete or configuration drift was detected.",
  });
};

const setupMigrate = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const config = await migrateConfiguration(invocation.environment);
  return success("setup.migrate", {
    completed_steps: ["detect", "plan", "confirm", "apply", "verify"],
    profile: config.profile,
    summary: "Configuration migrated and verified.",
  });
};

const interactiveSetup = async (
  invocation: OnboardingInvocation,
  presentation: Presentation
): Promise<MachineResult> => {
  if (
    presentation.nonInteractive ||
    invocation.stdin.isTTY !== true ||
    invocation.stdout.isTTY !== true
  ) {
    throw new OnboardingCliError(
      "cli-non-interactive",
      "Interactive setup requires a TTY. Agents must use inspect, plan, and apply.",
      2,
      [
        action("inspect", "Inspect setup state", [
          "kurobara",
          "setup",
          "inspect",
          "--json",
        ]),
      ]
    );
  }
  brand(invocation.stdout, presentation.color);
  writeLine(
    invocation.stdout,
    "One engine. Human prompts or deterministic JSON."
  );
  writeLine(invocation.stdout, "Profile [local/remote] (local): ");
  const iterator = invocation.stdin[Symbol.asyncIterator]();
  const first = await iterator.next();
  const profileInput =
    first.done || first.value === undefined
      ? ""
      : String(first.value).trim().toLowerCase();
  const profile = profileInput === "" ? "local" : profileInput;
  if (profile !== "local" && profile !== "remote") {
    throw new OnboardingCliError(
      "cli-input-invalid",
      "Profile must be local or remote.",
      2
    );
  }
  const providers = profile === "local" ? ["prospeo", "hunter"] : [];
  const plan = createSetupPlan(profile, DEFAULT_ENDPOINT, providers);
  writeLine(invocation.stdout);
  writeLine(invocation.stdout, `Profile: ${profile}`);
  writeLine(
    invocation.stdout,
    `Providers: ${providers.length === 0 ? "server-managed" : providers.join(" → ")}`
  );
  writeLine(invocation.stdout, "This writes local configuration only.");
  writeLine(
    invocation.stdout,
    "Provider calls can spend credits later and always require a separate action."
  );
  writeLine(invocation.stdout, "Apply this plan? [yes/no]: ");
  const second = await iterator.next();
  const confirmation =
    second.done || second.value === undefined
      ? ""
      : String(second.value).trim().toLowerCase();
  await iterator.return?.();
  if (confirmation !== "yes") {
    throw new OnboardingCliError(
      "confirmation-required",
      "Setup was not applied.",
      2,
      [
        action(
          "resume",
          "Resume interactive setup",
          ["kurobara", "setup"],
          true
        ),
      ]
    );
  }
  if (presentation.motion) {
    invocation.stdout.write(
      `${presentation.color ? PINK : ""}···●····●···${presentation.color ? RESET : ""} applying\r`
    );
    await (
      invocation.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)))
    )(80);
  }
  const applied = await applySetupPlan(invocation.environment, plan);
  writeLine(invocation.stdout, "✓ configuration written atomically");
  writeLine(invocation.stdout, "✓ setup state verified");
  return success("setup", {
    completed_steps: applied.state.completed_steps,
    next_actions: [
      action("credential", "Add the first provider credential", [
        "kurobara",
        "secret",
        "set",
        providers[0] ?? "kurobara",
      ]),
      action("doctor", "Run readiness checks", ["kurobara", "doctor"]),
    ],
    profile,
    summary: "Kurobara setup is configured.",
  });
};

const providerFor = (key: string): ProviderCatalogEntry => {
  const provider = PROVIDER_CATALOG.find((candidate) => candidate.key === key);
  if (provider === undefined) {
    throw new OnboardingCliError(
      "provider-unknown",
      `Unknown provider: ${key}.`,
      2
    );
  }
  return provider;
};

const providerState = async (
  provider: ProviderCatalogEntry,
  config: KurobaraConfiguration | undefined,
  environment: Environment,
  store: SecretStore
): Promise<Readonly<Record<string, unknown>>> => {
  const configured =
    environment[provider.credential_environment_variable] !== undefined ||
    (provider.key !== "pdl" && (await store.has(provider.key)));
  const enabled = config?.provider_order.includes(provider.key) === true;
  const rightsConfirmed =
    provider.rights_attestation_environment_variable === undefined ||
    environment[provider.rights_attestation_environment_variable] === "true";
  let state = "unavailable";
  if (
    provider.admission !== "candidate_rights_required" &&
    configured &&
    !rightsConfirmed
  ) {
    state = "rights_required";
  } else if (
    provider.admission !== "candidate_rights_required" &&
    configured &&
    enabled
  ) {
    state = "admitted";
  } else if (provider.admission !== "candidate_rights_required" && configured) {
    state = "configured";
  }
  return {
    admission: provider.admission,
    capabilities: provider.capabilities,
    configured,
    credential_environment_variable: provider.credential_environment_variable,
    enabled,
    key: provider.key,
    probe: provider.probe,
    rights_attestation_environment_variable:
      provider.rights_attestation_environment_variable ?? null,
    roles: provider.roles,
    state,
  };
};

const providerList = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const read = await readConfiguration(invocation.environment);
  const config =
    read.kind === "current" || read.kind === "legacy" ? read.config : undefined;
  const store = new SecretStore(invocation.environment);
  const providers = await Promise.all(
    PROVIDER_CATALOG.map((provider) =>
      providerState(provider, config, invocation.environment, store)
    )
  );
  return success("provider.list", {
    next_actions: [
      action("configure", "Store a provider credential", [
        "kurobara",
        "provider",
        "configure",
        "prospeo",
        "--stdin",
        "--enable",
        "--json",
      ]),
    ],
    profile: config?.profile ?? null,
    providers,
    summary: "Provider state read from the canonical registry.",
  });
};

const updateProviderOrder = async (
  environment: Environment,
  config: KurobaraConfiguration,
  providerOrder: readonly string[]
): Promise<void> => {
  const plan = createSetupPlan(config.profile, config.endpoint, providerOrder);
  await applySetupPlan(environment, plan);
};

const secretValueFrom = (
  invocation: OnboardingInvocation,
  parsed: ReturnType<typeof parseOptions>
): Promise<string> => {
  const fromEnvironment = parsed.values.get("--from-env");
  const fromStdin = parsed.booleans.has("--stdin");
  if (fromEnvironment !== undefined && fromStdin) {
    throw new OnboardingCliError(
      "cli-usage-error",
      "Choose exactly one credential source.",
      2
    );
  }
  if (fromEnvironment !== undefined) {
    const value = invocation.environment[fromEnvironment];
    if (value === undefined) {
      throw new OnboardingCliError(
        "secret-source-missing",
        `The named environment variable ${fromEnvironment} is not set.`,
        3
      );
    }
    return Promise.resolve(value);
  }
  if (fromStdin) {
    return readStreamValue(invocation.stdin, "Secret input");
  }
  return readMaskedSecret(invocation);
};

const configureProvider = async (
  invocation: OnboardingInvocation,
  key: string,
  argv: readonly string[]
): Promise<MachineResult> => {
  const provider = providerFor(key);
  if (provider.admission === "candidate_rights_required") {
    throw new OnboardingCliError(
      "provider-unavailable",
      `${provider.display_name} is not admitted by the current runtime.`,
      69
    );
  }
  const config = await configOrThrow(invocation.environment);
  if (config.profile === "remote") {
    throw new OnboardingCliError(
      "remote-secret-write-forbidden",
      "Remote profiles cannot write server-side provider credentials.",
      3,
      [
        action(
          "operator",
          "Ask the remote operator to configure the provider",
          ["kurobara", "provider", "list", "--json"]
        ),
      ]
    );
  }
  const parsed = parseOptions(
    argv,
    new Set(["--enable", "--stdin"]),
    new Set(["--from-env"])
  );
  const value = await secretValueFrom(invocation, parsed);
  const store = new SecretStore(invocation.environment);
  await store.set(key, value);
  if (parsed.booleans.has("--enable") && !config.provider_order.includes(key)) {
    if (
      provider.rights_attestation_environment_variable !== undefined &&
      invocation.environment[
        provider.rights_attestation_environment_variable
      ] !== "true"
    ) {
      throw new OnboardingCliError(
        "provider-rights-required",
        `${provider.display_name} requires an explicit data-rights attestation before admission.`,
        3
      );
    }
    await updateProviderOrder(invocation.environment, config, [
      ...config.provider_order,
      key,
    ]);
  }
  return success("provider.configure", {
    backend: store.backend,
    configured: true,
    credential_environment_variable: provider.credential_environment_variable,
    enabled:
      parsed.booleans.has("--enable") || config.provider_order.includes(key),
    provider: key,
    summary: `${provider.display_name} credential stored without exposing its value.`,
  });
};

const disableProvider = async (
  invocation: OnboardingInvocation,
  key: string
): Promise<MachineResult> => {
  providerFor(key);
  const config = await configOrThrow(invocation.environment);
  await updateProviderOrder(
    invocation.environment,
    config,
    config.provider_order.filter((provider) => provider !== key)
  );
  return success("provider.disable", {
    provider: key,
    summary: `${key} is disabled. Its credential was not deleted.`,
  });
};

const probeProvider = (key: string): MachineResult => {
  const provider = providerFor(key);
  return success("provider.probe", {
    blocked_steps: ["reachable"],
    cost: { amount: 0, unit: "provider_credits" },
    next_actions: [
      action(
        "live",
        "Use an explicitly bounded live first run",
        [
          "kurobara",
          "first-run",
          "--live",
          "--max-companies",
          "1",
          "--max-contacts",
          "1",
          "--confirm-provider-credits",
          "--json",
        ],
        true
      ),
    ],
    provider: key,
    state: "unavailable",
    summary: `${provider.display_name} exposes no qualified zero-credit health probe; no network call was made.`,
    warnings: [provider.cost_notice],
  });
};

const secretCommand = async (
  invocation: OnboardingInvocation,
  verb: string,
  key: string,
  argv: readonly string[]
): Promise<MachineResult> => {
  if (key !== "kurobara") {
    providerFor(key);
  }
  const config = await configOrThrow(invocation.environment);
  if (config.profile === "remote" && key !== "kurobara") {
    throw new OnboardingCliError(
      "remote-secret-write-forbidden",
      "Remote profiles can store only the client-side Kurobara API key.",
      3
    );
  }
  const store = new SecretStore(invocation.environment);
  if (verb === "status") {
    return success("secret.status", {
      backend: store.backend,
      configured: await store.has(key),
      secret: key,
      summary: `Secret ${key} presence checked without returning its value.`,
    });
  }
  if (verb === "delete") {
    await store.delete(key);
    return success("secret.delete", {
      backend: store.backend,
      configured: false,
      secret: key,
      summary: `Secret ${key} deleted from the selected backend.`,
    });
  }
  const parsed = parseOptions(
    argv,
    new Set(["--stdin"]),
    new Set(["--from-env"])
  );
  await store.set(key, await secretValueFrom(invocation, parsed));
  return success("secret.set", {
    backend: store.backend,
    configured: true,
    secret: key,
    summary: `Secret ${key} stored without exposing its value.`,
  });
};

const fetchCheck = async (
  fetchImplementation: typeof fetch,
  url: string,
  signal: AbortSignal | undefined
): Promise<Readonly<{ detail: string; status: "failed" | "passed" }>> => {
  const timeout = AbortSignal.timeout(3000);
  const requestSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await fetchImplementation(url, {
      headers: { accept: "application/json" },
      method: "GET",
      signal: requestSignal,
    });
    return response.ok
      ? { detail: `HTTP ${response.status}`, status: "passed" }
      : { detail: `HTTP ${response.status}`, status: "failed" };
  } catch {
    return { detail: "unreachable", status: "failed" };
  }
};

const doctor = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const read = await readConfiguration(invocation.environment);
  const config =
    read.kind === "current" || read.kind === "legacy" ? read.config : undefined;
  const store = new SecretStore(invocation.environment);
  const clientCredential =
    invocation.environment.KUROBARA_API_KEY !== undefined ||
    (await store.has("kurobara"));
  const endpoint = config?.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImplementation = invocation.fetch ?? fetch;
  const [health, readiness, providers] = await Promise.all([
    fetchCheck(
      fetchImplementation,
      new URL("/healthz", endpoint).href,
      invocation.signal
    ),
    fetchCheck(
      fetchImplementation,
      new URL("/readyz", endpoint).href,
      invocation.signal
    ),
    Promise.all(
      PROVIDER_CATALOG.map((provider) =>
        providerState(provider, config, invocation.environment, store)
      )
    ),
  ]);
  const configPassed = read.kind === "current";
  let configurationDetail: string = read.kind;
  if (read.kind === "current") {
    configurationDetail = ONBOARDING_SCHEMA_VERSION;
  } else if (read.kind === "legacy") {
    configurationDetail = "migration required";
  }
  const checks = [
    {
      detail: configurationDetail,
      id: "configuration",
      impact: "Setup state and command defaults",
      status: configPassed ? "passed" : "failed",
    },
    {
      detail: clientCredential ? "configured" : "missing",
      id: "client_authentication",
      impact: "Authenticated API commands",
      status: clientCredential ? "passed" : "failed",
    },
    {
      detail: health.detail,
      id: "api_health",
      impact: "API reachability",
      status: health.status,
    },
    {
      detail: readiness.detail,
      id: "runtime_readiness",
      impact: "PostgreSQL, Hatchet, and worker readiness",
      status: readiness.status,
    },
  ];
  const ready = checks.every((check) => check.status === "passed");
  return success("doctor", {
    blocked_steps: checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id),
    checks,
    next_actions: ready
      ? [
          action("first-run", "Run the zero-credit fixture", [
            "kurobara",
            "first-run",
            "--offline",
            "--json",
          ]),
        ]
      : [
          action("inspect", "Inspect setup state", [
            "kurobara",
            "setup",
            "inspect",
            "--json",
          ]),
          action("client-key", "Store the client API key", [
            "kurobara",
            "secret",
            "set",
            "kurobara",
            "--stdin",
            "--json",
          ]),
        ],
    providers,
    ready,
    summary: ready
      ? "Kurobara is ready for a first run."
      : "Kurobara needs the listed remediations.",
  });
};

const updateCheck = async (
  invocation: OnboardingInvocation
): Promise<MachineResult> => {
  const timeout = AbortSignal.timeout(3000);
  const requestSignal =
    invocation.signal === undefined
      ? timeout
      : AbortSignal.any([invocation.signal, timeout]);
  let response: Response;
  try {
    response = await (invocation.fetch ?? fetch)(
      "https://api.github.com/repos/Dragon-kanji/Kurobara/releases?per_page=1",
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `kurobara-cli/${packageManifest.version}`,
        },
        signal: requestSignal,
      }
    );
  } catch {
    throw new OnboardingCliError(
      "update-check-unavailable",
      "The explicit GitHub release check is unavailable.",
      75,
      [],
      true
    );
  }
  if (!response.ok) {
    throw new OnboardingCliError(
      "update-check-unavailable",
      `The explicit GitHub release check returned HTTP ${response.status}.`,
      75,
      [],
      true
    );
  }
  const releases = (await response.json()) as unknown;
  const candidate = Array.isArray(releases) ? releases[0] : undefined;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !Object.hasOwn(candidate, "tag_name") ||
    typeof (candidate as { tag_name?: unknown }).tag_name !== "string"
  ) {
    throw new OnboardingCliError(
      "update-check-invalid",
      "GitHub returned an invalid release document.",
      70
    );
  }
  const latest = (candidate as { tag_name: string }).tag_name;
  const current = `v${packageManifest.version}`;
  return success("update.check", {
    current,
    latest,
    next_actions:
      current === latest
        ? []
        : [
            action("upgrade", "Pull the source preview and reinstall", [
              "git",
              "pull",
              "--ff-only",
            ]),
          ],
    summary:
      current === latest
        ? "This checkout matches the latest published preview."
        : `A different published preview is available: ${latest}.`,
    update_available: current !== latest,
  });
};

type OfflineFirstRunReceipt = Readonly<{
  application_id: string;
  dataset_id: string;
  export: Readonly<{
    byte_count: number;
    format: string;
    retained: boolean;
    sha256: string;
  }>;
}>;

const jsonValuesFromOutput = (output: string): readonly unknown[] => {
  const values: unknown[] = [];
  for (const line of output.split(LINE_BREAK_PATTERN)) {
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // Non-JSON build and runtime lines are intentionally ignored.
    }
  }
  return values;
};

const firstRunFailureStage = (stderr: string): string => {
  const envelope = [...jsonValuesFromOutput(stderr)]
    .reverse()
    .find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, "stage") &&
        typeof (value as { stage?: unknown }).stage === "string"
    );
  return envelope === undefined
    ? "unknown"
    : (envelope as { stage: string }).stage;
};

const offlineFirstRunReceipt = (stdout: string): OfflineFirstRunReceipt => {
  const candidate = [...jsonValuesFromOutput(stdout)]
    .reverse()
    .find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { ok?: unknown }).ok === true
    );
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as { application_id?: unknown }).application_id !==
      "string" ||
    typeof (candidate as { dataset_id?: unknown }).dataset_id !== "string" ||
    typeof (candidate as { export?: unknown }).export !== "object" ||
    (candidate as { export?: unknown }).export === null
  ) {
    throw new OnboardingCliError(
      "first-run-contract-invalid",
      "The offline harness succeeded without a valid final receipt.",
      70
    );
  }
  return candidate as OfflineFirstRunReceipt;
};

const firstRun = async (
  invocation: OnboardingInvocation,
  argv: readonly string[]
): Promise<MachineResult> => {
  const parsed = parseOptions(
    argv,
    new Set(["--confirm-provider-credits", "--live", "--offline"]),
    new Set(["--max-companies", "--max-contacts"])
  );
  const live = parsed.booleans.has("--live");
  const offline = parsed.booleans.has("--offline") || !live;
  if (live && offline && parsed.booleans.has("--offline")) {
    throw new OnboardingCliError(
      "cli-usage-error",
      "Choose either --offline or --live.",
      2
    );
  }
  if (live && !parsed.booleans.has("--confirm-provider-credits")) {
    throw new OnboardingCliError(
      "confirmation-required",
      "The live first run can spend provider credits.",
      2,
      [
        action(
          "confirm-live",
          "Run one company and one contact after explicit approval",
          [
            "kurobara",
            "first-run",
            "--live",
            "--max-companies",
            "1",
            "--max-contacts",
            "1",
            "--confirm-provider-credits",
            "--json",
          ],
          true
        ),
      ]
    );
  }
  const parseCap = (name: string): number => {
    const value = parsed.values.get(name);
    if (value === undefined || value !== "1") {
      throw new OnboardingCliError(
        "cli-usage-error",
        `Live onboarding requires ${name} 1.`,
        2
      );
    }
    return 1;
  };
  const environment: Record<string, string | undefined> = {
    ...invocation.environment,
  };
  if (live) {
    environment.KUROBARA_DOGFOOD_MAX_COMPANIES = String(
      parseCap("--max-companies")
    );
    environment.KUROBARA_DOGFOOD_MAX_CONTACTS = String(
      parseCap("--max-contacts")
    );
  }
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const runner = invocation.processRunner ?? defaultProcessRunner;
  const result = await runner({
    args: live ? ["run", "b2b:dogfood"] : ["deploy/self-host/harness.sh"],
    command: live ? "npm" : "bash",
    cwd: repositoryRoot,
    environment,
  });
  if (result.code !== 0) {
    const failedStage = firstRunFailureStage(result.stderr);
    throw new OnboardingCliError(
      "first-run-failed",
      live
        ? `The bounded live first run failed at ${failedStage}. Inspect provider admission and retry with the same bounds.`
        : `The offline first run failed at ${failedStage}. The self-host harness cleaned up its temporary stack and the same command can resume safely.`,
      75,
      [
        action(
          "resume",
          "Resume the bounded first run",
          live
            ? [
                "kurobara",
                "first-run",
                "--live",
                "--max-companies",
                "1",
                "--max-contacts",
                "1",
                "--confirm-provider-credits",
                "--json",
              ]
            : ["kurobara", "first-run", "--offline", "--json"],
          live
        ),
      ],
      true,
      [`first_run:${failedStage}`]
    );
  }
  const offlineReceipt = live
    ? undefined
    : offlineFirstRunReceipt(result.stdout);
  return success("first-run", {
    completed_steps: [
      "import",
      "apply_recipe",
      "durable_run",
      "watch",
      "export",
      "cleanup",
    ],
    cost: live
      ? { bounded: true, unit: "provider_requests" }
      : { amount: 0, unit: "provider_credits" },
    mode: live ? "live" : "offline",
    ...(offlineReceipt === undefined
      ? {}
      : {
          files: [
            {
              byte_count: offlineReceipt.export.byte_count,
              format: offlineReceipt.export.format,
              retained: offlineReceipt.export.retained,
              sha256: offlineReceipt.export.sha256,
            },
          ],
          ids: {
            application_id: offlineReceipt.application_id,
            dataset_id: offlineReceipt.dataset_id,
          },
        }),
    next_actions: [
      action("company-search", "Build the first bounded company list", [
        "kurobara",
        "company",
        "search",
        "--mode",
        "dry-run",
        "<bounded-options>",
      ]),
    ],
    receipt: {
      durable_path:
        "CLI -> HTTP API -> PostgreSQL -> Hatchet -> worker -> export",
      provider_calls: live ? "bounded" : 0,
      synthetic: !live,
    },
    summary: live
      ? "The bounded live onboarding run completed."
      : "The zero-credit self-hosted vertical completed and cleaned up.",
  });
};

const runtimeExec = async (
  invocation: OnboardingInvocation,
  argv: readonly string[],
  presentation: Presentation
): Promise<MachineResult> => {
  if (presentation.machine) {
    throw new OnboardingCliError(
      "cli-usage-error",
      "runtime exec cannot guarantee JSON-only stdout from an arbitrary child process.",
      2
    );
  }
  if (argv[0] !== "--" || argv[1] === undefined) {
    throw new OnboardingCliError(
      "cli-usage-error",
      "runtime exec requires -- followed by an executable and arguments.",
      2
    );
  }
  const config = await configOrThrow(invocation.environment);
  if (config.profile !== "local") {
    throw new OnboardingCliError(
      "runtime-remote",
      "runtime exec is available only for local profiles.",
      3
    );
  }
  const store = new SecretStore(invocation.environment);
  const childEnvironment: Record<string, string | undefined> = {
    ...invocation.environment,
    KUROBARA_API_URL: config.endpoint,
    KUROBARA_PROVIDER_ORDER: config.provider_order.join(","),
  };
  const clientKey = await store.get("kurobara");
  if (clientKey !== undefined) {
    childEnvironment.KUROBARA_API_KEY = clientKey;
  }
  for (const key of config.provider_order) {
    const provider = providerFor(key);
    const credential = await store.get(key);
    if (credential !== undefined) {
      childEnvironment[provider.credential_environment_variable] = credential;
    }
  }
  const result = await (invocation.processRunner ?? defaultProcessRunner)({
    args: argv.slice(2),
    command: argv[1],
    environment: childEnvironment,
    inheritOutput: true,
  });
  if (result.code !== 0) {
    throw new OnboardingCliError(
      "runtime-child-failed",
      `The child process exited with code ${result.code}.`,
      result.code
    );
  }
  return success("runtime.exec", {
    injected_secret_names: [
      ...(clientKey === undefined ? [] : ["KUROBARA_API_KEY"]),
      ...config.provider_order
        .map((key) => providerFor(key).credential_environment_variable)
        .filter((name) => childEnvironment[name] !== undefined),
    ],
    summary:
      "The local child process completed with referenced credentials injected.",
  });
};

const helpResult = (): MachineResult =>
  success("help", {
    commands: onboardingContract.commands,
    next_actions: [
      action("inspect", "Inspect the machine", [
        "kurobara",
        "setup",
        "inspect",
        "--json",
      ]),
      action("setup", "Start human setup", ["kurobara", "setup"]),
    ],
    product_commands: onboardingContract.product_commands,
    summary: "Open-source B2B list building for humans and coding agents.",
    version: packageManifest.version,
  });

const remainingArguments = (
  subject: string | undefined,
  rest: readonly string[]
): readonly string[] => (subject === undefined ? rest : [subject, ...rest]);

const dispatchSetup = (
  invocation: OnboardingInvocation,
  verb: string | undefined,
  subject: string | undefined,
  rest: readonly string[],
  presentation: Presentation
): Promise<MachineResult> => {
  const arguments_ = remainingArguments(subject, rest);
  switch (verb) {
    case undefined:
      return interactiveSetup(invocation, presentation);
    case "apply":
      return setupApply(invocation, arguments_);
    case "inspect":
      return setupInspection(invocation);
    case "migrate":
      return setupMigrate(invocation);
    case "plan":
      return setupPlan(arguments_);
    case "status":
      return setupStatus(invocation);
    default:
      throw new OnboardingCliError(
        "cli-usage-error",
        `Unknown setup command: ${verb}.`,
        2
      );
  }
};

const dispatchProvider = (
  invocation: OnboardingInvocation,
  verb: string | undefined,
  subject: string | undefined,
  rest: readonly string[]
): MachineResult | Promise<MachineResult> => {
  if (verb === "list" && subject === undefined) {
    return providerList(invocation);
  }
  if (verb === "configure" && subject !== undefined) {
    return configureProvider(invocation, subject, rest);
  }
  if (
    (verb === "disable" || verb === "probe") &&
    subject !== undefined &&
    rest.length === 0
  ) {
    return verb === "disable"
      ? disableProvider(invocation, subject)
      : probeProvider(subject);
  }
  throw new OnboardingCliError(
    "cli-usage-error",
    "Provider commands are list, configure, disable, and probe.",
    2
  );
};

const dispatchSecret = (
  invocation: OnboardingInvocation,
  verb: string | undefined,
  subject: string | undefined,
  rest: readonly string[]
): Promise<MachineResult> => {
  if (
    (verb === "set" || verb === "delete" || verb === "status") &&
    subject !== undefined
  ) {
    return secretCommand(invocation, verb, subject, rest);
  }
  throw new OnboardingCliError(
    "cli-usage-error",
    "Secret commands are set, delete, and status and require a secret name.",
    2
  );
};

const dispatch = (
  invocation: OnboardingInvocation,
  argv: readonly string[],
  presentation: Presentation
): MachineResult | Promise<MachineResult> => {
  const [group, verb, subject, ...rest] = argv;
  switch (group) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return helpResult();
    case "--version":
    case "version":
      return success("version", {
        summary: packageManifest.version,
        version: packageManifest.version,
      });
    case "doctor":
      if (verb === undefined) {
        return doctor(invocation);
      }
      throw new OnboardingCliError(
        "cli-usage-error",
        "doctor accepts only global presentation flags.",
        2
      );
    case "first-run":
      return firstRun(
        invocation,
        remainingArguments(verb, remainingArguments(subject, rest))
      );
    case "provider":
      return dispatchProvider(invocation, verb, subject, rest);
    case "runtime":
      if (verb === "exec") {
        return runtimeExec(
          invocation,
          remainingArguments(subject, rest),
          presentation
        );
      }
      break;
    case "secret":
      return dispatchSecret(invocation, verb, subject, rest);
    case "setup":
      return dispatchSetup(invocation, verb, subject, rest, presentation);
    case "update":
      if (verb === "check" && subject === undefined) {
        return updateCheck(invocation);
      }
      break;
    default:
      break;
  }
  throw new OnboardingCliError(
    "cli-usage-error",
    "Unknown onboarding command. Run kurobara --help.",
    2,
    [action("help", "Read command discovery", ["kurobara", "--help"])]
  );
};

const ONBOARDING_GROUPS = new Set([
  "--help",
  "--version",
  "-h",
  "doctor",
  "first-run",
  "help",
  "provider",
  "runtime",
  "secret",
  "setup",
  "update",
  "version",
]);

export const isOnboardingCommand = (argv: readonly string[]): boolean =>
  argv.length === 0 ||
  (argv.some((argument) => ONBOARDING_GROUPS.has(argument)) &&
    !["company", "contact", "dataset", "recipe", "run"].includes(
      argv[0] ?? ""
    ));

export const runOnboardingCli = async (
  invocation: OnboardingInvocation
): Promise<number | undefined> => {
  if (!isOnboardingCommand(invocation.argv)) {
    return;
  }
  const { argv, presentation } = globalPresentation(
    invocation.argv,
    invocation
  );
  let command = argv.slice(0, 2).join(".") || "help";
  try {
    const result = await dispatch(invocation, argv, presentation);
    command = result.command;
    if (presentation.machine) {
      writeJson(invocation.stdout, result);
    } else {
      renderHumanResult(invocation.stdout, result, presentation.color);
    }
    return 0;
  } catch (cause) {
    let error: OnboardingCliError;
    if (cause instanceof OnboardingConfigError) {
      error = mapConfigurationError(cause);
    } else if (cause instanceof OnboardingCliError) {
      error = cause;
    } else {
      error = new OnboardingCliError(
        "cli-runtime-error",
        "Kurobara onboarding failed.",
        70
      );
    }
    const problem: MachineProblem = {
      blocked_steps: error.blockedSteps,
      command,
      completed_steps: [],
      next_actions: error.nextActions,
      ok: false,
      problem: {
        code: error.code,
        retryable: error.retryable,
        status: 0,
        title: error.message,
        type: "about:blank",
      },
      requires_confirmation: error.code === "confirmation-required",
      schema_version: ONBOARDING_SCHEMA_VERSION,
      warnings: [],
    };
    if (presentation.machine) {
      writeJson(invocation.stderr, problem);
    } else {
      brand(invocation.stderr, presentation.color);
      writeLine(invocation.stderr, `ERROR ${error.code}: ${error.message}`);
      for (const nextAction of error.nextActions) {
        writeLine(invocation.stderr, `→ ${nextAction.argv.join(" ")}`);
      }
    }
    return error.exitCode;
  }
};
