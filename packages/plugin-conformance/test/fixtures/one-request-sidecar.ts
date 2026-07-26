import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import {
  definePluginAdapter,
  type PluginManifestV1,
} from "@kurobara/plugin-sdk";

import {
  FIXTURE_EXTERNAL_ID_MANIFEST,
  FIXTURE_LOOKUP_ONLY_MANIFEST,
  FIXTURE_MANIFEST,
  FIXTURE_ONE_SHOT_MANIFEST,
  FIXTURE_OPERATION_KEY,
  FIXTURE_RECORD_VALUE,
  FIXTURE_TIMEOUT_MANIFEST,
  type FixtureEffectState,
} from "./fixture-values.ts";

const mode = process.argv[2] ?? "good";
const statePath = process.argv[3];
const canary = process.argv[4] ?? "synthetic-conformance-canary";
const pidLog = process.argv[5];
let fixtureManifest: PluginManifestV1 = FIXTURE_MANIFEST;
if (
  mode === "external-id" ||
  mode === "external-id-always-found" ||
  mode === "external-id-operation-key-only"
) {
  fixtureManifest = FIXTURE_EXTERNAL_ID_MANIFEST;
} else if (mode === "lookup-only-undefined-reference") {
  fixtureManifest = FIXTURE_LOOKUP_ONLY_MANIFEST;
} else if (mode === "one-shot") {
  fixtureManifest = FIXTURE_ONE_SHOT_MANIFEST;
} else if (mode === "timeout" || mode === "second-execute-timeout") {
  fixtureManifest = FIXTURE_TIMEOUT_MANIFEST;
}

if (!(statePath && statePath.length > 0)) {
  throw new Error("The fixture requires an absolute effect-state path.");
}
if (pidLog) {
  appendFileSync(pidLog, `${process.pid}\n`, "utf8");
}

const readState = (): FixtureEffectState => {
  if (!existsSync(statePath)) {
    return { executeInvocations: 0, lookupInvocations: 0, operationKeys: [] };
  }
  return JSON.parse(readFileSync(statePath, "utf8")) as FixtureEffectState;
};

const writeEffect = (operationKey: string, allowDuplicate: boolean): void => {
  const state = readState();
  if (!allowDuplicate && state.operationKeys.includes(operationKey)) {
    return;
  }
  writeFileSync(
    statePath,
    `${JSON.stringify({
      executeInvocations: state.executeInvocations ?? 0,
      lookupInvocations: state.lookupInvocations ?? 0,
      operationKeys: [...state.operationKeys, operationKey],
    })}\n`,
    "utf8"
  );
};

const recordInvocation = (method: "execute" | "lookup"): void => {
  const state = readState();
  writeFileSync(
    statePath,
    `${JSON.stringify({
      executeInvocations:
        (state.executeInvocations ?? 0) + (method === "execute" ? 1 : 0),
      lookupInvocations:
        (state.lookupInvocations ?? 0) + (method === "lookup" ? 1 : 0),
      operationKeys: state.operationKeys,
    })}\n`,
    "utf8"
  );
};

const usage = {
  amount: 1,
  basis: "exact",
  receiptReference: "receipt:conformance:fixture",
  unit: "credits",
} as const;

