import type {
  AuthorityEnvelope,
  ContentHash,
  ContractRef,
  RunPlan,
  RunPlanId,
  WorkflowSpec,
  WorkflowSpecId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";
import type { ValidatedRunInput } from "./run-plan-input.ts";

export type PlanningCompilationLimits = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
}>;

export type WorkflowSnapshot = Readonly<{
  allowedCapabilities: readonly string[];
  catalogFingerprint: ContentHash;
  catalogVersion: string;
  compilationLimits: PlanningCompilationLimits;
  compilerVersion: string;
  inputContract: ContractRef;
  outputContract: ContractRef;
  workflow: WorkflowSpec;
  workspaceId: WorkspaceId;
}>;

export type AuthoritySnapshot = AuthorityEnvelope;

export type PolicyPlanningSnapshot = Readonly<{
  policy: Readonly<{
    factsHash: ContentHash;
    maxAttemptsPerStep: number;
    requiredPermission: string;
    version: string;
  }>;
  snapshotId: string;
  workspaceId: WorkspaceId;
}>;

export type PricingSnapshot = Readonly<{
  guarantee: "estimated" | "hard" | "unknown";
  snapshotId: string;
  ttlMilliseconds: number;
  unit: string;
  upperBound?: number;
  version: string;
  workspaceId: WorkspaceId;
}>;

export type PlanningDefaults = Readonly<{
  policySnapshotId: string;
  pricingSnapshotId: string;
  workspaceId: WorkspaceId;
}>;

export type VersionedPlanningDefaults = PlanningDefaults &
  Readonly<{ revision: number }>;

export type WorkflowSnapshotIdentity = Readonly<{
  workflowContentHash: ContentHash;
  workflowRevision: string;
  workflowSpecId: WorkflowSpecId;
}>;

export type RunPlanSources = WorkflowSnapshotIdentity &
  Readonly<{
    authorityEnvelopeId: string;
    policySnapshotId: string;
    pricingSnapshotId: string;
  }>;

export type PersistRunPlanInput = Readonly<{
  input?: ValidatedRunInput;
  plan: RunPlan;
  sources: RunPlanSources;
}>;

export interface PlanningSnapshotRepository {
  getAuthority(
    scope: WorkspaceScope,
    authorityEnvelopeId: string
  ): Promise<AuthoritySnapshot | undefined>;
  getDefaults(scope: WorkspaceScope): Promise<PlanningDefaults | undefined>;
  getPolicy(
    scope: WorkspaceScope,
    snapshotId: string
  ): Promise<PolicyPlanningSnapshot | undefined>;
  getPricing(
    scope: WorkspaceScope,
    snapshotId: string
  ): Promise<PricingSnapshot | undefined>;
  getWorkflow(
    scope: WorkspaceScope,
    identity: WorkflowSnapshotIdentity
  ): Promise<WorkflowSnapshot | undefined>;
}

export interface PlanningRunPlanRepository {
  insert(scope: WorkspaceScope, input: PersistRunPlanInput): Promise<void>;
}

export type PlanningUnitOfWork = Readonly<{
  runPlans: PlanningRunPlanRepository;
  snapshots: PlanningSnapshotRepository;
}>;

export interface PlanningPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: PlanningUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface PlanningIdentifierPort {
  nextQuoteId(): Promise<string>;
  nextRunPlanId(): Promise<RunPlanId>;
}

export type BootstrapPlanningInput = Readonly<{
  authorities: readonly AuthoritySnapshot[];
  defaults: PlanningDefaults;
  expectedDefaultsRevision: number | null;
  policies: readonly PolicyPlanningSnapshot[];
  pricing: readonly PricingSnapshot[];
  workflows: readonly WorkflowSnapshot[];
  workspaceId: WorkspaceId;
}>;

export type PlanningSnapshotApplyCounts = Readonly<{
  inserted: number;
  unchanged: number;
}>;

export type PlanningBundleApplyResult = Readonly<{
  defaults: Readonly<{
    current: VersionedPlanningDefaults;
    previous?: VersionedPlanningDefaults;
    state: "inserted" | "unchanged" | "updated";
  }>;
  snapshots: Readonly<{
    authorities: PlanningSnapshotApplyCounts;
    policies: PlanningSnapshotApplyCounts;
    pricing: PlanningSnapshotApplyCounts;
    workflows: PlanningSnapshotApplyCounts;
  }>;
  status: "applied" | "unchanged";
  workspace: "inserted" | "unchanged";
  workspaceId: WorkspaceId;
}>;
