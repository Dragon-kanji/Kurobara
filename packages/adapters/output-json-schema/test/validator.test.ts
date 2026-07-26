import assert from "node:assert/strict";
import test from "node:test";

import { contentHash } from "@kurobara/kernel";

import {
  createJsonSchemaInputContractValidator,
  createJsonSchemaOutputContractValidator,
  JSON_SCHEMA_INPUT_VALIDATOR_VERSION,
  JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION,
  JsonSchemaOutputValidatorConfigurationError,
  jsonSchemaContractRef,
} from "../src/index.ts";

const schema = {
  $id: "https://schemas.kurobara.invalid/schemas/fixtures/test-output/1.0.0",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    status: {
      const: "succeeded",
      "x-kurobara-admissible-for-capabilities": [
        "contacts.identity.reveal@1.0.0",
      ],
      "x-kurobara-required-for-capabilities": [
        "contacts.identity.reveal@1.0.0",
      ],
    },
  },
  required: ["status"],
  title: "TestOutputFixture",
  type: "object",
  "x-kurobara-schema-version": "1.0.0",
} as const;

const contract = jsonSchemaContractRef({
  catalogFingerprint: contentHash(`sha256:${"a".repeat(64)}`),
  catalogVersion: "0.1.0",
  schema,
});

test("strictly accepts only the registered JSON Schema contract", async () => {
  const validator = createJsonSchemaOutputContractValidator([
    { contract, schema },
  ]);

  assert.deepEqual(
    await validator.validate({ contract, value: { status: "succeeded" } }),
    {
      status: "accepted",
      validatorVersion: JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION,
    }
  );
  assert.deepEqual(
    await validator.validate({
      contract,
      value: { extra: true, status: "succeeded" },
    }),
    { reason: "output-schema-rejected", status: "rejected" }
  );
});

test("rejects an unregistered ContractRef without leaking schema details", async () => {
  const validator = createJsonSchemaOutputContractValidator([
    { contract, schema },
  ]);
  const otherContract = {
    ...contract,
    catalogVersion: "0.2.0",
  };

  assert.deepEqual(
    await validator.validate({
      contract: otherContract,
      value: { status: "succeeded" },
    }),
    { reason: "output-contract-not-registered", status: "rejected" }
  );
});

test("validates inputs through the same exact canonical registrations", async () => {
  const validator = createJsonSchemaInputContractValidator([
    { contract, schema },
  ]);

  assert.deepEqual(
    await validator.validate({ contract, value: { status: "succeeded" } }),
    {
      status: "accepted",
      validatorVersion: JSON_SCHEMA_INPUT_VALIDATOR_VERSION,
    }
  );
  assert.deepEqual(
    await validator.validate({
      contract: { ...contract, schemaVersion: "2.0.0" },
      value: { status: "succeeded" },
    }),
    { reason: "input-contract-not-registered", status: "rejected" }
  );
});

test("refuses a registration whose ContractRef does not match the schema", () => {
  assert.throws(
    () =>
      createJsonSchemaOutputContractValidator([
        {
          contract: {
            ...contract,
            schemaFingerprint: contentHash(`sha256:${"b".repeat(64)}`),
          },
          schema,
        },
      ]),
    JsonSchemaOutputValidatorConfigurationError
  );
});
