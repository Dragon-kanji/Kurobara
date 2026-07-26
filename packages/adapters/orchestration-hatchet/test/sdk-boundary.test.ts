import assert from "node:assert/strict";
import test from "node:test";

import { unwrapHatchetTaskInput } from "../src/sdk-boundary.ts";

test("unwraps the V1 task-list payload envelope", () => {
  const input = {
    eventId: "event-test",
    runId: "run-test",
    startKey: "start-test",
    workspaceId: "workspace-test",
  };

  assert.deepEqual(
    unwrapHatchetTaskInput({
      input,
      overrides: null,
      parents: {},
      triggered_by: "manual",
    }),
    input
  );
});

test("leaves a direct payload intact for SDK compatibility", () => {
  const input = { startKey: "start-test" };

  assert.equal(unwrapHatchetTaskInput(input), input);
  assert.equal(unwrapHatchetTaskInput(null), null);
});
