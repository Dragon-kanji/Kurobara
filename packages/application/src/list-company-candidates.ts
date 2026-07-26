import type { DatasetGenerationId, DomainResult } from "@kurobara/kernel";
import { fail } from "@kurobara/kernel";
import type {
  DatasetGenerationPersistencePort,
  DatasetRecordPageQueryPort,
  VerifiedApiKey,
} from "@kurobara/ports";

import {
  type CompanyCandidate,
  companyCandidateProjection,
} from "./company-candidate-projection.ts";
import {
  type ReadyGenerationCandidatePageFailureCode,
  type ReadyGenerationCandidatePageSuccess,
  readReadyGenerationCandidatePage,
} from "./ready-generation-candidate-page.ts";

export type { CompanyCandidate } from "./company-candidate-projection.ts";

export type ListCompanyCandidatesRequest = Readonly<{
  actor: VerifiedApiKey;
  afterOrdinal: number;
  generationId: DatasetGenerationId;
  limit: number;
}>;

export type ListCompanyCandidatesSuccess =
  ReadyGenerationCandidatePageSuccess<CompanyCandidate>;

export type ListCompanyCandidatesFailureCode =
  | ReadyGenerationCandidatePageFailureCode
  | "permission-missing";

export type ListCompanyCandidatesFailure = Readonly<{
  code: ListCompanyCandidatesFailureCode;
  message: string;
}>;

export type ListCompanyCandidatesResult = DomainResult<
  ListCompanyCandidatesSuccess,
  ListCompanyCandidatesFailure
>;

export type ListCompanyCandidatesDependencies = Readonly<{
  generations: DatasetGenerationPersistencePort;
  records: DatasetRecordPageQueryPort;
  requiredPermission?: string;
}>;

export const makeListCompanyCandidates = (
  dependencies: ListCompanyCandidatesDependencies
) => {
  const requiredPermission = dependencies.requiredPermission ?? "datasets:read";
  return (
    request: ListCompanyCandidatesRequest
  ): Promise<ListCompanyCandidatesResult> => {
    if (!request.actor.permissions.includes(requiredPermission)) {
      return Promise.resolve(
        fail({
          code: "permission-missing",
          message: `Company candidate reads require ${requiredPermission}.`,
        })
      );
    }
    return readReadyGenerationCandidatePage(
      dependencies,
      {
        afterOrdinal: request.afterOrdinal,
        generationId: request.generationId,
        limit: request.limit,
        workspaceId: request.actor.workspaceId,
      },
      companyCandidateProjection
    );
  };
};
