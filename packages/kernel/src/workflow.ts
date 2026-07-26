import type {
  CapabilityId,
  ContentHash,
  WorkflowSpecId,
} from "./value-objects.ts";

export type CapabilityRef = Readonly<{
  capabilityId: CapabilityId;
  capabilityVersion: string;
}>;

export type WorkflowNode = Readonly<{
  key: string;
  capability: CapabilityRef;
  dependsOn: readonly string[];
  humanGate?: string;
}>;

export type WorkflowSpec = Readonly<{
  workflowSpecId: WorkflowSpecId;
  revision: string;
  contentHash: ContentHash;
  nodes: readonly WorkflowNode[];
}>;

export type CompiledWorkflowNode = Readonly<{
  key: string;
  capability: CapabilityRef;
  dependsOn: readonly string[];
  depth: number;
  humanGate?: string;
}>;

export type CompiledWorkflow = Readonly<{
  workflowSpecId: WorkflowSpecId;
  workflowRevision: string;
  workflowContentHash: ContentHash;
  compilerVersion: string;
  fingerprint: string;
  nodes: readonly CompiledWorkflowNode[];
}>;
