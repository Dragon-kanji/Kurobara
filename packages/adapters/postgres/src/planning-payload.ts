import {
  actorId,
  capabilityId,
  contentHash,
  instant,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  AuthoritySnapshot,
  PlanningDefaults,
  PolicyPlanningSnapshot,
  PricingSnapshot,
  WorkflowSnapshot,
} from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value)) as JsonRecord;
};

const exactRecord = (
  value: unknown,
  path: string,
  allowedKeys: readonly string[]
): JsonRecord => {
  const item = record(value, path);
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(item).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new DatabasePayloadError(`${path}.${unknownKey} is not supported.`);
  }
  return item;
};

const string = (value: unknown, path: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 4096
  ) {
    throw new DatabasePayloadError(
      `${path} must be a bounded non-empty string without surrounding whitespace.`
    );
  }
  return value;
};

const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DatabasePayloadError(`${path} must be a finite number.`);
  }
  return value;
};

const nonNegativeNumber = (value: unknown, path: string): number => {
  const parsed = finiteNumber(value, path);
  if (parsed < 0) {
    throw new DatabasePayloadError(`${path} must be non-negative.`);
  }
  return parsed;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  const parsed = nonNegativeNumber(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw new DatabasePayloadError(`${path} must be a safe integer.`);
  }
  return parsed;
};

const strings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > 256) {
    throw new DatabasePayloadError(
      `${path} must be an array of at most 256 items.`
    );
  }
  const parsed = value.map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new DatabasePayloadError(`${path} must not contain duplicates.`);
  }
  return parsed;
};

const capability = (value: unknown, path: string) => {
  const item = exactRecord(value, path, ["capabilityId", "capabilityVersion"]);
  return {
    capabilityId: capabilityId(
      string(item.capabilityId, `${path}.capabilityId`)
    ),
    capabilityVersion: string(
      item.capabilityVersion,
      `${path}.capabilityVersion`
    ),
  };
};

const contract = (value: unknown, path: string) => {
  const item = exactRecord(value, path, [
    "catalogFingerprint",
    "catalogVersion",
    "schemaFingerprint",
    "schemaId",
    "schemaVersion",
  ]);
  return {
    catalogFingerprint: contentHash(
      string(item.catalogFingerprint, `${path}.catalogFingerprint`)
    ),
    catalogVersion: string(item.catalogVersion, `${path}.catalogVersion`),
    schemaFingerprint: contentHash(
      string(item.schemaFingerprint, `${path}.schemaFingerprint`)
    ),
    schemaId: string(item.schemaId, `${path}.schemaId`),
    schemaVersion: string(item.schemaVersion, `${path}.schemaVersion`),
  };
};

const budget = (value: unknown, path: string) => {
  const item = exactRecord(value, path, ["limit", "reserved", "spent", "unit"]);
  const parsed = {
    limit: nonNegativeNumber(item.limit, `${path}.limit`),
    reserved: nonNegativeNumber(item.reserved, `${path}.reserved`),
    spent: nonNegativeNumber(item.spent, `${path}.spent`),
    unit: string(item.unit, `${path}.unit`),
  };
  if (parsed.reserved + parsed.spent > parsed.limit) {
    throw new DatabasePayloadError(
      `${path}.reserved and ${path}.spent must not exceed the limit.`
    );
  }
  return parsed;
};

