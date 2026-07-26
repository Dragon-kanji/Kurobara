import {
  isSupportedAuthorityEnvelopeVersion,
  workspaceId,
} from "@kurobara/kernel";
import type {
  BootstrapPlanningInput,
  PersistRunPlanInput,
  PlanningBundleApplyResult,
  PlanningDefaults,
  PlanningPersistencePort,
  PlanningUnitOfWork,
  PolicyPlanningSnapshot,
  PricingSnapshot,
  ValidatedRunInput,
  VersionedPlanningDefaults,
  WorkflowSnapshot,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  ImmutableRecordConflictError,
  PlanningDefaultsConflictError,
  PostgresAdapterError,
} from "./errors.ts";
import { toJsonValue } from "./json.ts";
import {
  parseAuthoritySnapshot,
  parsePlanningDefaults,
  parsePolicyPlanningSnapshot,
  parsePricingSnapshot,
  parseWorkflowSnapshot,
} from "./planning-payload.ts";
import {
  parseRunPlanInputRow,
  parseValidatedRunInput,
  type RunPlanInputRow,
  runInputValuesMatch,
} from "./run-input-payload.ts";

type SnapshotRow = Readonly<{ snapshot: unknown }>;

type DefaultsRow = Readonly<{
  policy_snapshot_id: string;
  pricing_snapshot_id: string;
  workspace_id: string;
}>;

type DefaultsApplyResult = Readonly<{
  current: VersionedPlanningDefaults;
  previous?: VersionedPlanningDefaults;
  state: "inserted" | "unchanged" | "updated";
}>;

export type PlanningStateReadback = Readonly<{
  defaults: VersionedPlanningDefaults;
  policy: PolicyPlanningSnapshot;
  pricing: PricingSnapshot;
  snapshotCounts: Readonly<{
    authorities: number;
    policies: number;
    pricing: number;
    workflows: number;
  }>;
  workspaceId: WorkspaceScope["workspaceId"];
}>;

const parseRevision = (value: string, path: string): number => {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `${path} must be a positive safe integer.`
    );
  }
  return revision;
};

const parseCount = (value: string, path: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `${path} must be a non-negative safe integer.`
    );
  }
  return count;
};

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A planning transaction cannot access another workspace."
    );
  }
};

const assertWorkspace = (
  expected: WorkspaceScope["workspaceId"],
  actual: WorkspaceScope["workspaceId"],
  recordName: string
): void => {
  if (expected !== actual) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      `The ${recordName} belongs to another workspace.`
    );
  }
};

const assertStoredIdentity = (valid: boolean, recordName: string): void => {
  if (!valid) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      `The stored ${recordName} identity does not match its database key.`
    );
  }
};

const assertNonEmpty = (value: string, field: string): void => {
  if (value.length === 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `${field} must be a non-empty string.`
    );
  }
};

