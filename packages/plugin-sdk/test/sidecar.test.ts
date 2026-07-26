import assert from "node:assert/strict";
import test from "node:test";

import {
  isPluginSidecarJsonRpcFrame,
  PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES,
  validatePluginSidecarJsonRpcFrame,
} from "../src/index.ts";

const describeRequest = {
  id: "host-call-1",
  jsonrpc: "2.0",
  method: "plugin.describe",
  params: {
    apiVersion: "dev.kurobara.plugin-protocol/v1",
    direction: "request",
    method: "describe",
    payload: {},
  },
};

const healthResult = {
  id: "host-call-1",
  jsonrpc: "2.0",
  result: {
    apiVersion: "dev.kurobara.plugin-protocol/v1",
    direction: "result",
    method: "health",
    payload: {
      observedAtMs: 4_102_444_700_000,
      status: "healthy",
      validUntilMs: 4_102_444_730_000,
    },
  },
};

test("validates and freezes one request or result frame", () => {
  for (const frame of [describeRequest, healthResult]) {
    const validated = validatePluginSidecarJsonRpcFrame(frame);
    assert.equal(validated.ok, true);
    if (validated.ok) {
      assert.equal(Object.isFrozen(validated.frame), true);
      assert.equal(
        Object.isFrozen(
          "params" in validated.frame
            ? validated.frame.params
            : validated.frame.result
        ),
        true
      );
      assert.equal(isPluginSidecarJsonRpcFrame(validated.frame), true);
    }
  }
});

test("rejects notifications, JSON-RPC errors and ambiguous ids", () => {
  for (const candidate of [
    {
      jsonrpc: describeRequest.jsonrpc,
      method: describeRequest.method,
      params: describeRequest.params,
    },
    { ...describeRequest, id: 1 },
    {
      error: { code: -32_603, message: "synthetic raw diagnostic" },
      id: "host-call-1",
      jsonrpc: "2.0",
    },
  ]) {
    assert.deepEqual(validatePluginSidecarJsonRpcFrame(candidate), {
      ok: false,
      reasonCode: "plugin-sidecar-json-rpc-frame-invalid",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-sidecar-json-rpc-v1",
    });
  }
});

test("rejects an external method that disagrees with the inner message", () => {
  assert.deepEqual(
    validatePluginSidecarJsonRpcFrame({
      ...describeRequest,
      method: "plugin.health",
    }),
    {
      ok: false,
      reasonCode: "plugin-sidecar-json-rpc-frame-invalid",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-sidecar-json-rpc-v1",
    }
  );
});

test("rejects a request-direction envelope in a result frame", () => {
  assert.deepEqual(
    validatePluginSidecarJsonRpcFrame({
      id: "host-call-1",
      jsonrpc: "2.0",
      result: describeRequest.params,
    }),
    {
      ok: false,
      reasonCode: "plugin-sidecar-json-rpc-frame-invalid",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-sidecar-json-rpc-v1",
    }
  );
});

test("bounds the raw parsed frame independently from the inner envelope", () => {
  assert.deepEqual(
    validatePluginSidecarJsonRpcFrame({
      oversized: "x".repeat(PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 1),
    }),
    {
      ok: false,
      reasonCode: "plugin-json-size-exceeded",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-sidecar-json-rpc-v1",
    }
  );
});