export const parseWorkflowSnapshot = (value: unknown): WorkflowSnapshot => {
  const item = exactRecord(value, "workflowSnapshot", [
    "allowedCapabilities",
    "catalogFingerprint",
    "catalogVersion",
    "compilationLimits",
    "compilerVersion",
    "inputContract",
    "outputContract",
    "workflow",
    "workspaceId",
  ]);
  const workflow = exactRecord(item.workflow, "workflowSnapshot.workflow", [
    "contentHash",
    "nodes",
    "revision",
    "workflowSpecId",
  ]);
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length > 256) {
    throw new DatabasePayloadError(
      "workflowSnapshot.workflow.nodes must be an array of at most 256 items."
    );
  }
  const compilationLimits = exactRecord(
    item.compilationLimits,
    "workflowSnapshot.compilationLimits",
    ["maxDepth", "maxFanOut", "maxNodes"]
  );
  return {
    allowedCapabilities: strings(
      item.allowedCapabilities,
      "workflowSnapshot.allowedCapabilities"
    ),
    catalogFingerprint: contentHash(
      string(item.catalogFingerprint, "workflowSnapshot.catalogFingerprint")
    ),
    catalogVersion: string(
      item.catalogVersion,
      "workflowSnapshot.catalogVersion"
    ),
    compilationLimits: {
      maxDepth: nonNegativeInteger(
        compilationLimits.maxDepth,
        "workflowSnapshot.compilationLimits.maxDepth"
      ),
      maxFanOut: nonNegativeInteger(
        compilationLimits.maxFanOut,
        "workflowSnapshot.compilationLimits.maxFanOut"
      ),
      maxNodes: nonNegativeInteger(
        compilationLimits.maxNodes,
        "workflowSnapshot.compilationLimits.maxNodes"
      ),
    },
    compilerVersion: string(
      item.compilerVersion,
      "workflowSnapshot.compilerVersion"
    ),
    inputContract: contract(
      item.inputContract,
      "workflowSnapshot.inputContract"
    ),
    outputContract: contract(
      item.outputContract,
      "workflowSnapshot.outputContract"
    ),
    workflow: {
      contentHash: contentHash(
        string(workflow.contentHash, "workflowSnapshot.workflow.contentHash")
      ),
      nodes: workflow.nodes.map((value, index) => {
        const path = `workflowSnapshot.workflow.nodes[${index}]`;
        const node = exactRecord(value, path, [
          "capability",
          "dependsOn",
          "humanGate",
          "key",
        ]);
        const humanGate = node.humanGate;
        return {
          capability: capability(node.capability, `${path}.capability`),
          dependsOn: strings(node.dependsOn, `${path}.dependsOn`),
          ...(humanGate === undefined
            ? {}
            : { humanGate: string(humanGate, `${path}.humanGate`) }),
          key: string(node.key, `${path}.key`),
        };
      }),
      revision: string(workflow.revision, "workflowSnapshot.workflow.revision"),
      workflowSpecId: workflowSpecId(
        string(
          workflow.workflowSpecId,
          "workflowSnapshot.workflow.workflowSpecId"
        )
      ),
    },
    workspaceId: workspaceId(
      string(item.workspaceId, "workflowSnapshot.workspaceId")
    ),
  };
};

export const parseAuthoritySnapshot = (value: unknown): AuthoritySnapshot => {
  const item = exactRecord(value, "authoritySnapshot", [
    "authorityEnvelopeId",
    "budgetLimit",
    "capabilities",
    "deadline",
    "permissions",
    "subjectActorId",
    "version",
    "workspaceId",
  ]);
  if (!Array.isArray(item.capabilities) || item.capabilities.length > 256) {
    throw new DatabasePayloadError(
      "authoritySnapshot.capabilities must be an array of at most 256 items."
    );
  }
  const capabilities = item.capabilities.map((value, index) =>
    capability(value, `authoritySnapshot.capabilities[${index}]`)
  );
  const capabilityKeys = capabilities.map(
    (item) => `${item.capabilityId}\u0000${item.capabilityVersion}`
  );
  if (new Set(capabilityKeys).size !== capabilityKeys.length) {
    throw new DatabasePayloadError(
      "authoritySnapshot.capabilities must not contain duplicate identities."
    );
  }
  return {
    authorityEnvelopeId: string(
      item.authorityEnvelopeId,
      "authoritySnapshot.authorityEnvelopeId"
    ),
    budgetLimit: budget(item.budgetLimit, "authoritySnapshot.budgetLimit"),
    capabilities,
    deadline: instant(
      nonNegativeInteger(item.deadline, "authoritySnapshot.deadline")
    ),
    permissions: strings(item.permissions, "authoritySnapshot.permissions"),
    subjectActorId: actorId(
      string(item.subjectActorId, "authoritySnapshot.subjectActorId")
    ),
    version: string(item.version, "authoritySnapshot.version"),
    workspaceId: workspaceId(
      string(item.workspaceId, "authoritySnapshot.workspaceId")
    ),
  };
};

