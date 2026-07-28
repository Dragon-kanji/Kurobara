import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli.ts";
import type { OnboardingReadable, ProcessRequest } from "../src/onboarding.ts";

const BRAND_PATTERN = /KUROBARA/u;
const DOT_FLOW_PATTERN = /···●····●···/u;
const MASK_PATTERN = /••••/u;
const WRITE_CONFIRMATION_PATTERN = /configuration written atomically/u;
const GTM_CONTEXT_PATTERN = /GTM CONTEXT/u;
const FINGERPRINT_PATTERN = /Fingerprint:/u;
const CONTEXT_STORED_PATTERN = /immutable Context revision stored/u;

const capture = (isTTY = false) => {
  const chunks: Uint8Array[] = [];
  return {
    target: {
      isTTY,
      write: (chunk: string | Uint8Array) => {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        );
      },
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
  };
};

const environmentFor = (
  root: string,
  values: Readonly<Record<string, string | undefined>> = {}
) => ({
  HOME: root,
  KUROBARA_CONFIG_HOME: path.join(root, "config"),
  KUROBARA_DATA_HOME: path.join(root, "data"),
  KUROBARA_SECRET_BACKEND: "file",
  ...values,
});

const invoke = async (
  root: string,
  argv: readonly string[],
  options: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch;
    processRunner?: (request: ProcessRequest) => Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }>;
    stdin?: OnboardingReadable & Readable;
    tty?: boolean;
  }> = {}
) => {
  const stdout = capture(options.tty);
  const stderr = capture(options.tty);
  const exitCode = await runCli({
    argv,
    environment: environmentFor(root, options.environment),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.processRunner === undefined
      ? {}
      : { processRunner: options.processRunner }),
    stderr: stderr.target,
    stdin: options.stdin ?? Readable.from([]),
    stdout: stdout.target,
  });
  return {
    exitCode,
    stderr: stderr.value(),
    stdout: stdout.value(),
  };
};

const configure = async (
  root: string,
  profile: "local" | "remote" = "local"
) => {
  const planPath = path.join(root, "plan.json");
  const planned = await invoke(root, [
    "setup",
    "plan",
    "--profile",
    profile,
    "--output",
    planPath,
    "--json",
  ]);
  if (planned.exitCode !== 0) {
    throw new Error(`Setup planning failed: ${planned.stderr}`);
  }
  const applied = await invoke(root, [
    "setup",
    "apply",
    "--file",
    planPath,
    "--non-interactive",
    "--json",
  ]);
  if (applied.exitCode !== 0) {
    throw new Error(`Setup apply failed: ${applied.stderr}`);
  }
  return planPath;
};

test("inspect is read-only and setup apply is deterministic and resumable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const inspection = await invoke(root, ["setup", "inspect", "--json"]);
  assert.equal(inspection.exitCode, 0);
  assert.equal(JSON.parse(inspection.stdout).configuration.status, "missing");
  await assert.rejects(readFile(path.join(root, "config", "config.json")));

  await configure(root);
  const firstConfig = await readFile(
    path.join(root, "config", "config.json"),
    "utf8"
  );
  const firstState = await readFile(
    path.join(root, "config", "setup-state.json"),
    "utf8"
  );
  const reapplied = await invoke(root, [
    "setup",
    "apply",
    "--file",
    path.join(root, "plan.json"),
    "--non-interactive",
    "--json",
  ]);
  assert.equal(reapplied.exitCode, 0);
  assert.equal(
    await readFile(path.join(root, "config", "config.json"), "utf8"),
    firstConfig
  );
  assert.equal(
    await readFile(path.join(root, "config", "setup-state.json"), "utf8"),
    firstState
  );
  const status = JSON.parse(
    (await invoke(root, ["setup", "status", "--json"])).stdout
  );
  assert.equal(status.ready, true);
});

