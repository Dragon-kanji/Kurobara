import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_JSON_MAX_DEPTH,
  PLUGIN_JSON_MAX_NODES,
  PLUGIN_JSON_MAX_UTF8_BYTES,
  validatePluginJson,
} from "../src/json.ts";

test("clones and freezes bounded JSON without retaining caller aliases", () => {
  const candidate = {
    enabled: true,
    nested: { items: [1, "two", null] },
  };
  const result = validatePluginJson(candidate);

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value, candidate);
  assert.equal(Object.isFrozen(result.value), true);
  if (
    result.value !== null &&
    typeof result.value === "object" &&
    !Array.isArray(result.value)
  ) {
    assert.equal(Object.isFrozen(result.value.nested), true);
  }

  candidate.nested.items.push("changed");
  assert.deepEqual(result.value, {
    enabled: true,
    nested: { items: [1, "two", null] },
  });
});

test("rejects hostile structures without invoking accessors or returning values", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "synthetic-accessor-canary";
    },
  });
  assert.deepEqual(validatePluginJson(accessor), {
    ok: false,
    reasonCode: "plugin-json-accessor",
  });
  assert.equal(getterCalls, 0);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.deepEqual(validatePluginJson(cyclic), {
    ok: false,
    reasonCode: "plugin-json-cycle",
  });

  const sparse = new Array<unknown>(1);
  assert.deepEqual(validatePluginJson(sparse), {
    ok: false,
    reasonCode: "plugin-json-array-sparse",
  });
  assert.deepEqual(validatePluginJson(new Date(0)), {
    ok: false,
    reasonCode: "plugin-json-prototype-invalid",
  });
  assert.deepEqual(validatePluginJson(Number.POSITIVE_INFINITY), {
    ok: false,
    reasonCode: "plugin-json-number-invalid",
  });

  const symbol = Symbol("synthetic-canary");
  const withSymbol = { accepted: true };
  Object.defineProperty(withSymbol, symbol, { value: "hidden" });
  assert.deepEqual(validatePluginJson(withSymbol), {
    ok: false,
    reasonCode: "plugin-json-symbol",
  });

  const proxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("synthetic-proxy-canary");
      },
    }
  );
  const rejectedProxy = validatePluginJson(proxy);
  assert.deepEqual(rejectedProxy, {
    ok: false,
    reasonCode: "plugin-json-type-invalid",
  });
  assert.equal(JSON.stringify(rejectedProxy).includes("canary"), false);
});

test("enforces depth, node and UTF-8 byte limits", () => {
  let tooDeep: unknown = "leaf";
  for (let depth = 0; depth <= PLUGIN_JSON_MAX_DEPTH; depth += 1) {
    tooDeep = [tooDeep];
  }
  assert.deepEqual(validatePluginJson(tooDeep), {
    ok: false,
    reasonCode: "plugin-json-depth-exceeded",
  });

  assert.deepEqual(
    validatePluginJson(Array.from({ length: PLUGIN_JSON_MAX_NODES }, () => 0)),
    {
      ok: false,
      reasonCode: "plugin-json-node-limit-exceeded",
    }
  );
  assert.deepEqual(validatePluginJson("x".repeat(PLUGIN_JSON_MAX_UTF8_BYTES)), {
    ok: false,
    reasonCode: "plugin-json-size-exceeded",
  });
});

test("rejects aggregate alias expansion before traversing the full graph", () => {
  const shared = "x".repeat(PLUGIN_JSON_MAX_UTF8_BYTES / 2);
  let sentinelVisits = 0;
  const sentinel = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        sentinelVisits += 1;
        return Object.prototype;
      },
    }
  );
  const aliases = Array.from(
    { length: PLUGIN_JSON_MAX_NODES - 1 },
    (_, index) => (index === PLUGIN_JSON_MAX_NODES - 2 ? sentinel : shared)
  );

  assert.deepEqual(validatePluginJson(aliases), {
    ok: false,
    reasonCode: "plugin-json-size-exceeded",
  });
  assert.equal(sentinelVisits, 0);
});
