import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  contentHash,
  type WorkflowSpec,
  workflowSpecId,
} from "@kurobara/kernel";

import { compileWorkflow, WORKFLOW_COMPILER_VERSION } from "../src/index.ts";

const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const spec = (nodes: WorkflowSpec["nodes"]): WorkflowSpec => ({
  contentHash: contentHash(`sha256:${"a".repeat(64)}`),
  nodes,
  revision: "1.0.0",
  workflowSpecId: workflowSpecId("workflow-test"),
});
const compile = (workflow: WorkflowSpec) =>
  compileWorkflow({
    allowedCapabilities: [capability.capabilityId],
    compilerVersion: "1.0.0",
    limits: { maxDepth: 3, maxFanOut: 3, maxNodes: 4 },
    spec: workflow,
  });

test("compiles the same graph to the same stable order regardless of source node order", () => {
  const first = compile(
    spec([
      { capability, dependsOn: ["extract"], key: "summarize" },
      { capability, dependsOn: [], key: "extract" },
    ])
  );
  const second = compile(
    spec([
      { capability, dependsOn: [], key: "extract" },
      { capability, dependsOn: ["extract"], key: "summarize" },
    ])
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(first.value, second.value);
    assert.deepEqual(
      first.value.nodes.map((node) => node.key),
      ["extract", "summarize"]
    );
  }
});

test("refuses a cycle without reading any external state", () => {
  const result = compile(
    spec([
      { capability, dependsOn: ["b"], key: "a" },
      { capability, dependsOn: ["a"], key: "b" },
    ])
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cycle-detected");
  }
});

test("refuses a compiler version that cannot own the output provenance", () => {
  const result = compileWorkflow({
    allowedCapabilities: [capability.capabilityId],
    compilerVersion: `${WORKFLOW_COMPILER_VERSION}-forged`,
    limits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
    spec: spec([{ capability, dependsOn: [], key: "summarize" }]),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "compiler-version-unsupported");
  }
});

test("refuses a capability absent from the supplied allowlist", () => {
  const result = compileWorkflow({
    allowedCapabilities: [],
    compilerVersion: "1.0.0",
    limits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
    spec: spec([{ capability, dependsOn: [], key: "summarize" }]),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "capability-not-allowed");
  }
});