test("modified and incompatible plans fail closed with typed next actions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const planPath = await configure(root);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.provider_order = ["apollo"];
  await writeFile(planPath, JSON.stringify(plan), "utf8");
  const result = await invoke(root, [
    "setup",
    "apply",
    "--file",
    planPath,
    "--non-interactive",
    "--json",
  ]);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  const problem = JSON.parse(result.stderr);
  assert.equal(problem.problem.code, "config-invalid");
  assert.deepEqual(problem.next_actions[0].argv, [
    "kurobara",
    "setup",
    "inspect",
    "--json",
  ]);
});

test("legacy configuration migrates explicitly and unknown versions stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const configPath = path.join(root, "config", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      api_url: "http://127.0.0.1:3000",
      profile: "local",
      providers: ["prospeo", "hunter"],
      schema_version: "0.1.0",
    }),
    { mode: 0o600 }
  );
  const migrated = await invoke(root, ["setup", "migrate", "--json"]);
  assert.equal(migrated.exitCode, 0);
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).schema_version,
    "1.0.0"
  );

  await writeFile(
    configPath,
    JSON.stringify({ schema_version: "99.0.0" }),
    "utf8"
  );
  const incompatible = await invoke(root, ["setup", "status", "--json"]);
  assert.equal(incompatible.exitCode, 0);
  assert.equal(JSON.parse(incompatible.stdout).ready, false);
});

test("file secret backend redacts values, enforces permissions, and deletes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  const secret = "synthetic-provider-secret";
  const stored = await invoke(
    root,
    [
      "provider",
      "configure",
      "prospeo",
      "--from-env",
      "TEST_PROVIDER_SECRET",
      "--enable",
      "--json",
    ],
    { environment: { TEST_PROVIDER_SECRET: secret } }
  );
  assert.equal(stored.exitCode, 0);
  assert.equal(stored.stdout.includes(secret), false);
  assert.equal(stored.stderr.includes(secret), false);
  const secretPath = path.join(root, "data", "secrets.json");
  const details = await stat(secretPath);
  assert.equal(details.mode % 64, 0);

  const status = JSON.parse(
    (await invoke(root, ["secret", "status", "prospeo", "--json"])).stdout
  );
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes(secret), false);

  await chmod(secretPath, 0o644);
  const unsafe = await invoke(root, ["secret", "status", "prospeo", "--json"]);
  assert.equal(unsafe.exitCode, 3);
  assert.equal(JSON.parse(unsafe.stderr).problem.code, "config-permissions");
  await chmod(secretPath, 0o600);

  const deleted = await invoke(root, ["secret", "delete", "prospeo", "--json"]);
  assert.equal(deleted.exitCode, 0);
  assert.equal(JSON.parse(deleted.stdout).configured, false);
});

test("remote profiles refuse server provider secrets but allow client auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root, "remote");
  const provider = await invoke(
    root,
    [
      "provider",
      "configure",
      "prospeo",
      "--from-env",
      "TEST_PROVIDER_SECRET",
      "--json",
    ],
    { environment: { TEST_PROVIDER_SECRET: "synthetic-provider-secret" } }
  );
  assert.equal(provider.exitCode, 3);
  assert.equal(
    JSON.parse(provider.stderr).problem.code,
    "remote-secret-write-forbidden"
  );
  const client = await invoke(
    root,
    ["secret", "set", "kurobara", "--from-env", "TEST_CLIENT_SECRET", "--json"],
    { environment: { TEST_CLIENT_SECRET: "synthetic-client-secret" } }
  );
  assert.equal(client.exitCode, 0);
});

test("provider state preserves explicit admission and rights gates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  const listed = JSON.parse(
    (
      await invoke(root, ["provider", "list", "--json"], {
        environment: {
          APOLLO_API_KEY: "synthetic-apollo-key",
          EXA_API_KEY: "synthetic-exa-key",
        },
      })
    ).stdout
  );
  const apollo = listed.providers.find(
    (provider: { key: string }) => provider.key === "apollo"
  );
  const exa = listed.providers.find(
    (provider: { key: string }) => provider.key === "exa"
  );
  const pdl = listed.providers.find(
    (provider: { key: string }) => provider.key === "pdl"
  );
  assert.equal(apollo.state, "configured");
  assert.equal(exa.state, "rights_required");
  assert.equal(pdl.state, "unavailable");

  const probe = JSON.parse(
    (await invoke(root, ["provider", "probe", "apollo", "--json"])).stdout
  );
  assert.equal(probe.cost.amount, 0);
  assert.equal(probe.state, "unavailable");
});

