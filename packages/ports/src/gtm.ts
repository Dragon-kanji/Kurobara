import type {
  ActorId,
  DatasetId,
  DatasetMaterializationId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { RecipeApplicationId } from "./recipe-persistence.ts";
import type { WorkspaceScope } from "./run-persistence.ts";

export type GtmAssertionState =
  | "confirmed"
  | "imported_unverified"
  | "inferred"
  | "not_applicable"
  | "unknown";

export type GtmAnswerValue = boolean | number | string | readonly string[];

export type GtmAssertionProvenance = Readonly<{
  actorId?: ActorId;
  recordedAtMs: number;
  source: "agent" | "human" | "import";
}>;

export type GtmContextAssertion = Readonly<{
  provenance: GtmAssertionProvenance;
  questionId: string;
  state: GtmAssertionState;
  value?: GtmAnswerValue;
}>;

export type GtmContextDocument = Readonly<{
  assertions: readonly GtmContextAssertion[];
  contextId: string;
  name: string;
  questionnaireVersion: string;
}>;

export type GtmContextRevisionRef = Readonly<{
  contextId: string;
  fingerprint: string;
  revision: number;
}>;

export type StoredGtmContextRevision = GtmContextRevisionRef &
  Readonly<{
    createdAtMs: number;
    createdByActorId: ActorId;
    document: GtmContextDocument;
    workspaceId: WorkspaceId;
  }>;

export type GtmContextRevisionWrite = Readonly<{
  createdAtMs: number;
  createdByActorId: ActorId;
  document: GtmContextDocument;
  expectedBaseRevision?: number;
  fingerprint: string;
}>;

export type GtmContextRevisionWriteResult =
  | Readonly<{
      revision: StoredGtmContextRevision;
      status: "created" | "existing";
    }>
  | Readonly<{
      status: "conflict";
    }>;

export type GtmPlayOrganizationSearchSource = Readonly<{
  countries: readonly string[];
  industries: readonly string[];
  keywords: readonly string[];
  kind: "organization_search";
}>;

export type GtmPlayImportedDatasetSource = Readonly<{
  datasetId: DatasetId;
  defaultCountryCode?: string;
  fieldMapping: Readonly<{
    countryCode?: string;
    domain: string;
    name?: string;
  }>;
  kind: "imported_dataset";
  materializationId: DatasetMaterializationId;
}>;

export type GtmPlaySource =
  | GtmPlayImportedDatasetSource
  | GtmPlayOrganizationSearchSource;

export type GtmPlayDefinition = Readonly<{
  approvals: Readonly<{
    export: boolean;
    providerSpend: boolean;
    reveal: boolean;
  }>;
  authorityEnvelopeId: string;
  audience: Readonly<{
    companyCountries: readonly string[];
    departments: readonly string[];
    personCountries: readonly string[];
    seniorities: readonly string[];
    titles: readonly string[];
  }>;
  broadening: "forbidden" | "human_approval";
  budget: Readonly<{
    limit: number;
    unit: string;
  }>;
  capabilities: readonly string[];
  contextRef: GtmContextRevisionRef;
  deadlineMs: number;
  delivery: Readonly<{
    mode: "no_send";
    privateExport: boolean;
  }>;
  exclusions: readonly string[];
  objective: Readonly<{
    metric: string;
    target: number;
    text: string;
  }>;
  playId: string;
  preview: Readonly<{
    maxCompanies: number;
    maxContactsPerCompany: number;
    maxContactsTotal: number;
    maxProviderCalls: number;
    sampleSize: number;
  }>;
  selection: Readonly<{
    minimumScore: number;
    requiredSignals: readonly string[];
  }>;
  source: GtmPlaySource;
  stopConditions: readonly string[];
}>;

export type GtmPlayLifecycle =
  | "active"
  | "approved"
  | "awaiting_approval"
  | "draft"
  | "paused"
  | "previewed"
  | "retired"
  | "validated";

export type GtmCompiledStage = Readonly<{
  capability?: string;
  inputFingerprint: string;
  operationId: string;
  ordinal: number;
}>;

export type GtmPlayCompilation = Readonly<{
  assumptions: readonly string[];
  authority: Readonly<{
    humanGates: readonly string[];
    permissions: readonly string[];
  }>;
  budget: Readonly<{
    limit: number;
    quotedUpperBound: number;
    unit: string;
  }>;
  deadlineMs: number;
  exportMode: "no_send";
  intentionHash: string;
  stages: readonly GtmCompiledStage[];
}>;

export type StoredGtmPlayRevision = Readonly<{
  compilation: GtmPlayCompilation;
  createdAtMs: number;
  createdByActorId: ActorId;
  definition: GtmPlayDefinition;
  fingerprint: string;
  lifecycle: GtmPlayLifecycle;
  playId: string;
  revision: number;
  workspaceId: WorkspaceId;
}>;

export type GtmPlayRevisionWrite = Readonly<{
  compilation: GtmPlayCompilation;
  createdAtMs: number;
  createdByActorId: ActorId;
  definition: GtmPlayDefinition;
  expectedBaseRevision?: number;
  fingerprint: string;
  lifecycle: GtmPlayLifecycle;
}>;

export type GtmPlayRevisionWriteResult =
  | Readonly<{
      revision: StoredGtmPlayRevision;
      status: "created" | "existing";
    }>
  | Readonly<{
      status: "conflict";
    }>;

export type GtmPlayRunState =
  | "cancelled"
  | "completed"
  | "failed"
  | "paused"
  | "queued"
  | "running";

export type GtmPlayRunStageState =
  | "completed"
  | "failed"
  | "pending"
  | "running";

export type GtmPlayRunStageReceipt = Readonly<{
  cost: Readonly<{
    reserved: number;
    spent: number;
    unit: string;
  }>;
  datasetId?: DatasetId;
  generationId?: string;
  materializationId?: DatasetMaterializationId;
  operationId: string;
  ordinal: number;
  providerCalls: number;
  recordCount?: number;
  state: GtmPlayRunStageState;
}>;

export type GtmPlayRunResult = Readonly<{
  datasetId: DatasetId;
  exportReady: boolean;
  materializationId: DatasetMaterializationId;
  recordCount: number;
  workbookId: string;
}>;

export type GtmPlayRunExecution = Readonly<{
  cost: Readonly<{
    reserved: number;
    spent: number;
    unit: string;
  }>;
  currentStageOrdinal?: number;
  error?: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
  providerCalls: number;
  provenance: readonly string[];
  result?: GtmPlayRunResult;
  selectedRecordIds: readonly string[];
  selectionReasons: readonly GtmWorkbookSelectionReason[];
  stages: readonly GtmPlayRunStageReceipt[];
}>;

export type GtmPlayRunActor = Readonly<{
  actorId: ActorId;
  authenticationMode: "api-key";
  permissions: readonly string[];
}>;

export type StoredGtmPlayRun = Readonly<{
  compilation: GtmPlayCompilation;
  createdAtMs: number;
  definition: GtmPlayDefinition;
  execution: GtmPlayRunExecution;
  executionActor: GtmPlayRunActor;
  idempotencyKey: string;
  playId: string;
  playRevision: number;
  revision: number;
  runId: string;
  state: GtmPlayRunState;
  updatedAtMs: number;
  workspaceId: WorkspaceId;
}>;

export type GtmPlayRunWrite = Readonly<{
  compilation: GtmPlayCompilation;
  createdAtMs: number;
  definition: GtmPlayDefinition;
  execution: GtmPlayRunExecution;
  executionActor: GtmPlayRunActor;
  idempotencyKey: string;
  playId: string;
  playRevision: number;
  runId: string;
}>;

export type GtmPlayRunWriteResult =
  | Readonly<{
      run: StoredGtmPlayRun;
      status: "created" | "existing";
    }>
  | Readonly<{
      status: "conflict";
    }>;

export type GtmPlayRunUpdate = Readonly<{
  claimToken: string;
  execution: GtmPlayRunExecution;
  expectedRevision: number;
  runId: string;
  state: GtmPlayRunState;
  updatedAtMs: number;
}>;

export type GtmPlayRunUpdateResult =
  | Readonly<{ status: "conflict" | "not_found" }>
  | Readonly<{ run: StoredGtmPlayRun; status: "updated" }>;

export type GtmPlayRunClaim = Readonly<{
  claimExpiresAtMs: number;
  claimToken: string;
  run: StoredGtmPlayRun;
  workerId: string;
}>;

export type GtmWorkbookFilter = Readonly<{
  fieldKey: string;
  operator: "equals" | "is_not_null";
  value?: boolean | number | string;
}>;

export type GtmWorkbookSelectionReason = Readonly<{
  reasons: readonly string[];
  recordId: string;
}>;

export type GtmWorkbookAnnotation = Readonly<{
  createdAtMs: number;
  createdByActorId: ActorId;
  note: string;
  recordId: string;
}>;

export type GtmWorkbookApproval = Readonly<{
  createdAtMs: number;
  createdByActorId: ActorId;
  decision: "approved" | "rejected";
  recordId: string;
}>;

export type GtmWorkbookView = Readonly<{
  annotations: readonly GtmWorkbookAnnotation[];
  approvals: readonly GtmWorkbookApproval[];
  columnOrder: readonly string[];
  contextRef?: GtmContextRevisionRef;
  datasetId: DatasetId;
  filters: readonly GtmWorkbookFilter[];
  materializationId: DatasetMaterializationId;
  name: string;
  playId?: string;
  playRevision?: number;
  playRunId?: string;
  recipeApplicationId?: RecipeApplicationId;
  revision: number;
  selectionReasons: readonly GtmWorkbookSelectionReason[];
  selectedRecordIds: readonly string[];
  workbookId: string;
  workspaceId: WorkspaceId;
}>;

export type GtmWorkbookViewWrite = Readonly<{
  annotations: readonly GtmWorkbookAnnotation[];
  approvals: readonly GtmWorkbookApproval[];
  columnOrder: readonly string[];
  contextRef?: GtmContextRevisionRef;
  datasetId: DatasetId;
  expectedRevision: number;
  filters: readonly GtmWorkbookFilter[];
  materializationId: DatasetMaterializationId;
  name: string;
  playId?: string;
  playRevision?: number;
  playRunId?: string;
  recipeApplicationId?: RecipeApplicationId;
  selectionReasons: readonly GtmWorkbookSelectionReason[];
  selectedRecordIds: readonly string[];
  workbookId: string;
}>;

export type GtmWorkbookViewWriteResult =
  | Readonly<{
      status: "conflict";
    }>
  | Readonly<{
      status: "created" | "updated";
      view: GtmWorkbookView;
    }>;

export interface GtmPersistencePort {
  activateContext(
    scope: WorkspaceScope,
    reference: GtmContextRevisionRef
  ): Promise<void>;
  claimNextPlayRun(
    workerId: string,
    claimToken: string,
    nowMs: number,
    leaseMs: number
  ): Promise<GtmPlayRunClaim | undefined>;
  createPlayRun(
    scope: WorkspaceScope,
    input: GtmPlayRunWrite
  ): Promise<GtmPlayRunWriteResult>;
  getActiveContext(
    scope: WorkspaceScope
  ): Promise<StoredGtmContextRevision | undefined>;
  getContextRevision(
    scope: WorkspaceScope,
    contextId: string,
    revision?: number
  ): Promise<StoredGtmContextRevision | undefined>;
  getLatestContext(
    scope: WorkspaceScope
  ): Promise<StoredGtmContextRevision | undefined>;
  getPlayRevision(
    scope: WorkspaceScope,
    playId: string,
    revision?: number
  ): Promise<StoredGtmPlayRevision | undefined>;
  getPlayRun(
    scope: WorkspaceScope,
    runId: string
  ): Promise<StoredGtmPlayRun | undefined>;
  getWorkbookView(
    scope: WorkspaceScope,
    workbookId: string
  ): Promise<GtmWorkbookView | undefined>;
  putContextRevision(
    scope: WorkspaceScope,
    input: GtmContextRevisionWrite
  ): Promise<GtmContextRevisionWriteResult>;
  putPlayRevision(
    scope: WorkspaceScope,
    input: GtmPlayRevisionWrite
  ): Promise<GtmPlayRevisionWriteResult>;
  putWorkbookView(
    scope: WorkspaceScope,
    input: GtmWorkbookViewWrite
  ): Promise<GtmWorkbookViewWriteResult>;
  updatePlayRun(
    scope: WorkspaceScope,
    input: GtmPlayRunUpdate
  ): Promise<GtmPlayRunUpdateResult>;
}