const adapter = definePluginAdapter({
  classifyError: () => ({
    error: { class: "unknown", reasonCode: "unclassified" },
  }),
  describe: () => ({ manifest: fixtureManifest }),
  estimate: (request) => ({
    quote: {
      expiresAtMs: request.context.deadlineAtMs,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    status: "quoted",
  }),
  execute: async (request) => {
    recordInvocation("execute");
    const alreadyDelivered = readState().operationKeys.includes(
      request.operationKey
    );
    if (
      mode === "timeout" ||
      (mode === "second-execute-timeout" && alreadyDelivered)
    ) {
      return await new Promise<never>(() => undefined);
    }
    writeEffect(request.operationKey, mode === "double-effect");
    const externalOperationReference =
      mode === "redelivery-reference-drift" && alreadyDelivered
        ? `fixture:drift:${request.operationKey}`
        : `fixture:${request.operationKey}`;
    return {
      ...(mode === "undefined-reference" ||
      mode === "lookup-only-undefined-reference"
        ? {}
        : { externalOperationReference }),
      providerPayload:
        mode === "redaction" ? { forbidden: canary } : FIXTURE_RECORD_VALUE,
      status: "succeeded",
      usage,
    };
  },
  health: (request) => ({
    observedAtMs: request.context.deadlineAtMs,
    status: "healthy",
    validUntilMs: request.context.deadlineAtMs,
  }),
  lookup: (request) => {
    recordInvocation("lookup");
    const usesExternalOperationId =
      mode === "external-id" ||
      mode === "external-id-always-found" ||
      mode === "external-id-operation-key-only";
    const expectedExternalReference = `fixture:${FIXTURE_OPERATION_KEY}`;
    if (
      usesExternalOperationId &&
      request.externalOperationReference !== expectedExternalReference &&
      mode !== "external-id-always-found" &&
      mode !== "external-id-operation-key-only"
    ) {
      return {
        proof: {
          observedAtMs: request.context.deadlineAtMs,
          proofReference: `proof:absent:${request.operationKey}`,
        },
        status: "authoritative-absent" as const,
      };
    }
    if (
      !usesExternalOperationId &&
      request.operationKey !== FIXTURE_OPERATION_KEY &&
      mode !== "lookup-always-found" &&
      mode !== "external-id-always-found"
    ) {
      return {
        proof: {
          observedAtMs: request.context.deadlineAtMs,
          proofReference: `proof:absent:${request.operationKey}`,
        },
        status: "authoritative-absent" as const,
      };
    }
    if (mode === "lookup-effect") {
      writeEffect(request.operationKey, true);
    }
    if (mode === "lookup-failed-outcome") {
      return {
        outcome: {
          error: { class: "provider", reasonCode: "provider-rejected" },
          status: "failed" as const,
          usage,
        },
        proof: {
          observedAtMs: request.context.deadlineAtMs,
          proofReference: `proof:${request.operationKey}`,
        },
        status: "found" as const,
      };
    }
    const externalOperationReference =
      mode === "lookup-reference-drift"
        ? `fixture:lookup-drift:${request.operationKey}`
        : (request.externalOperationReference ??
          `fixture:${request.operationKey}`);
    return {
      outcome: {
        ...(mode === "undefined-reference" ||
        mode === "lookup-only-undefined-reference"
          ? {}
          : { externalOperationReference }),
        providerPayload: FIXTURE_RECORD_VALUE,
        status: "succeeded",
        usage,
      },
      proof: {
        observedAtMs: request.context.deadlineAtMs,
        proofReference: `proof:${request.operationKey}`,
      },
      status: "found",
    };
  },
  normalize: (request) => ({
    normalizerVersion: "1.0.0",
    output: request.providerPayload,
    status: "normalized",
  }),
  validateConfig: (request) => ({
    configurationFingerprint: request.configuration.contentHash,
    status: "valid",
  }),
});

const chunks: string[] = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => chunks.push(chunk));
await once(process.stdin, "end");

const lines = chunks
  .join("")
  .split("\n")
  .filter((line) => line.length > 0);
if (lines.length !== 1) {
  throw new Error("The fixture accepts exactly one request per process.");
}

const frame = JSON.parse(lines[0] ?? "null") as {
  readonly id?: unknown;
  readonly jsonrpc?: unknown;
  readonly method?: unknown;
  readonly params?: {
    readonly apiVersion?: unknown;
    readonly direction?: unknown;
    readonly method?: keyof typeof adapter;
    readonly payload?: unknown;
  };
};
const message = frame.params;
const method = message?.method;
if (
  frame.jsonrpc !== "2.0" ||
  typeof frame.id !== "string" ||
  frame.method !== `plugin.${method}` ||
  message?.apiVersion !== "dev.kurobara.plugin-protocol/v1" ||
  message.direction !== "request" ||
  !method ||
  typeof adapter[method] !== "function"
) {
  throw new Error("The fixture received an invalid request frame.");
}

const payload =
  method === "describe"
    ? adapter.describe()
    : await Reflect.apply(adapter[method], undefined, [message.payload]);

let resultPayload = payload;
if (mode === "invalid-response" && method === "health") {
  resultPayload = { status: "healthy" };
} else if (mode === "invalid-error" && method === "classifyError") {
  resultPayload = { error: { class: "unknown", reasonCode: canary } };
}

process.stdout.write(
  `${JSON.stringify({
    id: frame.id,
    jsonrpc: "2.0",
    result: {
      apiVersion: message.apiVersion,
      direction: "result",
      method,
      payload: resultPayload,
    },
  })}\n`
);