const insertWorkflowSnapshot = async (
  sql: postgres.Sql,
  expectedWorkspaceId: WorkspaceScope["workspaceId"],
  input: WorkflowSnapshot
): Promise<boolean> => {
  const snapshot = parseWorkflowSnapshot(toJsonValue(input));
  assertWorkspace(
    expectedWorkspaceId,
    snapshot.workspaceId,
    "workflow snapshot"
  );
  const inserted = await sql<readonly { inserted: number }[]>`
    INSERT INTO kurobara_core.workflow_snapshots (
      workspace_id,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      snapshot
    ) VALUES (
      ${snapshot.workspaceId},
      ${snapshot.workflow.workflowSpecId},
      ${snapshot.workflow.revision},
      ${snapshot.workflow.contentHash},
      ${sql.json(toJsonValue(snapshot))}
    )
    ON CONFLICT DO NOTHING
    RETURNING 1 AS inserted
  `;
  const rows = await sql<readonly { matches: boolean }[]>`
    SELECT (
      workflow_content_hash = ${snapshot.workflow.contentHash}
      AND snapshot = ${sql.json(toJsonValue(snapshot))}
    ) AS matches
    FROM kurobara_core.workflow_snapshots
    WHERE workspace_id = ${snapshot.workspaceId}
      AND workflow_spec_id = ${snapshot.workflow.workflowSpecId}
      AND workflow_revision = ${snapshot.workflow.revision}
  `;
  if (rows[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("workflow snapshot");
  }
  return inserted.length === 1;
};

const insertAuthoritySnapshot = async (
  sql: postgres.Sql,
  expectedWorkspaceId: WorkspaceScope["workspaceId"],
  input: BootstrapPlanningInput["authorities"][number]
): Promise<boolean> => {
  const snapshot = parseAuthoritySnapshot(toJsonValue(input));
  assertWorkspace(
    expectedWorkspaceId,
    snapshot.workspaceId,
    "authority snapshot"
  );
  if (!isSupportedAuthorityEnvelopeVersion(snapshot.version)) {
    throw new PostgresAdapterError(
      "authority-version-unsupported",
      "The authority snapshot version is not supported."
    );
  }
  const inserted = await sql<readonly { inserted: number }[]>`
    INSERT INTO kurobara_core.authority_snapshots (
      workspace_id,
      authority_envelope_id,
      snapshot
    ) VALUES (
      ${snapshot.workspaceId},
      ${snapshot.authorityEnvelopeId},
      ${sql.json(toJsonValue(snapshot))}
    )
    ON CONFLICT DO NOTHING
    RETURNING 1 AS inserted
  `;
  const rows = await sql<readonly { matches: boolean }[]>`
    SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
    FROM kurobara_core.authority_snapshots
    WHERE workspace_id = ${snapshot.workspaceId}
      AND authority_envelope_id = ${snapshot.authorityEnvelopeId}
  `;
  if (rows[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("authority snapshot");
  }
  return inserted.length === 1;
};

const insertPolicySnapshot = async (
  sql: postgres.Sql,
  expectedWorkspaceId: WorkspaceScope["workspaceId"],
  input: PolicyPlanningSnapshot
): Promise<boolean> => {
  const snapshot = parsePolicyPlanningSnapshot(toJsonValue(input));
  assertWorkspace(expectedWorkspaceId, snapshot.workspaceId, "policy snapshot");
  const inserted = await sql<readonly { inserted: number }[]>`
    INSERT INTO kurobara_core.policy_snapshots (
      workspace_id,
      snapshot_id,
      snapshot
    ) VALUES (
      ${snapshot.workspaceId},
      ${snapshot.snapshotId},
      ${sql.json(toJsonValue(snapshot))}
    )
    ON CONFLICT DO NOTHING
    RETURNING 1 AS inserted
  `;
  const rows = await sql<readonly { matches: boolean }[]>`
    SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
    FROM kurobara_core.policy_snapshots
    WHERE workspace_id = ${snapshot.workspaceId}
      AND snapshot_id = ${snapshot.snapshotId}
  `;
  if (rows[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("policy snapshot");
  }
  return inserted.length === 1;
};

const insertPricingSnapshot = async (
  sql: postgres.Sql,
  expectedWorkspaceId: WorkspaceScope["workspaceId"],
  input: PricingSnapshot
): Promise<boolean> => {
  const snapshot = parsePricingSnapshot(toJsonValue(input));
  assertWorkspace(
    expectedWorkspaceId,
    snapshot.workspaceId,
    "pricing snapshot"
  );
  const inserted = await sql<readonly { inserted: number }[]>`
    INSERT INTO kurobara_core.pricing_snapshots (
      workspace_id,
      snapshot_id,
      snapshot
    ) VALUES (
      ${snapshot.workspaceId},
      ${snapshot.snapshotId},
      ${sql.json(toJsonValue(snapshot))}
    )
    ON CONFLICT DO NOTHING
    RETURNING 1 AS inserted
  `;
  const rows = await sql<readonly { matches: boolean }[]>`
    SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
    FROM kurobara_core.pricing_snapshots
    WHERE workspace_id = ${snapshot.workspaceId}
      AND snapshot_id = ${snapshot.snapshotId}
  `;
  if (rows[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("pricing snapshot");
  }
  return inserted.length === 1;
};

const insertPlanningDefaults = async (
  sql: postgres.Sql,
  expectedWorkspaceId: WorkspaceScope["workspaceId"],
  input: PlanningDefaults,
  expectedRevision: number | null
): Promise<DefaultsApplyResult> => {
  const defaults = parsePlanningDefaults(toJsonValue(input));
  assertWorkspace(
    expectedWorkspaceId,
    defaults.workspaceId,
    "planning defaults"
  );
  if (expectedRevision === null) {
    const inserted = await sql<readonly { revision: string }[]>`
      INSERT INTO kurobara_core.planning_defaults (
        workspace_id,
        policy_snapshot_id,
        pricing_snapshot_id
      ) VALUES (
        ${defaults.workspaceId},
        ${defaults.policySnapshotId},
        ${defaults.pricingSnapshotId}
      )
      ON CONFLICT DO NOTHING
      RETURNING revision::text AS revision
    `;
    if (inserted[0] !== undefined) {
      return {
        current: {
          ...defaults,
          revision: parseRevision(
            inserted[0].revision,
            "planningDefaults.revision"
          ),
        },
        state: "inserted",
      };
    }
  }
  const rows = await sql<
    readonly {
      policy_snapshot_id: string;
      pricing_snapshot_id: string;
      revision: string;
    }[]
  >`
    SELECT policy_snapshot_id, pricing_snapshot_id, revision::text AS revision
    FROM kurobara_core.planning_defaults
    WHERE workspace_id = ${defaults.workspaceId}
    FOR UPDATE
  `;
  const current = rows[0];
  if (current === undefined) {
    throw new PlanningDefaultsConflictError(expectedRevision, null);
  }
  const currentRevision = parseRevision(
    current.revision,
    "planningDefaults.revision"
  );
  const currentDefaults: VersionedPlanningDefaults = {
    policySnapshotId: current.policy_snapshot_id,
    pricingSnapshotId: current.pricing_snapshot_id,
    revision: currentRevision,
    workspaceId: defaults.workspaceId,
  };
  if (
    current.policy_snapshot_id === defaults.policySnapshotId &&
    current.pricing_snapshot_id === defaults.pricingSnapshotId
  ) {
    return { current: currentDefaults, state: "unchanged" };
  }
  if (expectedRevision !== currentRevision) {
    throw new PlanningDefaultsConflictError(expectedRevision, currentRevision);
  }
  const updated = await sql<readonly { revision: string }[]>`
    UPDATE kurobara_core.planning_defaults
    SET
      policy_snapshot_id = ${defaults.policySnapshotId},
      pricing_snapshot_id = ${defaults.pricingSnapshotId},
      revision = revision + 1,
      updated_at = clock_timestamp()
    WHERE workspace_id = ${defaults.workspaceId}
      AND revision = ${expectedRevision}
    RETURNING revision::text AS revision
  `;
  const updatedRevisionRaw = updated[0]?.revision;
  if (updatedRevisionRaw === undefined) {
    throw new PlanningDefaultsConflictError(expectedRevision, currentRevision);
  }
  const updatedRevision = parseRevision(
    updatedRevisionRaw,
    "planningDefaults.revision"
  );
  const verified = await sql<readonly { matches: boolean }[]>`
    SELECT (
      policy_snapshot_id = ${defaults.policySnapshotId}
      AND pricing_snapshot_id = ${defaults.pricingSnapshotId}
      AND revision = ${updatedRevision}
    ) AS matches
    FROM kurobara_core.planning_defaults
    WHERE workspace_id = ${defaults.workspaceId}
  `;
  if (verified[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("planning defaults");
  }
  return {
    current: { ...defaults, revision: updatedRevision },
    previous: currentDefaults,
    state: "updated",
  };
};

const countApplyStates = (
  states: readonly boolean[]
): Readonly<{ inserted: number; unchanged: number }> => {
  const inserted = states.filter(Boolean).length;
  return { inserted, unchanged: states.length - inserted };
};

export const bootstrapPostgresPlanning = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput
): Promise<PlanningBundleApplyResult> => {
  if (
    input.expectedDefaultsRevision !== null &&
    (!Number.isSafeInteger(input.expectedDefaultsRevision) ||
      input.expectedDefaultsRevision < 1)
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "expectedDefaultsRevision must be null or a positive safe integer."
    );
  }
  const result = await sql.begin(async (transaction) => {
    const transactionSql = transaction as unknown as postgres.Sql;
    const workspaceRows = await transactionSql<readonly { inserted: number }[]>`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES (${input.workspaceId})
      ON CONFLICT (workspace_id) DO NOTHING
      RETURNING 1 AS inserted
    `;
    await transactionSql`
      SELECT workspace_id
      FROM kurobara_core.workspaces
      WHERE workspace_id = ${input.workspaceId}
      FOR UPDATE
    `;
    const workflowStates: boolean[] = [];
    for (const workflow of input.workflows) {
      workflowStates.push(
        await insertWorkflowSnapshot(
          transactionSql,
          input.workspaceId,
          workflow
        )
      );
    }
    const authorityStates: boolean[] = [];
    for (const authority of input.authorities) {
      authorityStates.push(
        await insertAuthoritySnapshot(
          transactionSql,
          input.workspaceId,
          authority
        )
      );
    }
    const policyStates: boolean[] = [];
    for (const policy of input.policies) {
      policyStates.push(
        await insertPolicySnapshot(transactionSql, input.workspaceId, policy)
      );
    }
    const pricingStates: boolean[] = [];
    for (const pricing of input.pricing) {
      pricingStates.push(
        await insertPricingSnapshot(transactionSql, input.workspaceId, pricing)
      );
    }
    const defaultsResult = await insertPlanningDefaults(
      transactionSql,
      input.workspaceId,
      input.defaults,
      input.expectedDefaultsRevision
    );
    const snapshots = {
      authorities: countApplyStates(authorityStates),
      policies: countApplyStates(policyStates),
      pricing: countApplyStates(pricingStates),
      workflows: countApplyStates(workflowStates),
    };
    const applied =
      workspaceRows.length === 1 ||
      defaultsResult.state !== "unchanged" ||
      Object.values(snapshots).some(({ inserted }) => inserted > 0);
    return {
      defaults: defaultsResult,
      snapshots,
      status: applied ? "applied" : "unchanged",
      workspace: workspaceRows.length === 1 ? "inserted" : "unchanged",
      workspaceId: input.workspaceId,
    } satisfies PlanningBundleApplyResult;
  });
  return result as unknown as PlanningBundleApplyResult;
};

export const readPostgresPlanningState = async (
  sql: postgres.Sql,
  requestedWorkspaceId: string
): Promise<PlanningStateReadback | undefined> => {
  const parsedWorkspaceId = workspaceId(requestedWorkspaceId);
  const rows = await sql<
    readonly {
      authority_count: string;
      policy_count: string;
      policy_snapshot: unknown;
      policy_snapshot_id: string;
      pricing_count: string;
      pricing_snapshot: unknown;
      pricing_snapshot_id: string;
      revision: string;
      workflow_count: string;
      workspace_id: string;
    }[]
  >`
    SELECT
      defaults.workspace_id,
      defaults.policy_snapshot_id,
      defaults.pricing_snapshot_id,
      defaults.revision::text AS revision,
      policy.snapshot AS policy_snapshot,
      pricing.snapshot AS pricing_snapshot,
      (SELECT count(*)::text FROM kurobara_core.authority_snapshots
        WHERE workspace_id = ${parsedWorkspaceId}) AS authority_count,
      (SELECT count(*)::text FROM kurobara_core.policy_snapshots
        WHERE workspace_id = ${parsedWorkspaceId}) AS policy_count,
      (SELECT count(*)::text FROM kurobara_core.pricing_snapshots
        WHERE workspace_id = ${parsedWorkspaceId}) AS pricing_count,
      (SELECT count(*)::text FROM kurobara_core.workflow_snapshots
        WHERE workspace_id = ${parsedWorkspaceId}) AS workflow_count
    FROM kurobara_core.planning_defaults AS defaults
    JOIN kurobara_core.policy_snapshots AS policy
      ON policy.workspace_id = defaults.workspace_id
      AND policy.snapshot_id = defaults.policy_snapshot_id
    JOIN kurobara_core.pricing_snapshots AS pricing
      ON pricing.workspace_id = defaults.workspace_id
      AND pricing.snapshot_id = defaults.pricing_snapshot_id
    WHERE defaults.workspace_id = ${parsedWorkspaceId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  const defaults = parsePlanningDefaults({
    policySnapshotId: row.policy_snapshot_id,
    pricingSnapshotId: row.pricing_snapshot_id,
    workspaceId: row.workspace_id,
  });
  const policy = parsePolicyPlanningSnapshot(row.policy_snapshot);
  const pricing = parsePricingSnapshot(row.pricing_snapshot);
  assertStoredIdentity(
    defaults.workspaceId === parsedWorkspaceId,
    "planning defaults"
  );
  assertStoredIdentity(
    policy.workspaceId === parsedWorkspaceId &&
      policy.snapshotId === defaults.policySnapshotId,
    "active policy snapshot"
  );
  assertStoredIdentity(
    pricing.workspaceId === parsedWorkspaceId &&
      pricing.snapshotId === defaults.pricingSnapshotId,
    "active pricing snapshot"
  );
  return {
    defaults: {
      ...defaults,
      revision: parseRevision(row.revision, "planningDefaults.revision"),
    },
    policy,
    pricing,
    snapshotCounts: {
      authorities: parseCount(row.authority_count, "authoritySnapshot.count"),
      policies: parseCount(row.policy_count, "policySnapshot.count"),
      pricing: parseCount(row.pricing_count, "pricingSnapshot.count"),
      workflows: parseCount(row.workflow_count, "workflowSnapshot.count"),
    },
    workspaceId: parsedWorkspaceId,
  };
};

const verifyWorkflowSnapshots = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput
): Promise<boolean> => {
  for (const source of input.workflows) {
    const snapshot = parseWorkflowSnapshot(toJsonValue(source));
    const rows = await sql<readonly { matches: boolean }[]>`
      SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
      FROM kurobara_core.workflow_snapshots
      WHERE workspace_id = ${input.workspaceId}
        AND workflow_spec_id = ${snapshot.workflow.workflowSpecId}
        AND workflow_revision = ${snapshot.workflow.revision}
        AND workflow_content_hash = ${snapshot.workflow.contentHash}
    `;
    if (rows[0]?.matches !== true) {
      return false;
    }
  }
  return true;
};

const verifyAuthoritySnapshots = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput
): Promise<boolean> => {
  for (const source of input.authorities) {
    const snapshot = parseAuthoritySnapshot(toJsonValue(source));
    const rows = await sql<readonly { matches: boolean }[]>`
      SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
      FROM kurobara_core.authority_snapshots
      WHERE workspace_id = ${input.workspaceId}
        AND authority_envelope_id = ${snapshot.authorityEnvelopeId}
    `;
    if (rows[0]?.matches !== true) {
      return false;
    }
  }
  return true;
};

const verifyPolicySnapshots = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput
): Promise<boolean> => {
  for (const source of input.policies) {
    const snapshot = parsePolicyPlanningSnapshot(toJsonValue(source));
    const rows = await sql<readonly { matches: boolean }[]>`
      SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
      FROM kurobara_core.policy_snapshots
      WHERE workspace_id = ${input.workspaceId}
        AND snapshot_id = ${snapshot.snapshotId}
    `;
    if (rows[0]?.matches !== true) {
      return false;
    }
  }
  return true;
};

const verifyPricingSnapshots = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput
): Promise<boolean> => {
  for (const source of input.pricing) {
    const snapshot = parsePricingSnapshot(toJsonValue(source));
    const rows = await sql<readonly { matches: boolean }[]>`
      SELECT snapshot = ${sql.json(toJsonValue(snapshot))} AS matches
      FROM kurobara_core.pricing_snapshots
      WHERE workspace_id = ${input.workspaceId}
        AND snapshot_id = ${snapshot.snapshotId}
    `;
    if (rows[0]?.matches !== true) {
      return false;
    }
  }
  return true;
};

export const verifyPostgresPlanningBundle = async (
  sql: postgres.Sql,
  input: BootstrapPlanningInput,
  expectedDefaultsRevision: number
): Promise<boolean> => {
  const result = await sql.begin(
    "isolation level repeatable read read only",
    async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const defaults = parsePlanningDefaults(toJsonValue(input.defaults));
      const defaultsRows = await transactionSql<
        readonly { matches: boolean }[]
      >`
        SELECT (
          policy_snapshot_id = ${defaults.policySnapshotId}
          AND pricing_snapshot_id = ${defaults.pricingSnapshotId}
          AND revision = ${expectedDefaultsRevision}
        ) AS matches
        FROM kurobara_core.planning_defaults
        WHERE workspace_id = ${input.workspaceId}
      `;
      if (defaultsRows[0]?.matches !== true) {
        return false;
      }
      return (
        (await verifyWorkflowSnapshots(transactionSql, input)) &&
        (await verifyAuthoritySnapshots(transactionSql, input)) &&
        (await verifyPolicySnapshots(transactionSql, input)) &&
        (await verifyPricingSnapshots(transactionSql, input))
      );
    }
  );
  return result as unknown as boolean;
};

const assertPlanSources = (
  scope: WorkspaceScope,
  input: PersistRunPlanInput
): void => {
  const { plan, sources } = input;
  assertWorkspace(scope.workspaceId, plan.workspaceId, "run plan");
  assertWorkspace(
    scope.workspaceId,
    plan.authority.workspaceId,
    "run-plan authority"
  );
  assertNonEmpty(sources.authorityEnvelopeId, "authorityEnvelopeId");
  assertNonEmpty(sources.policySnapshotId, "policySnapshotId");
  assertNonEmpty(sources.pricingSnapshotId, "pricingSnapshotId");
  if (
    plan.compiledWorkflow.workflowSpecId !== sources.workflowSpecId ||
    plan.compiledWorkflow.workflowRevision !== sources.workflowRevision ||
    plan.compiledWorkflow.workflowContentHash !== sources.workflowContentHash ||
    plan.authority.authorityEnvelopeId !== sources.authorityEnvelopeId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The run plan does not match its immutable planning sources."
    );
  }
};

const sameJsonValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(toJsonValue(left)) === JSON.stringify(toJsonValue(right));

const runInputsMatch = (
  left: ValidatedRunInput,
  right: ValidatedRunInput
): boolean =>
  left.inputId === right.inputId &&
  left.contentHash === right.contentHash &&
  sameJsonValue(left.contract, right.contract) &&
  left.classification === right.classification &&
  left.mediaType === right.mediaType &&
  left.sizeBytes === right.sizeBytes &&
  left.validatorVersion === right.validatorVersion &&
  left.validatedAt === right.validatedAt &&
  left.finalizedAt === right.finalizedAt &&
  runInputValuesMatch(left.value, right.value);

const assertPlanMatchesStoredSources = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PersistRunPlanInput
): Promise<void> => {
  const { plan, sources } = input;
  const workflowRows = await sql<readonly SnapshotRow[]>`
    SELECT snapshot
    FROM kurobara_core.workflow_snapshots
    WHERE workspace_id = ${scope.workspaceId}
      AND workflow_spec_id = ${sources.workflowSpecId}
      AND workflow_revision = ${sources.workflowRevision}
      AND workflow_content_hash = ${sources.workflowContentHash}
  `;
  const authorityRows = await sql<readonly SnapshotRow[]>`
    SELECT snapshot
    FROM kurobara_core.authority_snapshots
    WHERE workspace_id = ${scope.workspaceId}
      AND authority_envelope_id = ${sources.authorityEnvelopeId}
  `;
  const policyRows = await sql<readonly SnapshotRow[]>`
    SELECT snapshot
    FROM kurobara_core.policy_snapshots
    WHERE workspace_id = ${scope.workspaceId}
      AND snapshot_id = ${sources.policySnapshotId}
  `;
  const pricingRows = await sql<readonly SnapshotRow[]>`
    SELECT snapshot
    FROM kurobara_core.pricing_snapshots
    WHERE workspace_id = ${scope.workspaceId}
      AND snapshot_id = ${sources.pricingSnapshotId}
  `;
  const workflowRow = workflowRows[0];
  const authorityRow = authorityRows[0];
  const policyRow = policyRows[0];
  const pricingRow = pricingRows[0];
  if (
    workflowRow === undefined ||
    authorityRow === undefined ||
    policyRow === undefined ||
    pricingRow === undefined
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The run plan references an unavailable planning snapshot."
    );
  }

  const workflow = parseWorkflowSnapshot(workflowRow.snapshot);
  const authority = parseAuthoritySnapshot(authorityRow.snapshot);
  const policy = parsePolicyPlanningSnapshot(policyRow.snapshot);
  const pricing = parsePricingSnapshot(pricingRow.snapshot);
  const pricingMatches =
    plan.quote.pricingVersion === pricing.version &&
    plan.quote.guarantee === pricing.guarantee &&
    plan.quote.unit === pricing.unit &&
    plan.quote.upperBound === pricing.upperBound;
  const workflowMatches =
    plan.catalogVersion === workflow.catalogVersion &&
    plan.catalogFingerprint === workflow.catalogFingerprint &&
    plan.compiledWorkflow.compilerVersion === workflow.compilerVersion &&
    sameJsonValue(plan.inputContract, workflow.inputContract) &&
    sameJsonValue(plan.outputContract, workflow.outputContract);
  const policyMatches =
    plan.policyVersion === policy.policy.version &&
    plan.policyFactsHash === policy.policy.factsHash &&
    plan.retryPolicy.maxAttemptsPerStep === policy.policy.maxAttemptsPerStep;
  if (
    !(
      sameJsonValue(plan.authority, authority) &&
      workflowMatches &&
      policyMatches &&
      pricingMatches
    )
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The run plan payload does not match its immutable planning snapshots."
    );
  }
};

const insertRunPlan = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PersistRunPlanInput
): Promise<void> => {
  assertPlanSources(scope, input);
  await assertPlanMatchesStoredSources(sql, scope, input);
  const planJson = toJsonValue(input.plan);
  await sql`
    INSERT INTO kurobara_core.run_plans (
      workspace_id,
      run_plan_id,
      plan
    ) VALUES (
      ${scope.workspaceId},
      ${input.plan.runPlanId},
      ${sql.json(planJson)}
    )
    ON CONFLICT DO NOTHING
  `;
  const plans = await sql<readonly { matches: boolean }[]>`
    SELECT plan = ${sql.json(planJson)} AS matches
    FROM kurobara_core.run_plans
    WHERE workspace_id = ${scope.workspaceId}
      AND run_plan_id = ${input.plan.runPlanId}
  `;
  if (plans[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("run plan");
  }

  const { sources } = input;
  await sql`
    INSERT INTO kurobara_core.run_plan_sources (
      workspace_id,
      run_plan_id,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      authority_envelope_id,
      policy_snapshot_id,
      pricing_snapshot_id
    ) VALUES (
      ${scope.workspaceId},
      ${input.plan.runPlanId},
      ${sources.workflowSpecId},
      ${sources.workflowRevision},
      ${sources.workflowContentHash},
      ${sources.authorityEnvelopeId},
      ${sources.policySnapshotId},
      ${sources.pricingSnapshotId}
    )
    ON CONFLICT DO NOTHING
  `;
  const provenance = await sql<readonly { matches: boolean }[]>`
    SELECT (
      workflow_spec_id = ${sources.workflowSpecId}
      AND workflow_revision = ${sources.workflowRevision}
      AND workflow_content_hash = ${sources.workflowContentHash}
      AND authority_envelope_id = ${sources.authorityEnvelopeId}
      AND policy_snapshot_id = ${sources.policySnapshotId}
      AND pricing_snapshot_id = ${sources.pricingSnapshotId}
    ) AS matches
    FROM kurobara_core.run_plan_sources
    WHERE workspace_id = ${scope.workspaceId}
      AND run_plan_id = ${input.plan.runPlanId}
  `;
  if (provenance[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("run-plan provenance");
  }

  if (input.input === undefined) {
    return;
  }
  const runInput = parseValidatedRunInput(toJsonValue(input.input));
  if (
    runInput.contentHash !== input.plan.normalizedInputHash ||
    !sameJsonValue(runInput.contract, input.plan.inputContract)
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The normalized run input does not match its immutable run plan."
    );
  }
  await sql`
    INSERT INTO kurobara_core.run_plan_inputs (
      workspace_id,
      run_plan_id,
      input_id,
      content_hash,
      contract,
      normalized_payload,
      classification,
      media_type,
      size_bytes,
      validator_version,
      validated_at,
      finalized_at
    ) VALUES (
      ${scope.workspaceId},
      ${input.plan.runPlanId},
      ${runInput.inputId},
      ${runInput.contentHash},
      ${sql.json(toJsonValue(runInput.contract))},
      ${sql.json(toJsonValue(runInput.value))},
      ${runInput.classification},
      ${runInput.mediaType},
      ${runInput.sizeBytes},
      ${runInput.validatorVersion},
      ${new Date(runInput.validatedAt)},
      ${new Date(runInput.finalizedAt)}
    )
    ON CONFLICT DO NOTHING
  `;
  const storedRows = await sql<readonly RunPlanInputRow[]>`
    SELECT
      workspace_id,
      run_plan_id,
      input_id,
      content_hash,
      contract,
      normalized_payload,
      classification,
      media_type,
      size_bytes,
      validator_version,
      validated_at,
      finalized_at
    FROM kurobara_core.run_plan_inputs
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        run_plan_id = ${input.plan.runPlanId}
        OR input_id = ${runInput.inputId}
      )
  `;
  const stored = storedRows[0];
  if (
    storedRows.length !== 1 ||
    stored === undefined ||
    stored.workspace_id !== scope.workspaceId ||
    stored.run_plan_id !== input.plan.runPlanId ||
    !runInputsMatch(parseRunPlanInputRow(stored), runInput)
  ) {
    throw new ImmutableRecordConflictError("run-plan input");
  }
};

export const createPostgresPlanningUnitOfWork = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): PlanningUnitOfWork => ({
  runPlans: {
    insert: async (scope, input) => {
      assertScope(transactionScope, scope);
      await insertRunPlan(sql, scope, input);
    },
  },
  snapshots: {
    getAuthority: async (scope, authorityEnvelopeId) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly SnapshotRow[]>`
        SELECT snapshot
        FROM kurobara_core.authority_snapshots
        WHERE workspace_id = ${scope.workspaceId}
          AND authority_envelope_id = ${authorityEnvelopeId}
      `;
      if (rows[0] === undefined) {
        return;
      }
      const snapshot = parseAuthoritySnapshot(rows[0].snapshot);
      assertStoredIdentity(
        snapshot.workspaceId === scope.workspaceId &&
          snapshot.authorityEnvelopeId === authorityEnvelopeId,
        "authority snapshot"
      );
      return snapshot;
    },
    getDefaults: async (scope) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly DefaultsRow[]>`
        SELECT workspace_id, policy_snapshot_id, pricing_snapshot_id
        FROM kurobara_core.planning_defaults
        WHERE workspace_id = ${scope.workspaceId}
      `;
      if (rows[0] === undefined) {
        return;
      }
      const defaults = parsePlanningDefaults({
        policySnapshotId: rows[0].policy_snapshot_id,
        pricingSnapshotId: rows[0].pricing_snapshot_id,
        workspaceId: rows[0].workspace_id,
      });
      assertStoredIdentity(
        defaults.workspaceId === scope.workspaceId,
        "planning defaults"
      );
      return defaults;
    },
    getPolicy: async (scope, snapshotId) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly SnapshotRow[]>`
        SELECT snapshot
        FROM kurobara_core.policy_snapshots
        WHERE workspace_id = ${scope.workspaceId}
          AND snapshot_id = ${snapshotId}
      `;
      if (rows[0] === undefined) {
        return;
      }
      const snapshot = parsePolicyPlanningSnapshot(rows[0].snapshot);
      assertStoredIdentity(
        snapshot.workspaceId === scope.workspaceId &&
          snapshot.snapshotId === snapshotId,
        "policy snapshot"
      );
      return snapshot;
    },
    getPricing: async (scope, snapshotId) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly SnapshotRow[]>`
        SELECT snapshot
        FROM kurobara_core.pricing_snapshots
        WHERE workspace_id = ${scope.workspaceId}
          AND snapshot_id = ${snapshotId}
      `;
      if (rows[0] === undefined) {
        return;
      }
      const snapshot = parsePricingSnapshot(rows[0].snapshot);
      assertStoredIdentity(
        snapshot.workspaceId === scope.workspaceId &&
          snapshot.snapshotId === snapshotId,
        "pricing snapshot"
      );
      return snapshot;
    },
    getWorkflow: async (scope, identity) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly SnapshotRow[]>`
        SELECT snapshot
        FROM kurobara_core.workflow_snapshots
        WHERE workspace_id = ${scope.workspaceId}
          AND workflow_spec_id = ${identity.workflowSpecId}
          AND workflow_revision = ${identity.workflowRevision}
          AND workflow_content_hash = ${identity.workflowContentHash}
      `;
      if (rows[0] === undefined) {
        return;
      }
      const snapshot = parseWorkflowSnapshot(rows[0].snapshot);
      assertStoredIdentity(
        snapshot.workspaceId === scope.workspaceId &&
          snapshot.workflow.workflowSpecId === identity.workflowSpecId &&
          snapshot.workflow.revision === identity.workflowRevision &&
          snapshot.workflow.contentHash === identity.workflowContentHash,
        "workflow snapshot"
      );
      return snapshot;
    },
  },
});

export const makePostgresPlanning = (
  sql: postgres.Sql
): PlanningPersistencePort => ({
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: PlanningUnitOfWork) => Promise<Value>
  ) => {
    const result = await sql.begin((transaction) =>
      work(
        createPostgresPlanningUnitOfWork(
          transaction as unknown as postgres.Sql,
          scope
        )
      )
    );
    return result as unknown as Value;
  },
});
