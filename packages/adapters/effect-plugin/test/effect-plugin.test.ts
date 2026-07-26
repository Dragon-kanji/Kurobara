import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptId,
  capabilityId,
  contentHash,
  instant,
  operationKey,
  routingDecisionId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import {
  definePluginAdapter,
  type PluginAdapterV1,
  type PluginManifestV1,
} from "@kurobara/plugin-sdk";
import type { LeafEffectRequest } from "@kurobara/ports";

import {
  createTrustedPluginLeafEffect,
  PluginLeafEffectConfigurationError,
  type TrustedPluginLeafEffectOptions,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);

const INPUT_CONTRACT = Object.freeze({
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("b"),
  schemaId:
    "https://schemas.kurobara.invalid/schemas/organizations/website-resolve-input/1.0.0",
  schemaVersion: "1.0.0",
});

const OUTPUT_CONTRACT = Object.freeze({
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("c"),
  schemaId:
    "https://schemas.kurobara.invalid/schemas/organizations/website-resolve-output/1.0.0",
  schemaVersion: "1.0.0",
});

const CAPABILITY = Object.freeze({
  capabilityId: capabilityId("organizations.website.resolve"),
  capabilityVersion: "1.0.0",
});

const CONFIGURATION = Object.freeze({
  contentHash: hash("d"),
  value: Object.freeze({ searchDepth: "basic" }),
});

const manifestFor = (
  lookupMode: "by-operation-key" | "none" = "by-operation-key"
): PluginManifestV1 => ({
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["api-key-header"] },
  capabilities: [
    {
      ...CAPABILITY,
      inputContract: INPUT_CONTRACT,
      outputContract: OUTPUT_CONTRACT,
    },
  ],
  economics: {
    estimateGuarantee: "hard",
    unit: "requests",
    usageReporting: "exact",
  },
  execution:
    lookupMode === "none"
      ? {
          idempotency: { keyScope: "operation", mode: "none" },
          lookup: { authoritativeNotFound: false, mode: "none" },
          timeouts: { executeMs: 1000, lookupMs: 1000 },
        }
      : {
          idempotency: { keyScope: "operation", mode: "native-key" },
          lookup: {
            authoritativeNotFound: true,
            mode: "by-operation-key",
          },
          timeouts: { executeMs: 1000, lookupMs: 1000 },
        },
  id: "dev.kurobara.trusted-provider-fixture",
  permissions: {
    egress: { hosts: ["api.example.com"], tlsRequired: true },
  },
  version: "1.0.0",
});

type OverridableMethod = "estimate" | "execute" | "lookup" | "normalize";
type AdapterOverrides = Partial<Pick<PluginAdapterV1, OverridableMethod>>;

const createAdapterFixture = (options?: {
  readonly manifest?: PluginManifestV1;
  readonly overrides?: AdapterOverrides;
}) => {
  const calls = { estimate: 0, execute: 0, lookup: 0, normalize: 0 };
  const manifest = options?.manifest ?? manifestFor();
  const overrides = options?.overrides;
  const credentialCanary = "synthetic-key-held-only-by-provider-closure";

  const adapter = definePluginAdapter({
    classifyError: () => ({
      error: { class: "unknown", reasonCode: "unclassified" },
    }),
    describe: () => ({ manifest }),
    estimate: (request) => {
      calls.estimate += 1;
      return (
        overrides?.estimate?.(request) ?? {
          quote: {
            expiresAtMs: request.context.deadlineAtMs,
            guarantee: "hard",
            pricingVersion: "1.0.0",
            unit: "requests",
            upperBound: 1,
          },
          status: "quoted",
        }
      );
    },
    execute: (request) => {
      calls.execute += 1;
      if (overrides?.execute !== undefined) {
        return overrides.execute(request);
      }
      if (credentialCanary.length === 0) {
        throw new Error("The synthetic provider credential is unavailable.");
      }
      return {
        externalOperationReference: "provider-operation-reference",
        providerPayload: {
          candidateDomain: "example.org",
          privateProviderField: "must-not-escape",
        },
        status: "succeeded",
        usage: {
          amount: 1,
          basis: "exact",
          receiptReference: "provider-receipt",
          unit: "requests",
        },
      };
    },
    health: (request) => ({
      observedAtMs: request.context.deadlineAtMs,
      status: "healthy",
      validUntilMs: request.context.deadlineAtMs,
    }),
    lookup: (request) => {
      calls.lookup += 1;
      if (overrides?.lookup !== undefined) {
        return overrides.lookup(request);
      }
      return {
        outcome: {
          externalOperationReference: "provider-operation-reference",
          providerPayload: { candidateDomain: "example.org" },
          status: "succeeded",
          usage: {
            amount: 1,
            basis: "exact",
            receiptReference: "provider-receipt",
            unit: "requests",
          },
        },
        proof: {
          observedAtMs: request.context.deadlineAtMs,
          proofReference: "provider-proof-reference",
        },
        status: "found",
      };
    },
    normalize: (request) => {
      calls.normalize += 1;
      if (overrides?.normalize !== undefined) {
        return overrides.normalize(request);
      }
      const payload = request.providerPayload as {
        readonly candidateDomain?: unknown;
      };
      return typeof payload.candidateDomain === "string"
        ? {
            normalizerVersion: "1.0.0",
            output: { domain: payload.candidateDomain },
            status: "normalized",
          }
        : {
            error: {
              class: "response",
              reasonCode: "provider-response-invalid",
            },
            status: "failed",
          };
    },
    validateConfig: (request) => ({
      configurationFingerprint: request.configuration.contentHash,
      status: "valid",
    }),
  });

  return { adapter, calls, credentialCanary };
};

