import {
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  type DomainResult,
  fail,
  succeed,
} from "@kurobara/kernel";

import type {
  AuthorizeDatasetGenerationPageRequest,
  AuthorizeDatasetGenerationPageResult,
} from "./authorize-first-dataset-generation-page.ts";
import type {
  CreateDatasetGenerationRequest,
  CreateDatasetGenerationResult,
} from "./create-dataset-generation.ts";
import type {
  PlanDatasetGenerationRequest,
  PlanDatasetGenerationResult,
} from "./plan-dataset-generation.ts";

export type DiscoverOrganizationsRequest = Readonly<{
  execution: Omit<AuthorizeDatasetGenerationPageRequest, "generationId">;
  mode: "dry_run" | "start";
  planning: PlanDatasetGenerationRequest;
}>;

export type DiscoverOrganizationsSuccess =
  | Readonly<{
      mode: "dry_run";
      plan: DatasetGenerationPlan;
      replayed: boolean;
      status: "planned";
    }>
  | Readonly<{
      creation: DatasetGenerationCreation;
      mode: "start";
      page?: DatasetGenerationPage;
      plan: DatasetGenerationPlan;
      replayed: boolean;
      status: "ready" | "running";
    }>;

export type DiscoverOrganizationsFailure = Readonly<{
  code: string;
  message: string;
  stage: "authorization" | "creation" | "planning";
}>;

export type DiscoverOrganizationsResult = DomainResult<
  DiscoverOrganizationsSuccess,
  DiscoverOrganizationsFailure
>;

export type DiscoverOrganizationsDependencies = Readonly<{
  authorizePage: (
    request: AuthorizeDatasetGenerationPageRequest
  ) => Promise<AuthorizeDatasetGenerationPageResult>;
  createGeneration: (
    request: CreateDatasetGenerationRequest
  ) => Promise<CreateDatasetGenerationResult>;
  planGeneration: (
    request: PlanDatasetGenerationRequest
  ) => Promise<PlanDatasetGenerationResult>;
}>;

/**
 * Provider-neutral application facade used by HTTP/CLI/MCP.
 * Dry-run stops after immutable admission; start materializes and authorizes at
 * most one canonical page Run. Workers continue through the same page use case.
 */
export const makeDiscoverOrganizations =
  (dependencies: DiscoverOrganizationsDependencies) =>
  async (
    request: DiscoverOrganizationsRequest
  ): Promise<DiscoverOrganizationsResult> => {
    const planned = await dependencies.planGeneration(request.planning);
    if (!planned.ok) {
      return fail({
        code: planned.error.code,
        message: planned.error.message,
        stage: "planning",
      });
    }
    if (request.mode === "dry_run") {
      return succeed({
        mode: "dry_run",
        plan: planned.value.plan,
        replayed: planned.value.replayed,
        status: "planned",
      });
    }
    const created = await dependencies.createGeneration({
      generationPlanId: planned.value.plan.generationPlanId,
      workspaceId: request.planning.workspaceId,
    });
    if (!created.ok) {
      return fail({
        code: created.error.code,
        message: created.error.message,
        stage: "creation",
      });
    }
    const creation = created.value.creation;
    if (creation.generation.state === "completed") {
      return succeed({
        creation,
        mode: "start",
        plan: planned.value.plan,
        replayed: true,
        status: "ready",
      });
    }
    if (
      creation.generation.state === "running" &&
      creation.generation.cost.reserved > 0
    ) {
      return succeed({
        creation,
        mode: "start",
        plan: planned.value.plan,
        replayed: true,
        status: "running",
      });
    }
    const authorized = await dependencies.authorizePage({
      ...request.execution,
      generationId: creation.generation.generationId,
    });
    if (!authorized.ok) {
      return fail({
        code: authorized.error.code,
        message: authorized.error.message,
        stage: "authorization",
      });
    }
    return succeed({
      creation,
      mode: "start",
      page: authorized.value.page,
      plan: planned.value.plan,
      replayed:
        planned.value.replayed ||
        created.value.replayed ||
        authorized.value.replayed,
      status: "running",
    });
  };