test("doctor diagnoses healthy and unavailable runtime without exposing auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  const syntheticKey = "synthetic-client-secret";
  const configBefore = await readFile(
    path.join(root, "config", "config.json"),
    "utf8"
  );
  const requestedUrls: string[] = [];
  const healthy = await invoke(root, ["doctor", "--json"], {
    environment: { KUROBARA_API_KEY: syntheticKey },
    fetch: (input) => {
      requestedUrls.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  assert.equal(healthy.exitCode, 0);
  const healthyResult = JSON.parse(healthy.stdout);
  assert.equal(healthyResult.ready, true);
  assert.equal(healthyResult.profile_ready, false);
  assert.equal(healthyResult.operational_ready, false);
  assert.equal(healthyResult.business_context.ready, false);
  assert.equal(healthyResult.provider_credit_spend, 0);
  assert.equal(healthyResult.side_effects, "read_only");
  assert.equal(healthyResult.blocked_steps.includes("business_context"), false);
  assert.equal(
    healthyResult.next_actions.some(
      (nextAction: { argv: readonly string[] }) =>
        nextAction.argv.join(" ") ===
        "kurobara context setup --profile agentic_outbound_play"
    ),
    true
  );
  assert.equal(
    requestedUrls.some((url) => url.includes("/providers/")),
    false
  );
  assert.equal(
    await readFile(path.join(root, "config", "config.json"), "utf8"),
    configBefore
  );
  assert.equal(healthy.stdout.includes(syntheticKey), false);

  const unavailable = await invoke(root, ["doctor", "--json"], {
    fetch: () => Promise.reject(new Error("offline")),
  });
  assert.equal(unavailable.exitCode, 0);
  const unavailableResult = JSON.parse(unavailable.stdout);
  assert.equal(unavailableResult.ready, false);
  assert.ok(unavailableResult.blocked_steps.includes("api_health"));
  assert.ok(unavailableResult.blocked_steps.includes("client_authentication"));
});

test("update check is explicit, read-only, and machine-readable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const current = await invoke(root, ["update", "check", "--json"], {
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify([{ tag_name: "v0.1.0-rc.7" }]), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      ),
  });
  assert.equal(current.exitCode, 0);
  assert.equal(JSON.parse(current.stdout).update_available, false);

  const unavailable = await invoke(root, ["update", "check", "--json"], {
    fetch: () => Promise.reject(new Error("offline")),
  });
  assert.equal(unavailable.exitCode, 75);
  assert.equal(
    JSON.parse(unavailable.stderr).problem.code,
    "update-check-unavailable"
  );
});

test("agent mode never prompts and live execution requires explicit bounded approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const noTty = await invoke(root, ["setup", "--non-interactive", "--json"]);
  assert.equal(noTty.exitCode, 2);
  assert.equal(JSON.parse(noTty.stderr).problem.code, "cli-non-interactive");

  const confirmation = await invoke(root, ["first-run", "--live", "--json"]);
  assert.equal(confirmation.exitCode, 2);
  const confirmationProblem = JSON.parse(confirmation.stderr);
  assert.equal(confirmationProblem.requires_confirmation, true);
  assert.equal(confirmationProblem.next_actions[0].requires_confirmation, true);
});

