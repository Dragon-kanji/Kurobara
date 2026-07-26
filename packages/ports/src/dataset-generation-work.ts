import type {
  ActorId,
  DatasetGenerationId,
  Instant,
  WorkspaceId,
} from "@kurobara/kernel";

export type DatasetGenerationWorkClaim = Readonly<{
  actorId: ActorId;
  actorPermissions: readonly string[];
  claimedBy: string;
  generationId: DatasetGenerationId;
  leaseExpiresAt: Instant;
  leaseToken: string;
  workspaceId: WorkspaceId;
}>;

export type ClaimNextDatasetGenerationWorkInput = Readonly<{
  claimedAt: Instant;
  claimedBy: string;
  claimLeaseMilliseconds: number;
  leaseToken: string;
}>;

export interface DatasetGenerationWorkPort {
  claimNext(
    input: ClaimNextDatasetGenerationWorkInput
  ): Promise<DatasetGenerationWorkClaim | undefined>;
  release(
    claim: DatasetGenerationWorkClaim
  ): Promise<Readonly<{ status: "released" | "stale" }>>;
}
