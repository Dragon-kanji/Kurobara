import { datasetGenerationId, instant, workspaceId } from "@kurobara/kernel";
import type {
  ClaimNextDatasetGenerationWorkInput,
  DatasetGenerationWorkClaim,
  DatasetGenerationWorkPort,
} from "@kurobara/ports";
import type postgres from "postgres";

import { parseDatasetGenerationPlanRecord } from "./dataset-generation-plan-payload.ts";
import { PostgresAdapterError } from "./errors.ts";

type CandidateRow = Readonly<{
  generation_id: string;
  plan_payload: unknown;
  workspace_id: string;
}>;

const assertClaimInput = (input: ClaimNextDatasetGenerationWorkInput): void => {
  if (
    !Number.isSafeInteger(input.claimLeaseMilliseconds) ||
    input.claimLeaseMilliseconds <= 0 ||
    input.claimLeaseMilliseconds > 300_000 ||
    input.claimedBy.length === 0 ||
    input.claimedBy.length > 128 ||
    input.claimedBy.trim() !== input.claimedBy ||
    input.leaseToken.length === 0 ||
    input.leaseToken.length > 255 ||
    input.leaseToken.trim() !== input.leaseToken
  ) {
    throw new PostgresAdapterError(
      "dataset-generation-work-claim-invalid",
      "A generation work claim requires bounded identities and a positive lease of at most 300000ms."
    );
  }
};

const claimNext = async (
  sql: postgres.Sql,
  input: ClaimNextDatasetGenerationWorkInput
): Promise<DatasetGenerationWorkClaim | undefined> => {
  assertClaimInput(input);
  const claimedAt = new Date(input.claimedAt);
  const leaseExpiresAt = instant(
    input.claimedAt + input.claimLeaseMilliseconds
  );
  const claimedUntil = new Date(leaseExpiresAt);

  const result = await sql.begin(async (transaction) => {
    const transactionSql = transaction as unknown as postgres.Sql;
    const candidates = await transactionSql<readonly CandidateRow[]>`
      SELECT
        generation.workspace_id,
        generation.generation_id,
        generation_plan.payload AS plan_payload
      FROM kurobara_core.dataset_generations AS generation
      JOIN kurobara_core.dataset_generation_pages AS page
        ON page.workspace_id = generation.workspace_id
        AND page.generation_id = generation.generation_id
        AND page.page_sequence = generation.page_count
      JOIN kurobara_core.runs AS page_run
        ON page_run.workspace_id = page.workspace_id
        AND page_run.run_id = page.run_id
      JOIN kurobara_core.dataset_generation_plans AS generation_plan
        ON generation_plan.workspace_id = generation.workspace_id
        AND generation_plan.generation_plan_id = generation.generation_plan_id
      LEFT JOIN kurobara_core.dataset_generation_work_leases AS work_lease
        ON work_lease.workspace_id = generation.workspace_id
        AND work_lease.generation_id = generation.generation_id
      WHERE generation.state IN ('running', 'stopping')
        AND (
          (
            page.state = 'executing'
            AND page_run.run ->> 'state' IN (
              'ambiguous', 'cancelled', 'completed', 'failed'
            )
          )
          OR (
            page.state = 'committed'
            AND page.has_more
            AND page.next_cursor IS NOT NULL
            AND generation.last_committed_page_sequence = page.page_sequence
            AND NOT EXISTS (
              SELECT 1
              FROM kurobara_core.dataset_generation_pages AS next_page
              WHERE next_page.workspace_id = generation.workspace_id
                AND next_page.generation_id = generation.generation_id
                AND next_page.page_sequence = page.page_sequence + 1
            )
          )
        )
        AND (
          work_lease.claimed_until IS NULL
          OR work_lease.claimed_until <= ${claimedAt}
        )
      ORDER BY COALESCE(page.committed_at, page.created_at), generation.generation_id
      FOR UPDATE OF generation SKIP LOCKED
      LIMIT 1
    `;
    const [candidate] = candidates;
    if (candidate === undefined) {
      return;
    }

    const leased = await transactionSql<readonly { generation_id: string }[]>`
      INSERT INTO kurobara_core.dataset_generation_work_leases (
        workspace_id,
        generation_id,
        lease_token,
        claimed_by,
        claimed_at,
        claimed_until,
        updated_at
      ) VALUES (
        ${candidate.workspace_id},
        ${candidate.generation_id},
        ${input.leaseToken},
        ${input.claimedBy},
        ${claimedAt},
        ${claimedUntil},
        ${claimedAt}
      )
      ON CONFLICT (workspace_id, generation_id) DO UPDATE SET
        lease_token = EXCLUDED.lease_token,
        claimed_by = EXCLUDED.claimed_by,
        claimed_at = EXCLUDED.claimed_at,
        claimed_until = EXCLUDED.claimed_until,
        updated_at = EXCLUDED.updated_at
      WHERE kurobara_core.dataset_generation_work_leases.claimed_until
        <= EXCLUDED.claimed_at
      RETURNING generation_id
    `;
    if (leased.length !== 1) {
      return;
    }

    const storedPlan = parseDatasetGenerationPlanRecord(candidate.plan_payload);
    if (
      storedPlan.plan.workspaceId !== candidate.workspace_id ||
      storedPlan.plan.authority.workspaceId !== candidate.workspace_id ||
      storedPlan.plan.authority.subjectActorId !==
        storedPlan.plan.requestIntent.actorId
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "The claimed generation authority does not match its immutable plan."
      );
    }
    return Object.freeze({
      actorId: storedPlan.plan.authority.subjectActorId,
      actorPermissions: Object.freeze([
        ...storedPlan.plan.authority.permissions,
      ]),
      claimedBy: input.claimedBy,
      generationId: datasetGenerationId(candidate.generation_id),
      leaseExpiresAt,
      leaseToken: input.leaseToken,
      workspaceId: workspaceId(candidate.workspace_id),
    });
  });
  return result as unknown as DatasetGenerationWorkClaim | undefined;
};

const release = async (
  sql: postgres.Sql,
  claim: DatasetGenerationWorkClaim
): Promise<Readonly<{ status: "released" | "stale" }>> => {
  const deleted = await sql<readonly { generation_id: string }[]>`
    DELETE FROM kurobara_core.dataset_generation_work_leases
    WHERE workspace_id = ${claim.workspaceId}
      AND generation_id = ${claim.generationId}
      AND lease_token = ${claim.leaseToken}
      AND claimed_by = ${claim.claimedBy}
    RETURNING generation_id
  `;
  return { status: deleted.length === 1 ? "released" : "stale" };
};

export const createPostgresDatasetGenerationWork = (
  sql: postgres.Sql
): DatasetGenerationWorkPort => ({
  claimNext: (input) => claimNext(sql, input),
  release: (claim) => release(sql, claim),
});
