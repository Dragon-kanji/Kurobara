import type { CapabilityRef } from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

/**
 * Reports capability revisions backed by execution adapters that are actually
 * composed for the current runtime. Authority is applied by the application.
 */
export interface CapabilityCatalogPort {
  listAvailable(scope: WorkspaceScope): Promise<readonly CapabilityRef[]>;
}
