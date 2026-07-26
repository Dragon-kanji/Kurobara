import assert from "node:assert/strict";
import test from "node:test";

import { JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION } from "@kurobara/adapter-output-json-schema";

import {
  createDeterministicOutputValidator,
  deterministicOutputContract,
} from "../src/deterministic-output.ts";

const validOutput = {
  adapter: "deterministic-local",
  attempt_id: "attempt-worker-test",
  operation_key: "operation-worker-test",
  run_id: "run-worker-test",
  status: "succeeded",
  step_run_id: "step-worker-test",
} as const;

test("binds the worker validator to the generated deterministic contract", async () => {
  assert.equal(
    deterministicOutputContract.schemaFingerprint,
    "sha256:02f08ae5cb4775e420fcc1c4ce468943e497ef430da7e03d7be0b6a91e060d8e"
  );
  const validator = createDeterministicOutputValidator();

  assert.deepEqual(
    await validator.validate({
      contract: deterministicOutputContract,
      value: validOutput,
    }),
    {
      status: "accepted",
      validatorVersion: JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION,
    }
  );
  assert.deepEqual(
    await validator.validate({
      contract: deterministicOutputContract,
      value: { ...validOutput, unexpected: true },
    }),
    { reason: "output-schema-rejected", status: "rejected" }
  );
});
