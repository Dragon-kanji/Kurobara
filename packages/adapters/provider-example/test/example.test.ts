import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_ADAPTER_METHODS,
  PluginAdapterProtocolError,
} from "@kurobara/plugin-sdk";

import {
  PROVIDER_EXAMPLE_LOOKUP_KEYS,
  providerExampleAdapter,
} from "../src/index.ts";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const context = {
  capability: {
    capabilityId: "fixture.echo",
    capabilityVersion: "1.0.0",
  },
  configuration: {
    contentHash: hash("d"),
    value: { mode: "echo" },
  },
  deadlineAtMs: 10_000,
};

const record = {
  dataset_id: "synthetic-dataset",
  record_id: "synthetic-record",
  values: [{ field_id: "message", value: "synthetic" }],
  workspace_id: "synthetic-workspace",
};

const input = {
  contentHash: hash("e"),
  contract: {
    catalogFingerprint:
      "sha256:1466e9c9bff8bc3c3f3c5e330a5770cb57429cb03bd9a75cc0701c9a71c9744e",
    catalogVersion: "0.13.0",
    schemaFingerprint:
      "sha256:9c1fed09cc7cc924ac5e824ea07fcefc738fd78265075c7c37e5bd935b2c5d78",
    schemaId: "https://schemas.kurobara.invalid/schemas/product/record/1.0.0",
    schemaVersion: "1.0.0",
  },
  sizeBytes: new TextEncoder().encode(JSON.stringify(record)).byteLength,
  value: record,
};

const quote = {
  expiresAtMs: 10_000,
  guarantee: "hard",
  pricingVersion: "1.0.0",
  unit: "requests",
  upperBound: 1,
} as const;

test("exposes exactly the frozen V1 surface and validated manifest", () => {
  assert.deepEqual(
    Object.keys(providerExampleAdapter).sort(),
    [...PLUGIN_ADAPTER_METHODS].sort()
  );
  assert.equal(Object.isFrozen(providerExampleAdapter), true);

  const described = providerExampleAdapter.describe();
  assert.equal(described.manifest.id, "dev.kurobara.provider-example");
  assert.deepEqual(described.manifest.permissions.egress.hosts, []);
  assert.equal(Object.isFrozen(described), true);
  assert.equal(Object.isFrozen(described.manifest), true);
});

test("validates configuration and returns one deterministic hard quote", async () => {
  assert.deepEqual(
    await providerExampleAdapter.validateConfig({
      capability: context.capability,
      configuration: context.configuration,
    }),
    { configurationFingerprint: hash("d"), status: "valid" }
  );
  assert.deepEqual(
    await providerExampleAdapter.validateConfig({
      capability: context.capability,
      configuration: {
        contentHash: hash("f"),
        value: { mode: "other" },
      },
    }),
    {
      reasonCodes: ["configuration-value-invalid"],
      status: "invalid",
    }
  );

  const request = { context, input };
  const first = await providerExampleAdapter.estimate(request);
  const second = await providerExampleAdapter.estimate(request);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    quote: {
      expiresAtMs: 10_000,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "requests",
      upperBound: 1,
    },
    status: "quoted",
  });
});

test("preserves the exact operation key and remains deterministic", async () => {
  const request = {
    context,
    costLimit: { amount: 1, unit: "requests" },
    input,
    operationKey: "synthetic:operation-key",
    quote,
  };
  const first = await providerExampleAdapter.execute(request);
  const second = await providerExampleAdapter.execute(request);

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    externalOperationReference: "synthetic-operation-reference",
    providerPayload: {
      adapter: "deterministic-local",
      attempt_id: "synthetic-attempt",
      operation_key: request.operationKey,
      run_id: "synthetic-run",
      status: "succeeded",
      step_run_id: "synthetic-step-run",
    },
    status: "succeeded",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "synthetic-receipt",
      unit: "requests",
    },
  });
  assert.equal(Object.isFrozen(first), true);
  await assert.rejects(
    async () =>
      await providerExampleAdapter.execute({
        ...request,
        costLimit: { amount: 0, unit: "requests" },
      }),
    (error: unknown) =>
      error instanceof PluginAdapterProtocolError &&
      error.method === "execute" &&
      error.reasonCode === "plugin-protocol-semantic-invalid"
  );
});

test("exposes all four lookup statuses without external state", async () => {
  const statuses = await Promise.all(
    Object.values(PROVIDER_EXAMPLE_LOOKUP_KEYS).map(async (operationKey) =>
      providerExampleAdapter.lookup({ context, operationKey })
    )
  );
  assert.deepEqual(statuses.map((result) => result.status).sort(), [
    "authoritative-absent",
    "eventual-not-found",
    "found",
    "outcome-unknown",
  ]);
  assert.equal(
    JSON.stringify(statuses).includes(PROVIDER_EXAMPLE_LOOKUP_KEYS.found),
    true
  );
});

test("normalizes immutable JSON and classifies diagnostics without leakage", async () => {
  const providerPayload = {
    adapter: "deterministic-local",
    attempt_id: "synthetic-attempt",
    operation_key: "synthetic:normalize",
    run_id: "synthetic-run",
    status: "succeeded",
    step_run_id: "synthetic-step-run",
  };
  const normalized = await providerExampleAdapter.normalize({
    context,
    operationKey: "synthetic:normalize",
    outputContract: {
      catalogFingerprint:
        "sha256:1466e9c9bff8bc3c3f3c5e330a5770cb57429cb03bd9a75cc0701c9a71c9744e",
      catalogVersion: "0.13.0",
      schemaFingerprint:
        "sha256:02f08ae5cb4775e420fcc1c4ce468943e497ef430da7e03d7be0b6a91e060d8e",
      schemaId:
        "https://schemas.kurobara.invalid/schemas/fixtures/deterministic-output/1.0.0",
      schemaVersion: "1.0.0",
    },
    providerPayload,
  });
  assert.equal(normalized.status, "normalized");
  assert.equal(Object.isFrozen(normalized), true);
  providerPayload.operation_key = "changed";
  assert.equal(JSON.stringify(normalized).includes("changed"), false);

  const canary = "synthetic-classification-canary";
  const classified = await providerExampleAdapter.classifyError({
    context,
    diagnostic: { kind: "provider-code", providerCode: canary },
    phase: "execute",
  });
  assert.deepEqual(classified, { error: { ...safeClassification } });
  assert.equal(JSON.stringify(classified).includes(canary), false);

  assert.deepEqual(await providerExampleAdapter.health({ context }), {
    observedAtMs: 10_000,
    status: "healthy",
    validUntilMs: 10_000,
  });
});

const safeClassification = {
  class: "unknown",
  reasonCode: "unclassified",
} as const;
