import type {
  DatasetGenerationId,
  DomainResult,
  WorkspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationPersistencePort,
  DatasetRecordPageQueryPort,
} from "@kurobara/ports";

import {
  type CompanyCandidate,
  companyCandidateProjection,
} from "./company-candidate-projection.ts";
import {
  type ReadyGenerationCandidatePageFailure,
  type ReadyGenerationCandidatePageSuccess,
  readReadyGenerationCandidatePage,
} from "./ready-generation-candidate-page.ts";

export const MAX_CONTACT_PARENT_COMPANIES_PER_PAGE = 10;

export type LoadReadyCompanyCandidatesRequest = Readonly<{
  afterOrdinal: number;
  generationId: DatasetGenerationId;
  limit: number;
  workspaceId: WorkspaceId;
}>;

export type LoadReadyCompanyCandidatesResult = DomainResult<
  ReadyGenerationCandidatePageSuccess<CompanyCandidate>,
  ReadyGenerationCandidatePageFailure
>;

export type LoadReadyCompanyCandidatesDependencies = Readonly<{
  generations: DatasetGenerationPersistencePort;
  records: DatasetRecordPageQueryPort;
}>;

/** Internal, bounded source loader for a future contact shortlist composition. */
export const makeLoadReadyCompanyCandidates =
  (dependencies: LoadReadyCompanyCandidatesDependencies) =>
  (
    request: LoadReadyCompanyCandidatesRequest
  ): Promise<LoadReadyCompanyCandidatesResult> =>
    readReadyGenerationCandidatePage(
      dependencies,
      request,
      companyCandidateProjection,
      MAX_CONTACT_PARENT_COMPANIES_PER_PAGE
    );
