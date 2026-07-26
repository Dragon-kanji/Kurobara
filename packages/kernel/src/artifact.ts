import type { ContractRef } from "./run.ts";
import type {
  ArtifactId,
  AttemptId,
  ContentHash,
  Instant,
  OperationKey,
  RunId,
  StepRunId,
  WorkspaceId,
} from "./value-objects.ts";

export type ArtifactRef = Readonly<{
  artifactId: ArtifactId;
  contentHash: ContentHash;
}>;

export type Artifact = Readonly<{
  artifactId: ArtifactId;
  attemptId: AttemptId;
  classification: "internal";
  contentHash: ContentHash;
  contract: ContractRef;
  finalizedAt: Instant;
  kind: "normalized-output";
  mediaType: "application/json";
  operationKey: OperationKey;
  retentionPolicy: "run";
  runId: RunId;
  sizeBytes: number;
  state: "finalized";
  stepRunId: StepRunId;
  validatedAt: Instant;
  validatorVersion: string;
  workspaceId: WorkspaceId;
}>;

export type ValidatedOutputRef = Readonly<{
  artifact: ArtifactRef;
  contract: ContractRef;
  validatedAt: Instant;
  validatorVersion: string;
}>;

export const artifactRef = (artifact: Artifact): ArtifactRef => ({
  artifactId: artifact.artifactId,
  contentHash: artifact.contentHash,
});
