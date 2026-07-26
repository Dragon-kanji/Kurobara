import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_JSON_MAX_UTF8_BYTES,
  PLUGIN_PROTOCOL_API_VERSION,
  PLUGIN_PROTOCOL_ENVELOPE_MAX_UTF8_BYTES,
  validatePluginProtocolMessage,
} from "../src/index.ts";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const estimateRequest = (value: string, sizeBytes: number): unknown => ({
  apiVersion: PLUGIN_PROTOCOL_API_VERSION,
  direction: "request",
  method: "estimate",
  payload: {
    context: {
      capability: {
        capabilityId: "fixture.echo",
        capabilityVersion: "1.0.0",
      },
      configuration: { contentHash: hash("d"), value: {} },
      deadlineAtMs: 10_000,
    },
    input: {
      contentHash: hash("e"),
      contract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "0.6.0",
        schemaFingerprint: hash("b"),
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/deterministic-output/1.0.0",
        schemaVersion: "1.0.0",
      },
      sizeBytes,
      value,
    },
  },
});

test("accepts a maximum-sized embedded value inside the larger envelope", () => {
  const value = "x".repeat(PLUGIN_JSON_MAX_UTF8_BYTES - 2);
  const result = validatePluginProtocolMessage(
    estimateRequest(value, PLUGIN_JSON_MAX_UTF8_BYTES)
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.message), true);
    assert.equal(Object.isFrozen(result.message.payload), true);
  }
});

test("rejects a declared input size that does not match its JSON bytes", () => {
  const value = "synthetic";
  assert.deepEqual(validatePluginProtocolMessage(estimateRequest(value, 1)), {
    ok: false,
    reasonCode: "plugin-protocol-semantic-invalid",
    validatorVersion: "ajv-8.20.0-kurobara-plugin-protocol-v1",
  });
});

test("applies the public JSON limit to each embedded value", () => {
  const value = "x".repeat(PLUGIN_JSON_MAX_UTF8_BYTES - 1);
  assert.deepEqual(
    validatePluginProtocolMessage(
      estimateRequest(value, PLUGIN_JSON_MAX_UTF8_BYTES)
    ),
    {
      ok: false,
      reasonCode: "plugin-json-size-exceeded",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-protocol-v1",
    }
  );
});

test("rejects an envelope that exceeds its independent byte limit", () => {
  assert.deepEqual(
    validatePluginProtocolMessage({
      oversized: "x".repeat(PLUGIN_PROTOCOL_ENVELOPE_MAX_UTF8_BYTES + 1),
    }),
    {
      ok: false,
      reasonCode: "plugin-json-size-exceeded",
      validatorVersion: "ajv-8.20.0-kurobara-plugin-protocol-v1",
    }
  );
});
