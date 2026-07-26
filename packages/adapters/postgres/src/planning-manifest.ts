import {
  isSupportedAuthorityEnvelopeVersion,
  workspaceId,
} from "@kurobara/kernel";
import type { BootstrapPlanningInput } from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";
import {
  parseAuthoritySnapshot,
  parsePlanningDefaults,
  parsePolicyPlanningSnapshot,
  parsePricingSnapshot,
  parseWorkflowSnapshot,
} from "./planning-payload.ts";

export const PLANNING_BUNDLE_FORMAT_VERSION = "1.0.0";
const MAX_SNAPSHOTS_PER_KIND = 256;

type JsonRecord = Record<string, unknown>;

export type PlanningBundleManifest = Readonly<{
  formatVersion: typeof PLANNING_BUNDLE_FORMAT_VERSION;
  planning: BootstrapPlanningInput;
}>;

const exactRecord = (
  value: unknown,
  path: string,
  allowedKeys: readonly string[]
): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  const item = Object.fromEntries(Object.entries(value)) as JsonRecord;
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(item).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new DatabasePayloadError(`${path}.${unknownKey} is not supported.`);
  }
  return item;
};

const array = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOTS_PER_KIND) {
    throw new DatabasePayloadError(
      `${path} must be an array of at most ${MAX_SNAPSHOTS_PER_KIND} items.`
    );
  }
  return value;
};

const expectedRevision = (value: unknown): number | null => {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DatabasePayloadError(
      "manifest.planning.expectedDefaultsRevision must be null or a positive safe integer."
    );
  }
  return value as number;
};

const assertUnique = (values: readonly string[], path: string): void => {
  if (new Set(values).size !== values.length) {
    throw new DatabasePayloadError(`${path} contains duplicate identities.`);
  }
};

export const parsePlanningBundleManifest = (
  value: unknown
): PlanningBundleManifest => {
  const manifest = exactRecord(value, "manifest", [
    "formatVersion",
    "planning",
  ]);
  if (manifest.formatVersion !== PLANNING_BUNDLE_FORMAT_VERSION) {
    throw new DatabasePayloadError(
      `manifest.formatVersion must be ${PLANNING_BUNDLE_FORMAT_VERSION}.`
    );
  }
  const planning = exactRecord(manifest.planning, "manifest.planning", [
    "authorities",
    "defaults",
    "expectedDefaultsRevision",
    "policies",
    "pricing",
    "workflows",
    "workspaceId",
  ]);
  if (typeof planning.workspaceId !== "string") {
    throw new DatabasePayloadError(
      "manifest.planning.workspaceId must be a string."
    );
  }
  const parsedWorkspaceId = workspaceId(planning.workspaceId);
  const parsed: BootstrapPlanningInput = {
    authorities: array(
      planning.authorities,
      "manifest.planning.authorities"
    ).map(parseAuthoritySnapshot),
    defaults: parsePlanningDefaults(planning.defaults),
    expectedDefaultsRevision: expectedRevision(
      planning.expectedDefaultsRevision
    ),
    policies: array(planning.policies, "manifest.planning.policies").map(
      parsePolicyPlanningSnapshot
    ),
    pricing: array(planning.pricing, "manifest.planning.pricing").map(
      parsePricingSnapshot
    ),
    workflows: array(planning.workflows, "manifest.planning.workflows").map(
      parseWorkflowSnapshot
    ),
    workspaceId: parsedWorkspaceId,
  };

  const scoped = [
    parsed.defaults,
    ...parsed.authorities,
    ...parsed.policies,
    ...parsed.pricing,
    ...parsed.workflows,
  ];
  if (scoped.some((item) => item.workspaceId !== parsedWorkspaceId)) {
    throw new DatabasePayloadError(
      "Every planning snapshot must belong to manifest.planning.workspaceId."
    );
  }
  if (
    parsed.authorities.some(
      (authority) => !isSupportedAuthorityEnvelopeVersion(authority.version)
    )
  ) {
    throw new DatabasePayloadError(
      "The planning bundle contains an unsupported authority version."
    );
  }
  assertUnique(
    parsed.authorities.map((item) => item.authorityEnvelopeId),
    "manifest.planning.authorities"
  );
  assertUnique(
    parsed.policies.map((item) => item.snapshotId),
    "manifest.planning.policies"
  );
  assertUnique(
    parsed.pricing.map((item) => item.snapshotId),
    "manifest.planning.pricing"
  );
  assertUnique(
    parsed.workflows.map(
      (item) => `${item.workflow.workflowSpecId}\u0000${item.workflow.revision}`
    ),
    "manifest.planning.workflows"
  );

  return {
    formatVersion: PLANNING_BUNDLE_FORMAT_VERSION,
    planning: parsed,
  };
};