export const parsePolicyPlanningSnapshot = (
  value: unknown
): PolicyPlanningSnapshot => {
  const item = exactRecord(value, "policySnapshot", [
    "policy",
    "snapshotId",
    "workspaceId",
  ]);
  const policy = exactRecord(item.policy, "policySnapshot.policy", [
    "factsHash",
    "maxAttemptsPerStep",
    "requiredPermission",
    "version",
  ]);
  const maxAttemptsPerStep =
    policy.maxAttemptsPerStep === undefined
      ? 1
      : nonNegativeInteger(
          policy.maxAttemptsPerStep,
          "policySnapshot.policy.maxAttemptsPerStep"
        );
  if (maxAttemptsPerStep < 1 || maxAttemptsPerStep > 100) {
    throw new DatabasePayloadError(
      "policySnapshot.policy.maxAttemptsPerStep must be between 1 and 100."
    );
  }
  return {
    policy: {
      factsHash: contentHash(
        string(policy.factsHash, "policySnapshot.policy.factsHash")
      ),
      maxAttemptsPerStep,
      requiredPermission: string(
        policy.requiredPermission,
        "policySnapshot.policy.requiredPermission"
      ),
      version: string(policy.version, "policySnapshot.policy.version"),
    },
    snapshotId: string(item.snapshotId, "policySnapshot.snapshotId"),
    workspaceId: workspaceId(
      string(item.workspaceId, "policySnapshot.workspaceId")
    ),
  };
};

export const parsePricingSnapshot = (value: unknown): PricingSnapshot => {
  const item = exactRecord(value, "pricingSnapshot", [
    "guarantee",
    "snapshotId",
    "ttlMilliseconds",
    "unit",
    "upperBound",
    "version",
    "workspaceId",
  ]);
  const guarantee = string(item.guarantee, "pricingSnapshot.guarantee");
  if (
    guarantee !== "estimated" &&
    guarantee !== "hard" &&
    guarantee !== "unknown"
  ) {
    throw new DatabasePayloadError("pricingSnapshot.guarantee is invalid.");
  }
  const upperBound = item.upperBound;
  const parsed: PricingSnapshot = {
    guarantee,
    snapshotId: string(item.snapshotId, "pricingSnapshot.snapshotId"),
    ttlMilliseconds: nonNegativeInteger(
      item.ttlMilliseconds,
      "pricingSnapshot.ttlMilliseconds"
    ),
    unit: string(item.unit, "pricingSnapshot.unit"),
    ...(upperBound === undefined
      ? {}
      : {
          upperBound: nonNegativeNumber(
            upperBound,
            "pricingSnapshot.upperBound"
          ),
        }),
    version: string(item.version, "pricingSnapshot.version"),
    workspaceId: workspaceId(
      string(item.workspaceId, "pricingSnapshot.workspaceId")
    ),
  };
  if (parsed.ttlMilliseconds === 0) {
    throw new DatabasePayloadError(
      "pricingSnapshot.ttlMilliseconds must be positive."
    );
  }
  if (parsed.guarantee === "hard" && parsed.upperBound === undefined) {
    throw new DatabasePayloadError(
      "pricingSnapshot.upperBound is required for a hard guarantee."
    );
  }
  return parsed;
};

export const parsePlanningDefaults = (value: unknown): PlanningDefaults => {
  const item = exactRecord(value, "planningDefaults", [
    "policySnapshotId",
    "pricingSnapshotId",
    "workspaceId",
  ]);
  return {
    policySnapshotId: string(
      item.policySnapshotId,
      "planningDefaults.policySnapshotId"
    ),
    pricingSnapshotId: string(
      item.pricingSnapshotId,
      "planningDefaults.pricingSnapshotId"
    ),
    workspaceId: workspaceId(
      string(item.workspaceId, "planningDefaults.workspaceId")
    ),
  };
};
