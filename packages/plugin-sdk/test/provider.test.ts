import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  definePluginAdapter,
  PLUGIN_ADAPTER_METHODS,
  PluginAdapterDefinitionError,
  PluginAdapterInvocationError,
  PluginAdapterProtocolError,
  type PluginAdapterV1,
  type PluginLookupRequest,
  type PluginManifestV1,
  validatePluginManifest,
  validatePluginProtocolMessage,
} from "../src/index.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const readManifest = async (): Promise<PluginManifestV1> => {
  const candidate: unknown = JSON.parse(
    await readFile(
      path.resolve(
        packageRoot,
        "../contracts/catalog/fixtures/plugin-manifest/valid/minimal.json"
      ),
      "utf8"
    )
  );
  const result = validatePluginManifest(candidate);
  if (!result.ok) {
    throw new Error("The canonical plugin manifest fixture must be valid.");
  }
  return result.manifest;
};

const readOneShotManifest = async (): Promise<PluginManifestV1> => {
  const candidate: unknown = JSON.parse(
    await readFile(
      path.resolve(
        packageRoot,
        "../contracts/catalog/fixtures/plugin-manifest/valid/one-shot.json"
      ),
      "utf8"
    )
  );
  const result = validatePluginManifest(candidate);
  if (!result.ok) {
    throw new Error("The canonical one-shot plugin manifest must be valid.");
  }
  return result.manifest;
};

const safeError = {
  class: "unknown",
  reasonCode: "unclassified",
} as const;

const ambiguousError = {
  class: "adapter",
  reasonCode: "adapter-fault",
} as const;

const validDefinition = (manifest: PluginManifestV1): PluginAdapterV1 => ({
  classifyError: () => ({ error: safeError }),
  describe: () => ({ manifest }),
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
  execute: (request) => ({
    providerPayload: { operationKey: request.operationKey },
    status: "succeeded",
    usage: { amount: 1, basis: "exact", unit: "credits" },
  }),
  health: (request) => ({
    observedAtMs: request.context.deadlineAtMs,
    status: "healthy",
    validUntilMs: request.context.deadlineAtMs,
  }),
  lookup: (request) => ({
    proof: {
      observedAtMs: request.context.deadlineAtMs,
      proofReference: "synthetic-proof",
    },
    status: "authoritative-absent",
  }),
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

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const context = {
  capability: { capabilityId: "fixture.echo", capabilityVersion: "1.0.0" },
  configuration: { contentHash: hash("d"), value: { mode: "fixture" } },
  deadlineAtMs: 10_000,
};

const inputValue = { value: true };

const input = {
  contentHash: hash("e"),
  contract: {
    catalogFingerprint: hash("a"),
    catalogVersion: "0.1.0",
    schemaFingerprint: hash("b"),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/fixtures/plugin-input/1.0.0",
    schemaVersion: "1.0.0",
  },
  sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
  value: inputValue,
};

const quote = {
  expiresAtMs: 10_000,
  guarantee: "estimated",
  pricingVersion: "1.0.0",
  unit: "credits",
  upperBound: 1,
} as const;

const manifestWithLookup = (
  manifest: PluginManifestV1,
  lookup: PluginManifestV1["execution"]["lookup"]
): PluginManifestV1 => {
  const result = validatePluginManifest({
    ...manifest,
    execution: { ...manifest.execution, lookup },
  });
  if (!result.ok) {
    throw new Error("The synthetic lookup manifest must be valid.");
  }
  return result.manifest;
};

test("keeps the method list bidirectionally exhaustive with the interface", () => {
  const methodsWithinInterface =
    PLUGIN_ADAPTER_METHODS satisfies readonly (keyof PluginAdapterV1)[];
  const interfaceWithinMethods: Exclude<
    keyof PluginAdapterV1,
    (typeof PLUGIN_ADAPTER_METHODS)[number]
  > extends never
    ? true
    : false = true;

  assert.equal(methodsWithinInterface.length, 8);
  assert.equal(interfaceWithinMethods, true);
});

test("validates describe before exposing the exact frozen surface", async () => {
  const manifest = await readManifest();
  let describeCalls = 0;
  let otherCalls = 0;
  const definition = validDefinition(manifest);
  Reflect.set(definition, "describe", () => {
    describeCalls += 1;
    return { manifest };
  });
  Reflect.set(definition, "health", () => {
    otherCalls += 1;
    return { observedAtMs: 1, status: "healthy", validUntilMs: 2 };
  });

  const adapter = definePluginAdapter(definition);
  assert.equal(describeCalls, 1);
  assert.equal(otherCalls, 0);
  assert.deepEqual(
    Object.keys(adapter).sort(),
    [...PLUGIN_ADAPTER_METHODS].sort()
  );
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.describe()), true);
  assert.equal(Object.isFrozen(adapter.describe().manifest), true);

  assert.deepEqual(await adapter.health({ context }), {
    observedAtMs: 1,
    status: "healthy",
    validUntilMs: 2,
  });
  assert.equal(otherCalls, 1);
});