const REQUEST: LeafEffectRequest = Object.freeze({
  attemptId: attemptId("attempt-plugin"),
  operationKey: operationKey("operation-plugin"),
  reservationUnit: "requests",
  reservedAmount: 1,
  routeSnapshotHash: hash("e"),
  routingDecisionId: routingDecisionId("routing-plugin"),
  runId: runId("run-plugin"),
  runInput: Object.freeze({
    classification: "internal",
    contentHash: hash("f"),
    contract: INPUT_CONTRACT,
    finalizedAt: instant(900),
    inputId: "input-plugin",
    mediaType: "application/json",
    sizeBytes: 26,
    validatedAt: instant(900),
    validatorVersion: "fixture-validator-1",
    value: Object.freeze({ organization: "Example" }),
  }),
  stepRunId: stepRunId("step-plugin"),
  workspaceId: workspaceId("workspace-plugin"),
});

const createPort = async (
  fixture: ReturnType<typeof createAdapterFixture>,
  overrides?: Readonly<{
    beforeExecute?: TrustedPluginLeafEffectOptions["beforeExecute"];
    deadlineAtMs?: number;
    inputContract?: typeof INPUT_CONTRACT;
    outputContract?: typeof OUTPUT_CONTRACT;
  }>
) =>
  await createTrustedPluginLeafEffect({
    adapter: fixture.adapter,
    adapterKey: "trusted-provider",
    ...(overrides?.beforeExecute === undefined
      ? {}
      : { beforeExecute: overrides.beforeExecute }),
    capability: CAPABILITY,
    clock: () => 1000,
    configuration: CONFIGURATION,
    deadlineAtMs: () => overrides?.deadlineAtMs ?? 5000,
    inputContract: overrides?.inputContract ?? INPUT_CONTRACT,
    outputContract: overrides?.outputContract ?? OUTPUT_CONTRACT,
  });

test("estimates, executes, and returns only normalized output", async () => {
  const fixture = createAdapterFixture();
  const port = await createPort(fixture);

  const outcome = await port.execute(REQUEST);

  assert.deepEqual(outcome, {
    output: { domain: "example.org" },
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "requests",
      usageEntryId: "usage:plugin:trusted-provider:attempt-plugin",
    },
    status: "succeeded",
  });
  assert.deepEqual(fixture.calls, {
    estimate: 1,
    execute: 1,
    lookup: 0,
    normalize: 1,
  });
  const serialized = JSON.stringify({ outcome, port });
  assert.equal(serialized.includes("must-not-escape"), false);
  assert.equal(serialized.includes(fixture.credentialCanary), false);
});

test("releases the reservation when estimation fails before send", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      estimate: () => ({
        error: { class: "quota", reasonCode: "quota-exhausted" },
        status: "unavailable",
      }),
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-quota-exhausted",
    retryable: false,
    settlement: { kind: "release" },
    status: "failed",
  });
  assert.equal(fixture.calls.execute, 0);
  assert.equal(fixture.calls.normalize, 0);
});

test("runs the JIT authorization after quote and before provider execution", async () => {
  const fixture = createAdapterFixture();
  let authorizationCalls = 0;
  const port = await createPort(fixture, {
    beforeExecute: (request) => {
      authorizationCalls += 1;
      assert.equal(request.attemptId, REQUEST.attemptId);
      assert.equal(fixture.calls.estimate, 1);
      assert.equal(fixture.calls.execute, 0);
      return Promise.resolve({
        reason: "contact-privacy-denied" as const,
        retryable: false,
        settlement: { kind: "release" as const },
        status: "failed" as const,
      });
    },
  });

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "contact-privacy-denied",
    retryable: false,
    settlement: { kind: "release" },
    status: "failed",
  });
  assert.equal(authorizationCalls, 1);
  assert.equal(fixture.calls.estimate, 1);
  assert.equal(fixture.calls.execute, 0);
  assert.equal(fixture.calls.normalize, 0);
});

test("keeps an ambiguous execution terminally unknown without retry or fallback", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      execute: () => ({
        error: { class: "adapter", reasonCode: "adapter-fault" },
        status: "outcome-unknown",
      }),
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-execution-outcome-unknown",
    status: "outcome-unknown",
  });
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.lookup, 0);
  assert.equal(fixture.calls.normalize, 0);
});

