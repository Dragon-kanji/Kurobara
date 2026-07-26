import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  contentHash,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { BootstrapPlanningInput } from "@kurobara/ports";

import { validatePlanningBundle } from "../src/index.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const planning = (): BootstrapPlanningInput => {
  const workspace = workspaceId("workspace-validation");
  const capability = {
    capabilityId: capabilityId("documents.summarize"),
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/validation/1.0.0",
    schemaVersion: "1.0.0",
  };
  return {
    authorities: [],
    defaults: {
      policySnapshotId: "policy-validation",
      pricingSnapshotId: "pricing-validation",
      workspaceId: workspace,
    },
    expectedDefaultsRevision: null,
    policies: [],
    pricing: [],
    workflows: [
      {
        allowedCapabilities: [capability.capabilityId],
        catalogFingerprint: hash("a"),
        catalogVersion: "1.0.0",
        compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
        compilerVersion: "1.0.0",
        inputContract: contract,
        outputContract: contract,
        workflow: {
          contentHash: hash("c"),
          nodes: [
            { capability, dependsOn: [], key: "first" },
            { capability, dependsOn: ["first"], key: "second" },
          ],
          revision: "1.0.0",
          workflowSpecId: workflowSpecId("workflow-validation"),
        },
        workspaceId: workspace,
      },
    ],
    workspaceId: workspace,
  };
};

test("accepts a workflow bundle that compiles under its declared limits", () => {
  assert.deepEqual(validatePlanningBundle(planning()), {
    ok: true,
    value: undefined,
  });
});

test("rejects an immutable workflow snapshot with a dependency cycle", () => {
  const input = planning();
  const workflow = input.workflows[0];
  if (workflow === undefined) {
    throw new Error("The validation fixture requires a workflow.");
  }
  const result = validatePlanningBundle({
    ...input,
    workflows: [
      {
        ...workflow,
        workflow: {
          ...workflow.workflow,
          nodes: workflow.workflow.nodes.map((node) => ({
            ...node,
            dependsOn: [node.key === "first" ? "second" : "first"],
          })),
        },
      },
    ],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.failure.code, "cycle-detected");
  }
});

test("rejects a workflow snapshot claiming an unsupported compiler", () => {
  const input = planning();
  const workflow = input.workflows[0];
  if (workflow === undefined) {
    throw new Error("The validation fixture requires a workflow.");
  }
  const result = validatePlanningBundle({
    ...input,
    workflows: [{ ...workflow, compilerVersion: "999.0.0" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.failure.code, "compiler-version-unsupported");
  }
});
