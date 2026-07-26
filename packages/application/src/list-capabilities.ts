import {
  type CapabilityRef,
  type DomainResult,
  fail,
  isSupportedAuthorityEnvelopeVersion,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  CapabilityCatalogPort,
  ClockPort,
  PlanningPersistencePort,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

const MAX_CAPABILITIES = 256;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export type ListCapabilitiesRequest = Readonly<{
  actor: VerifiedApiKey;
  authorityEnvelopeId: string;
}>;

export type ListCapabilitiesFailureCode =
  | "authority-permission-missing"
  | "authority-subject-mismatch"
  | "deadline-elapsed"
  | "request-invalid"
  | "service-unavailable";

export type ListCapabilitiesFailure = Readonly<{
  code: ListCapabilitiesFailureCode;
  message: string;
}>;

export type ListCapabilitiesSuccess = Readonly<{
  authorityEnvelopeId: string;
  capabilities: readonly CapabilityRef[];
  workspaceId: WorkspaceId;
}>;

export type ListCapabilitiesResult = DomainResult<
  ListCapabilitiesSuccess,
  ListCapabilitiesFailure
>;

export type ListCapabilitiesDependencies = Readonly<{
  catalog: CapabilityCatalogPort;
  clock: ClockPort;
  persistence: PlanningPersistencePort;
  requiredPermission: string;
}>;

const capabilityKey = (capability: CapabilityRef): string =>
  `${capability.capabilityId}\u0000${capability.capabilityVersion}`;

const compareCapabilities = (
  left: CapabilityRef,
  right: CapabilityRef
): number => {
  const leftKey = capabilityKey(left);
  const rightKey = capabilityKey(right);
  if (leftKey < rightKey) {
    return -1;
  }
  return leftKey === rightKey ? 0 : 1;
};

const isValidCapability = (capability: CapabilityRef): boolean =>
  capability.capabilityId.trim().length > 0 &&
  capability.capabilityId.length <= 255 &&
  SEMVER_PATTERN.test(capability.capabilityVersion);

export const makeListCapabilities =
  (dependencies: ListCapabilitiesDependencies) =>
  async (request: ListCapabilitiesRequest): Promise<ListCapabilitiesResult> => {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks capability discovery permission.",
      });
    }
    if (
      request.authorityEnvelopeId.trim().length === 0 ||
      request.authorityEnvelopeId.length > 255
    ) {
      return fail({
        code: "request-invalid",
        message: "The capability discovery request contains an invalid value.",
      });
    }

    const scope: WorkspaceScope = { workspaceId: request.actor.workspaceId };
    const authority = await dependencies.persistence.transaction(
      scope,
      async (unitOfWork) =>
        unitOfWork.snapshots.getAuthority(scope, request.authorityEnvelopeId)
    );

    if (
      authority === undefined ||
      authority.authorityEnvelopeId !== request.authorityEnvelopeId ||
      authority.workspaceId !== scope.workspaceId ||
      authority.subjectActorId !== request.actor.actorId
    ) {
      return fail({
        code: "authority-subject-mismatch",
        message:
          "The requested authority does not authorize the authenticated actor.",
      });
    }
    if (!isSupportedAuthorityEnvelopeVersion(authority.version)) {
      return fail({
        code: "service-unavailable",
        message: "The authority envelope version is not supported.",
      });
    }
    if (!authority.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message: "The authority envelope does not permit capability discovery.",
      });
    }
    if (authority.deadline <= (await dependencies.clock.now())) {
      return fail({
        code: "deadline-elapsed",
        message: "The authority deadline has elapsed.",
      });
    }

    const available = await dependencies.catalog.listAvailable(scope);
    if (!available.every(isValidCapability)) {
      return fail({
        code: "service-unavailable",
        message: "The capability registry contains an invalid entry.",
      });
    }

    const allowed = new Set(authority.capabilities.map(capabilityKey));
    const capabilities = [
      ...new Map(
        available
          .filter((capability) => allowed.has(capabilityKey(capability)))
          .map((capability) => [capabilityKey(capability), capability])
      ).values(),
    ].sort(compareCapabilities);
    if (capabilities.length > MAX_CAPABILITIES) {
      return fail({
        code: "service-unavailable",
        message: "The capability discovery result exceeds its public bound.",
      });
    }
    if (authority.deadline <= (await dependencies.clock.now())) {
      return fail({
        code: "deadline-elapsed",
        message: "The authority deadline has elapsed.",
      });
    }

    return succeed({
      authorityEnvelopeId: authority.authorityEnvelopeId,
      capabilities,
      workspaceId: scope.workspaceId,
    });
  };