test("maps a definitive provider failure and its known usage", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      execute: () => ({
        error: { class: "provider", reasonCode: "provider-rejected" },
        status: "failed",
        usage: {
          amount: 1,
          basis: "exact",
          receiptReference: "provider-failure-receipt",
          unit: "requests",
        },
      }),
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-provider-rejected",
    retryable: false,
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "requests",
      usageEntryId: "usage:plugin:trusted-provider:attempt-plugin",
    },
    status: "failed",
  });
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.normalize, 0);
});

test("makes a definite empty provider result retryable after settling usage", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      execute: () => ({
        error: { class: "provider", reasonCode: "provider-unavailable" },
        status: "failed",
        usage: {
          amount: 1,
          basis: "exact",
          receiptReference: "provider-empty-result-receipt",
          unit: "requests",
        },
      }),
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-provider-unavailable",
    retryable: true,
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "requests",
      usageEntryId: "usage:plugin:trusted-provider:attempt-plugin",
    },
    status: "failed",
  });
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.normalize, 0);
});

test("keeps post-effect usage above the reservation ambiguous", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      execute: () => ({
        providerPayload: { candidateDomain: "example.org" },
        status: "succeeded",
        usage: {
          amount: 2,
          basis: "exact",
          receiptReference: "provider-overage-receipt",
          unit: "requests",
        },
      }),
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-usage-incoherent",
    status: "outcome-unknown",
  });
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.normalize, 0);
});

test("settles known usage but fails closed when normalized output is invalid", async () => {
  const fixture = createAdapterFixture({
    overrides: {
      normalize: () => ({ status: "normalized" }) as never,
    },
  });
  const port = await createPort(fixture);

  assert.deepEqual(await port.execute(REQUEST), {
    reason: "plugin-output-invalid",
    retryable: false,
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "requests",
      usageEntryId: "usage:plugin:trusted-provider:attempt-plugin",
    },
    status: "failed",
  });
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.calls.normalize, 1);
});

test("one-shot lookup returns unknown without invoking the provider lookup", async () => {
  const fixture = createAdapterFixture({ manifest: manifestFor("none") });
  const port = await createPort(fixture);

  assert.deepEqual(await port.lookup(REQUEST), {
    reason: "plugin-lookup-outcome-unknown",
    status: "outcome-unknown",
  });
  assert.equal(fixture.calls.lookup, 0);
  assert.equal(fixture.calls.normalize, 0);
});

test("maps durable lookup proof and usage identities deterministically", async () => {
  const firstFixture = createAdapterFixture();
  const secondFixture = createAdapterFixture();
  const firstPort = await createPort(firstFixture);
  const secondPort = await createPort(secondFixture);

  const first = await firstPort.lookup(REQUEST);
  const second = await secondPort.lookup(REQUEST);

  assert.deepEqual(first, second);
  assert.equal(first.status, "found");
  if (first.status === "found") {
    assert.equal(first.proofId, "proof:plugin:trusted-provider:attempt-plugin");
    assert.equal(
      first.outcome.settlement.kind === "settle"
        ? first.outcome.settlement.usageEntryId
        : undefined,
      "usage:plugin:trusted-provider:attempt-plugin"
    );
  }
});

test("rejects manifest and contract bindings that cannot be honored", async () => {
  const unsupportedEconomics = {
    ...manifestFor(),
    economics: {
      estimateGuarantee: "hard",
      unit: "credits",
      usageReporting: "exact",
    },
  } as const satisfies PluginManifestV1;

  await assert.rejects(
    createPort(createAdapterFixture({ manifest: unsupportedEconomics })),
    (error: unknown) =>
      error instanceof PluginLeafEffectConfigurationError &&
      error.reasonCode === "manifest-economics-unsupported"
  );
  await assert.rejects(
    createPort(createAdapterFixture(), {
      outputContract: {
        ...OUTPUT_CONTRACT,
        schemaFingerprint: hash("9"),
      },
    }),
    (error: unknown) =>
      error instanceof PluginLeafEffectConfigurationError &&
      error.reasonCode === "capability-contract-mismatch"
  );
});

test("refuses expired deadlines, excess reservations, and incoherent quotes before send", async () => {
  const expiredFixture = createAdapterFixture();
  const expiredPort = await createPort(expiredFixture, { deadlineAtMs: 1000 });
  assert.equal((await expiredPort.execute(REQUEST)).status, "failed");
  assert.equal(expiredFixture.calls.estimate, 0);

  const budgetFixture = createAdapterFixture();
  const budgetPort = await createPort(budgetFixture);
  assert.equal(
    (
      await budgetPort.execute({
        ...REQUEST,
        reservedAmount: 2,
      })
    ).status,
    "failed"
  );
  assert.equal(budgetFixture.calls.estimate, 0);

  const quoteFixture = createAdapterFixture({
    overrides: {
      estimate: () => ({
        quote: {
          expiresAtMs: 5000,
          guarantee: "hard",
          pricingVersion: "1.0.0",
          unit: "requests",
          upperBound: 1,
        },
        status: "quoted",
      }),
    },
  });
  const quotePort = await createPort(quoteFixture);
  assert.equal((await quotePort.execute(REQUEST)).status, "failed");
  assert.equal(quoteFixture.calls.execute, 0);
});
