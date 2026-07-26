import type { CapabilityRef } from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

/**
 * Describes one execution route already admitted by the composition root.
 * Policy and pricing provenance are added by the planning use case.
 */
export type CapabilityRoute = Readonly<{
  capability: CapabilityRef;
  effectAdapterKey: string;
  /**
   * Stable namespace carried by restricted contact lineage. It is deliberately
   * independent from the executable adapter key because a selected contact can
   * be enriched by another provider without changing its source identity.
   */
  providerIdentityNamespace?: string;
  reservableUpperBound: number;
  reservationUnit: string;
  routeKey: string;
}>;

/**
 * Returns an in-memory snapshot only; implementations must not perform I/O
 * because recipe planning can consult this port inside a database transaction.
 */
export interface CapabilityRouteCatalogPort {
  listAvailable(scope: WorkspaceScope): readonly CapabilityRoute[];
}