test("offline first run returns a structured zero-credit receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  let request: ProcessRequest | undefined;
  const result = await invoke(root, ["first-run", "--offline", "--json"], {
    processRunner: (candidate) => {
      request = candidate;
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          application_id: "application_demo_org_website_v1",
          dataset_id: "dataset_demo_orgs",
          export: {
            byte_count: 128,
            format: "jsonl",
            retained: false,
            sha256: `sha256:${"a".repeat(64)}`,
          },
          ok: true,
          schema_version: "1.0.0",
        })}\n`,
      });
    },
  });
  assert.equal(result.exitCode, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.cost.amount, 0);
  assert.equal(receipt.ids.dataset_id, "dataset_demo_orgs");
  assert.equal(receipt.files[0].byte_count, 128);
  assert.equal(receipt.receipt.provider_calls, 0);
  assert.equal(request?.command, "bash");
  assert.deepEqual(request?.args, ["deploy/self-host/harness.sh"]);
});

test("offline first run reports an exact failed stage and a resumable argv", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const result = await invoke(root, ["first-run", "--offline", "--json"], {
    processRunner: () =>
      Promise.resolve({
        code: 1,
        stderr: `${JSON.stringify({
          ok: false,
          schema_version: "1.0.0",
          stage: "dataset_export",
        })}\n`,
        stdout: "",
      }),
  });
  assert.equal(result.exitCode, 75);
  const problem = JSON.parse(result.stderr);
  assert.deepEqual(problem.blocked_steps, ["first_run:dataset_export"]);
  assert.deepEqual(problem.next_actions[0].argv, [
    "kurobara",
    "first-run",
    "--offline",
    "--json",
  ]);
});

test("runtime exec injects referenced values only into the child environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  await invoke(
    root,
    ["secret", "set", "kurobara", "--from-env", "TEST_CLIENT_SECRET", "--json"],
    { environment: { TEST_CLIENT_SECRET: "synthetic-client-secret" } }
  );
  await invoke(
    root,
    [
      "secret",
      "set",
      "prospeo",
      "--from-env",
      "TEST_PROVIDER_SECRET",
      "--json",
    ],
    { environment: { TEST_PROVIDER_SECRET: "synthetic-provider-secret" } }
  );
  let childEnvironment: Readonly<Record<string, string | undefined>> = {};
  const executed = await invoke(
    root,
    ["runtime", "exec", "--", "synthetic-command", "arg"],
    {
      processRunner: (request) => {
        childEnvironment = request.environment;
        return Promise.resolve({ code: 0, stderr: "", stdout: "" });
      },
    }
  );
  assert.equal(executed.exitCode, 0);
  assert.equal(childEnvironment.KUROBARA_API_KEY, "synthetic-client-secret");
  assert.equal(childEnvironment.PROSPEO_API_KEY, "synthetic-provider-secret");
  assert.equal(executed.stdout.includes("synthetic-client-secret"), false);
  assert.equal(executed.stdout.includes("synthetic-provider-secret"), false);
});

test("human TTY uses the Kurobara visual identity and applies only after yes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  const input = Object.assign(Readable.from(["local\n", "yes\n"]), {
    isTTY: true,
  });
  const result = await invoke(root, ["setup", "--no-motion"], {
    stdin: input,
    tty: true,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, BRAND_PATTERN);
  assert.match(result.stdout, DOT_FLOW_PATTERN);
  assert.match(result.stdout, WRITE_CONFIRMATION_PATTERN);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "config", "config.json"), "utf8"))
      .profile,
    "local"
  );
});

test("guided Context setup plans, reviews, and applies only after explicit human confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const requestBodies: unknown[] = [];
  const questions = {
    profile: "agentic_outbound_play",
    questionnaire_version: "1.0.0",
    questions: [
      {
        answer_schema: { type: "string" },
        prompt: "What do you sell?",
        question_id: "offer.summary",
        required_for: ["agentic_outbound_play"],
        requires_human_confirmation: false,
        section: "offer",
        sensitivity: "business",
      },
      {
        answer_schema: { type: "boolean" },
        prompt: "Prepare a private export?",
        question_id: "activation.private_export_requested",
        required_for: ["agentic_outbound_play"],
        requires_human_confirmation: true,
        section: "activation",
        sensitivity: "policy",
      },
      {
        answer_schema: { type: "boolean" },
        ask_if: {
          equals: true,
          question_id: "activation.private_export_requested",
        },
        prompt: "Is the destination approved?",
        question_id: "policy.export_destination_approved",
        required_for: ["agentic_outbound_play"],
        requires_human_confirmation: true,
        section: "policy",
        sensitivity: "policy",
      },
    ],
  };
  const input = Object.assign(
    Readable.from([
      "\n",
      "\n",
      "Synthetic enrichment service\n",
      "no\n",
      "APPLY\n",
    ]),
    { isTTY: true }
  );
  const result = await invoke(
    root,
    ["context", "setup", "--profile", "agentic_outbound_play", "--no-motion"],
    {
      environment: { KUROBARA_API_KEY: "synthetic-client-secret" },
      fetch: (input_, init) => {
        const url = String(input_);
        if (init?.body !== undefined) {
          requestBodies.push(JSON.parse(String(init.body)));
        }
        if (url.includes("gtm-context-questionnaires")) {
          return Promise.resolve(Response.json(questions));
        }
        if (url.includes("gtm-context-status")) {
          return Promise.resolve(
            Response.json({
              business_context: "missing",
              profile: "agentic_outbound_play",
              ready: false,
              remediation: ["Create a Context."],
            })
          );
        }
        if (url.endsWith("/v1/gtm-context-plans")) {
          const context = (requestBodies.at(-1) as { context: unknown })
            .context;
          return Promise.resolve(
            Response.json({
              blocking_question_ids: [],
              context,
              fingerprint,
              issues: [],
              mode: "plan",
              ready_for: {
                agentic_outbound_play: true,
                dataset_import: true,
                imported_dataset_enrichment: false,
                offline_fixture: true,
              },
            })
          );
        }
        if (url.endsWith("/v1/gtm-context-revisions")) {
          const context = (requestBodies.at(-1) as { context: unknown })
            .context;
          return Promise.resolve(
            Response.json({
              active: true,
              mode: "apply",
              revision: {
                context,
                context_id: "gtm-primary",
                created_at_ms: 1,
                created_by_actor_id: "actor-test",
                fingerprint,
                revision: 1,
                workspace_id: "workspace-test",
              },
              status: "created",
            })
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      },
      stdin: input,
      tty: true,
    }
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, GTM_CONTEXT_PATTERN);
  assert.match(result.stdout, FINGERPRINT_PATTERN);
  assert.match(result.stdout, CONTEXT_STORED_PATTERN);
  assert.equal(requestBodies.length, 2);
  const plan = requestBodies[0] as {
    context: {
      assertions: readonly {
        provenance: { source: string };
        question_id: string;
        state: string;
      }[];
    };
  };
  assert.deepEqual(
    plan.context.assertions.map((answer) => answer.question_id),
    ["offer.summary", "activation.private_export_requested"]
  );
  assert.equal(
    plan.context.assertions.every(
      (answer) =>
        answer.provenance.source === "human" && answer.state === "confirmed"
    ),
    true
  );
  assert.deepEqual(requestBodies[1], {
    activate: true,
    confirm_active_change: false,
    confirmed: true,
    context: (requestBodies[0] as { context: unknown }).context,
    mode: "apply",
    plan_fingerprint: fingerprint,
  });
});

test("masked TTY secret entry never echoes the value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-onboarding-"));
  await configure(root);
  const input = new PassThrough() as PassThrough &
    OnboardingReadable & {
      isTTY: boolean;
      setRawMode: (mode: boolean) => void;
    };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const pending = invoke(root, ["secret", "set", "prospeo"], {
    stdin: input,
    tty: true,
  });
  setImmediate(() => input.write("masked-synthetic-secret\n"));
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("masked-synthetic-secret"), false);
  assert.equal(result.stderr.includes("masked-synthetic-secret"), false);
  assert.match(result.stderr, MASK_PATTERN);
});
