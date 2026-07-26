import type {
  AuthorityEnvelope,
  CapabilityRef,
  ContentHash,
  Instant,
  WorkspaceId,
} from "@kurobara/kernel";

export type PolicySnapshot = Readonly<{
  version: string;
  factsHash: ContentHash;
  requiredPermission: string;
}>;

export type PolicyFacts = Readonly<{
  workspaceId: WorkspaceId;
  capability: CapabilityRef;
  actorPermissions: readonly string[];
  authority: AuthorityEnvelope;
  now: Instant;
}>;

export type PolicyReasonCode =
  | "workspace-mismatch"
  | "permission-missing"
  | "capability-outside-authority"
  | "authority-deadline-elapsed"
  | "allowed";

export type PolicyDecision = Readonly<{
  allowed: boolean;
  policyVersion: string;
  factsHash: ContentHash;
  reasonCodes: readonly PolicyReasonCode[];
}>;

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

export const evaluatePolicy = (
  policy: PolicySnapshot,
  facts: PolicyFacts
): PolicyDecision => {
  const deniedReasons: PolicyReasonCode[] = [];

  if (facts.workspaceId !== facts.authority.workspaceId) {
    deniedReasons.push("workspace-mismatch");
  }
  if (
    !(
      facts.actorPermissions.includes(policy.requiredPermission) &&
      facts.authority.permissions.includes(policy.requiredPermission)
    )
  ) {
    deniedReasons.push("permission-missing");
  }
  if (
    facts.authority.capabilities.every(
      (authorizedCapability) =>
        !capabilityMatches(facts.capability, authorizedCapability)
    )
  ) {
    deniedReasons.push("capability-outside-authority");
  }
  if (facts.now >= facts.authority.deadline) {
    deniedReasons.push("authority-deadline-elapsed");
  }

  return {
    allowed: deniedReasons.length === 0,
    factsHash: policy.factsHash,
    policyVersion: policy.version,
    reasonCodes: deniedReasons.length === 0 ? ["allowed"] : deniedReasons,
  };
};