test("rejects missing, unknown and accessor methods at definition time", async () => {
  const manifest = await readManifest();
  const missing = validDefinition(manifest);
  Reflect.deleteProperty(missing, "health");
  assert.throws(
    () => Reflect.apply(definePluginAdapter, undefined, [missing]),
    (error: unknown) =>
      error instanceof PluginAdapterDefinitionError &&
      error.reasonCode === "plugin-adapter-surface-invalid"
  );

  const extra = validDefinition(manifest);
  Reflect.set(extra, "providerSecret", "synthetic-canary");
  assert.throws(
    () => Reflect.apply(definePluginAdapter, undefined, [extra]),
    (error: unknown) =>
      error instanceof PluginAdapterDefinitionError &&
      !error.message.includes("synthetic-canary")
  );

  const hiddenExtra = validDefinition(manifest);
  Object.defineProperty(hiddenExtra, "providerSecret", {
    value: "synthetic-hidden-canary",
  });
  assert.throws(
    () => Reflect.apply(definePluginAdapter, undefined, [hiddenExtra]),
    (error: unknown) =>
      error instanceof PluginAdapterDefinitionError &&
      !error.message.includes("synthetic-hidden-canary")
  );

  const accessor = validDefinition(manifest);
  let getterCalls = 0;
  Object.defineProperty(accessor, "health", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "synthetic-accessor-canary";
    },
  });
  assert.throws(() =>
    Reflect.apply(definePluginAdapter, undefined, [accessor])
  );
  assert.equal(getterCalls, 0);

  const proxy = new Proxy(validDefinition(manifest), {
    getPrototypeOf: () => {
      throw new Error("synthetic-proxy-canary");
    },
  });
  assert.throws(
    () => Reflect.apply(definePluginAdapter, undefined, [proxy]),
    (error: unknown) =>
      error instanceof PluginAdapterDefinitionError &&
      !error.message.includes("synthetic-proxy-canary")
  );
});

test("rejects an invalid manifest before invoking any other method", async () => {
  const definition = validDefinition(await readManifest());
  Reflect.set(definition, "describe", () => ({
    manifest: {
      apiVersion: "dev.kurobara.plugin/v2",
      providerSecret: "synthetic-manifest-canary",
    },
  }));
  let otherCalls = 0;
  Reflect.set(definition, "execute", () => {
    otherCalls += 1;
    return {};
  });

  assert.throws(
    () => Reflect.apply(definePluginAdapter, undefined, [definition]),
    (error: unknown) =>
      error instanceof PluginAdapterDefinitionError &&
      error.reasonCode === "plugin-adapter-manifest-invalid" &&
      !error.message.includes("synthetic-manifest-canary")
  );
  assert.equal(otherCalls, 0);
});

test("neutralizes a rejected native describe Promise without touching thenables", async () => {
  const manifest = await readManifest();
  const canary = "synthetic-describe-rejection-canary";
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.prependListener("unhandledRejection", onUnhandledRejection);

  try {
    const asynchronousDescribe = validDefinition(manifest);
    Reflect.set(asynchronousDescribe, "describe", () =>
      Promise.reject(new Error(canary))
    );
    assert.throws(
      () => definePluginAdapter(asynchronousDescribe),
      (error: unknown) =>
        error instanceof PluginAdapterDefinitionError &&
        error.reasonCode === "plugin-adapter-describe-failed" &&
        !error.message.includes(canary)
    );

    let thenGetterCalls = 0;
    // biome-ignore lint/suspicious/noThenProperty: hostile fixture proves the SDK never reads an arbitrary then getter.
    const arbitraryThenable = Object.defineProperty({}, "then", {
      enumerable: true,
      get: () => {
        thenGetterCalls += 1;
        return () => undefined;
      },
    });
    const hostileDescribe = validDefinition(manifest);
    Reflect.set(hostileDescribe, "describe", () => arbitraryThenable);
    assert.throws(
      () => definePluginAdapter(hostileDescribe),
      (error: unknown) =>
        error instanceof PluginAdapterDefinitionError &&
        error.reasonCode === "plugin-adapter-manifest-invalid"
    );
    assert.equal(thenGetterCalls, 0);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("rejects preflight quote errors but contains hostile post-effect outcomes", async () => {
  const manifest = await readManifest();
  const invalidQuote = validDefinition(manifest);
  Reflect.set(invalidQuote, "estimate", () => ({
    quote: {
      expiresAtMs: 10_000,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
    },
    status: "quoted",
  }));
  const quoteAdapter = definePluginAdapter(invalidQuote);
  await assert.rejects(
    () => Promise.resolve(quoteAdapter.estimate({ context, input })),
    (error: unknown) =>
      error instanceof PluginAdapterProtocolError && error.method === "estimate"
  );

  let getterCalls = 0;
  const invalidOutcome = validDefinition(manifest);
  Reflect.set(invalidOutcome, "execute", () =>
    Object.defineProperty(
      {
        externalOperationReference: "synthetic-qualified-reference",
        status: "succeeded",
        usage: { amount: 1, basis: "exact", unit: "credits" },
      },
      "providerPayload",
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "synthetic-result-canary";
        },
      }
    )
  );
  const outcomeAdapter = definePluginAdapter(invalidOutcome);
  assert.deepEqual(
    await outcomeAdapter.execute({
      context,
      costLimit: { amount: 1, unit: "credits" },
      input,
      operationKey: "synthetic:execute",
      quote,
    }),
    {
      error: ambiguousError,
      externalOperationReference: "synthetic-qualified-reference",
      status: "outcome-unknown",
    }
  );
  assert.equal(getterCalls, 0);

  let lookupGetterCalls = 0;
  const invalidLookup = validDefinition(manifest);
  Reflect.set(invalidLookup, "lookup", () =>
    Object.defineProperty({ status: "found" }, "proof", {
      enumerable: true,
      get: () => {
        lookupGetterCalls += 1;
        return "synthetic-lookup-canary";
      },
    })
  );
  assert.deepEqual(
    await definePluginAdapter(invalidLookup).lookup({
      context,
      operationKey: "synthetic:lookup-invalid",
    }),
    { error: ambiguousError, status: "outcome-unknown" }
  );
  assert.equal(lookupGetterCalls, 0);
});

test("passes an immutable request with the exact operation key", async () => {
  const manifest = await readManifest();
  const definition = validDefinition(manifest);
  let receivedOperationKey = "";
  let frozen = false;
  Reflect.set(definition, "execute", (request: unknown) => {
    const validated = validatePluginProtocolMessage({
      apiVersion: "dev.kurobara.plugin-protocol/v1",
      direction: "request",
      method: "execute",
      payload: request,
    });
    if (
      !validated.ok ||
      validated.message.direction !== "request" ||
      validated.message.method !== "execute"
    ) {
      throw new Error("Expected a canonical execute request.");
    }
    receivedOperationKey = validated.message.payload.operationKey;
    frozen = Object.isFrozen(request);
    return {
      providerPayload: { accepted: true },
      status: "succeeded",
      usage: { amount: 1, basis: "exact", unit: "credits" },
    };
  });
  const adapter = definePluginAdapter(definition);
  const operationKey = "synthetic:exact-operation-key";

  const result = await adapter.execute({
    context,
    costLimit: { amount: 1, unit: "credits" },
    input,
    operationKey,
    quote,
  });
  assert.equal(receivedOperationKey, operationKey);
  assert.equal(frozen, true);
  assert.equal(Object.isFrozen(result), true);
});

test("contains thrown post-effect diagnostics as redacted ambiguity", async () => {
  const manifest = await readManifest();
  const definition = validDefinition(manifest);
  const canary = "synthetic-rejection-canary";
  Reflect.set(definition, "execute", () => Promise.reject(new Error(canary)));
  Reflect.set(definition, "lookup", () => {
    throw new Error(canary);
  });
  const adapter = definePluginAdapter(definition);

  const executeResult = await adapter.execute({
    context,
    costLimit: { amount: 1, unit: "credits" },
    input,
    operationKey: "synthetic:rejected",
    quote,
  });
  const lookupResult = await adapter.lookup({
    context,
    operationKey: "synthetic:lookup-rejected",
  });
  assert.deepEqual(executeResult, {
    error: ambiguousError,
    status: "outcome-unknown",
  });
  assert.deepEqual(lookupResult, {
    error: ambiguousError,
    status: "outcome-unknown",
  });
  assert.equal(
    JSON.stringify([executeResult, lookupResult]).includes(canary),
    false
  );

  const certainFailure = validDefinition(manifest);
  Reflect.set(certainFailure, "health", () =>
    Promise.reject(new Error(canary))
  );
  await assert.rejects(
    () =>
      Promise.resolve(definePluginAdapter(certainFailure).health({ context })),
    (error: unknown) =>
      error instanceof PluginAdapterInvocationError &&
      error.method === "health" &&
      !error.message.includes(canary)
  );
});

test("rejects an unauthorized quote before invoking execute", async () => {
  const manifest = await readManifest();
  const definition = validDefinition(manifest);
  let executeCalls = 0;
  Reflect.set(definition, "execute", () => {
    executeCalls += 1;
    return {
      providerPayload: { accepted: true },
      status: "succeeded",
      usage: { amount: 1, basis: "exact", unit: "credits" },
    };
  });
  const adapter = definePluginAdapter(definition);
  const request = {
    context,
    costLimit: { amount: 1, unit: "credits" },
    input,
    operationKey: "synthetic:quote-bound",
    quote,
  } as const;

  for (const rejectedQuote of [
    { ...quote, unit: "requests" },
    { ...quote, upperBound: 2 },
  ]) {
    await assert.rejects(
      () =>
        Promise.resolve(adapter.execute({ ...request, quote: rejectedQuote })),
      (error: unknown) =>
        error instanceof PluginAdapterProtocolError &&
        error.method === "execute" &&
        error.reasonCode === "plugin-protocol-semantic-invalid"
    );
  }
  assert.equal(executeCalls, 0);
});

test("applies lookup recovery authority before and after invocation", async () => {
  const manifest = await readManifest();
  const nonAuthoritative = validDefinition(
    manifestWithLookup(manifest, {
      authoritativeNotFound: false,
      mode: "by-operation-key",
    })
  );
  assert.deepEqual(
    await definePluginAdapter(nonAuthoritative).lookup({
      context,
      operationKey: "synthetic:not-authoritative",
    }),
    { error: ambiguousError, status: "outcome-unknown" }
  );

  const externalReference = "synthetic-external-operation";
  let lookupCalls = 0;
  const external = validDefinition(
    manifestWithLookup(manifest, {
      authoritativeNotFound: true,
      mode: "by-external-operation-id",
    })
  );
  Reflect.set(external, "lookup", (request: PluginLookupRequest) => {
    lookupCalls += 1;
    const proof = {
      observedAtMs: request.context.deadlineAtMs,
      proofReference: "synthetic-proof",
    };
    if (request.operationKey === "synthetic:failed") {
      return {
        outcome: {
          error: safeError,
          status: "failed",
          usage: { amount: 1, basis: "exact", unit: "credits" },
        },
        proof,
        status: "found",
      };
    }
    return {
      outcome: {
        externalOperationReference:
          request.operationKey === "synthetic:matching"
            ? request.externalOperationReference
            : "synthetic-mismatched-reference",
        providerPayload: { accepted: true },
        status: "succeeded",
        usage: { amount: 1, basis: "exact", unit: "credits" },
      },
      proof,
      status: "found",
    };
  });
  const adapter = definePluginAdapter(external);

  await assert.rejects(
    () =>
      Promise.resolve(
        adapter.lookup({
          context,
          operationKey: "synthetic:missing-reference",
        })
      ),
    (error: unknown) =>
      error instanceof PluginAdapterProtocolError &&
      error.method === "lookup" &&
      error.reasonCode === "plugin-protocol-semantic-invalid"
  );
  assert.equal(lookupCalls, 0);

  const matching = await adapter.lookup({
    context,
    externalOperationReference: externalReference,
    operationKey: "synthetic:matching",
  });
  assert.equal(matching.status, "found");
  assert.deepEqual(
    await adapter.lookup({
      context,
      externalOperationReference: externalReference,
      operationKey: "synthetic:mismatched",
    }),
    { error: ambiguousError, status: "outcome-unknown" }
  );
  assert.deepEqual(
    await adapter.lookup({
      context,
      externalOperationReference: externalReference,
      operationKey: "synthetic:failed",
    }),
    { error: ambiguousError, status: "outcome-unknown" }
  );
  assert.equal(lookupCalls, 3);
});

test("forces a one-shot adapter lookup to outcome-unknown without invoking it", async () => {
  const manifest = await readOneShotManifest();
  const definition = validDefinition(manifest);
  let lookupCalls = 0;
  Reflect.set(definition, "lookup", () => {
    lookupCalls += 1;
    return {
      proof: {
        observedAtMs: context.deadlineAtMs,
        proofReference: "synthetic-false-proof",
      },
      status: "authoritative-absent",
    };
  });

  const result = await definePluginAdapter(definition).lookup({
    context: {
      ...context,
      capability: {
        capabilityId: manifest.capabilities[0]?.capabilityId ?? "",
        capabilityVersion: manifest.capabilities[0]?.capabilityVersion ?? "",
      },
    },
    operationKey: "synthetic:one-shot",
  });

  assert.deepEqual(result, {
    error: ambiguousError,
    status: "outcome-unknown",
  });
  assert.equal(lookupCalls, 0);
});

test("enforces result bindings while preserving an observed cost overage", async () => {
  const manifest = await readManifest();
  const mismatchedFingerprint = validDefinition(manifest);
  Reflect.set(mismatchedFingerprint, "validateConfig", () => ({
    configurationFingerprint: hash("f"),
    status: "valid",
  }));
  const fingerprintAdapter = definePluginAdapter(mismatchedFingerprint);
  await assert.rejects(
    () =>
      Promise.resolve(
        fingerprintAdapter.validateConfig({
          capability: context.capability,
          configuration: context.configuration,
        })
      ),
    (error: unknown) =>
      error instanceof PluginAdapterProtocolError &&
      error.reasonCode === "plugin-protocol-semantic-invalid"
  );

  const invalidHealth = validDefinition(manifest);
  Reflect.set(invalidHealth, "health", () => ({
    observedAtMs: 2,
    status: "healthy",
    validUntilMs: 1,
  }));
  const healthAdapter = definePluginAdapter(invalidHealth);
  await assert.rejects(
    () => Promise.resolve(healthAdapter.health({ context })),
    (error: unknown) =>
      error instanceof PluginAdapterProtocolError &&
      error.reasonCode === "plugin-protocol-semantic-invalid"
  );

  const mismatchedUsage = validDefinition(manifest);
  Reflect.set(mismatchedUsage, "execute", () => ({
    providerPayload: { accepted: true },
    status: "succeeded",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  }));
  assert.deepEqual(
    await definePluginAdapter(mismatchedUsage).execute({
      context,
      costLimit: { amount: 1, unit: "credits" },
      input,
      operationKey: "synthetic:usage-mismatch",
      quote,
    }),
    { error: ambiguousError, status: "outcome-unknown" }
  );

  const overage = validDefinition(manifest);
  Reflect.set(overage, "execute", () => ({
    providerPayload: { accepted: true },
    status: "succeeded",
    usage: { amount: 2, basis: "exact", unit: "credits" },
  }));
  const overageAdapter = definePluginAdapter(overage);
  const result = await overageAdapter.execute({
    context,
    costLimit: { amount: 1, unit: "credits" },
    input,
    operationKey: "synthetic:overage",
    quote,
  });
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.equal(result.usage.amount, 2);
  }
  assert.equal(Object.isFrozen(result), true);
});
