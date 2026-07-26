import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createPostgresRuntime,
  ImmutableRecordConflictError,
  PostgresAdapterError,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  actorId,
  capabilityId,
  contentHash,
  instant,
  type RunPlan,
  runPlanId,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  BootstrapPlanningInput,
  PersistRunPlanInput,
  RunPlanSources,
  ValidatedRunInput,
} from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_planning_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
});

after(async () => {
  if (runtime !== undefined) {
    await runtime.close();
  }
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const hash = (value: string) =>
  contentHash(`sha256:${createHash("sha256").update(value).digest("hex")}`);

const planningInput = (
  workspace: WorkspaceId,
  marker: string
): BootstrapPlanningInput => {
  const capability = {
    capabilityId: capabilityId("documents.summarize"),
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/inputs/document/1.0.0",
    schemaVersion: "1.0.0",
  };
  return {
    authorities: [
      {
        authorityEnvelopeId: "authority-shared",
        budgetLimit: {
          limit: 10,
          reserved: 0,
          spent: 0,
          unit: "credits",
        },
        capabilities: [capability],
        deadline: instant(20_000),
        permissions: ["plans:quote", "runs:create"],
        subjectActorId: actorId(`actor-${marker}`),
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    defaults: {
      policySnapshotId: "policy-default",
      pricingSnapshotId: "pricing-default",
      workspaceId: workspace,
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash(marker),
          maxAttemptsPerStep: 3,
          requiredPermission: "plans:quote",
          version: "1.0.0",
        },
        snapshotId: "policy-default",
        workspaceId: workspace,
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-default",
        ttlMilliseconds: 30_000,
        unit: "credits",
        upperBound: marker === "a" ? 5 : 7,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    workflows: [
      {
        allowedCapabilities: [capability.capabilityId],
        catalogFingerprint: hash("a"),
        catalogVersion: "1.0.0",
        compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
        compilerVersion: "1.0.0",
        inputContract: contract,
        outputContract: {
          ...contract,
          schemaId: "https://schemas.kurobara.invalid/outputs/summary/1.0.0",
        },
        workflow: {
          contentHash: hash("f"),
          nodes: [{ capability, dependsOn: [], key: "summarize" }],
          revision: "1.0.0",
          workflowSpecId: workflowSpecId("workflow-shared"),
        },
        workspaceId: workspace,
      },
    ],
    workspaceId: workspace,
  };
};

const planFrom = (
  input: BootstrapPlanningInput,
  identifier: string
): Readonly<{ plan: RunPlan; sources: RunPlanSources }> => {
  const workflow = input.workflows[0];
  const authority = input.authorities[0];
  const policy = input.policies[0];
  const pricing = input.pricing[0];
  if (
    workflow === undefined ||
    authority === undefined ||
    policy === undefined ||
    pricing === undefined
  ) {
    throw new Error("Planning fixture is incomplete.");
  }
  const plan: RunPlan = {
    authority,
    budget: { limit: 5, reserved: 5, spent: 0, unit: "credits" },
    catalogFingerprint: workflow.catalogFingerprint,
    catalogVersion: workflow.catalogVersion,
    compiledWorkflow: {
      compilerVersion: workflow.compilerVersion,
      fingerprint: `compiled-${identifier}`,
      nodes: workflow.workflow.nodes.map((node) => ({
        ...node,
        depth: 0,
      })),
      workflowContentHash: workflow.workflow.contentHash,
      workflowRevision: workflow.workflow.revision,
      workflowSpecId: workflow.workflow.workflowSpecId,
    },
    deadline: instant(15_000),
    inputContract: workflow.inputContract,
    normalizedInputHash: hash("c"),
    outputContract: workflow.outputContract,
    planHash: hash(identifier),
    policyFactsHash: policy.policy.factsHash,
    policyVersion: policy.policy.version,
    quote: {
      expiresAt: instant(10_000),
      guarantee: pricing.guarantee,
      pricingVersion: pricing.version,
      quoteId: `quote-${identifier}`,
      unit: pricing.unit,
      ...(pricing.upperBound === undefined
        ? {}
        : { upperBound: pricing.upperBound }),
    },
    retryPolicy: {
      maxAttemptsPerStep: policy.policy.maxAttemptsPerStep,
    },
    runPlanId: runPlanId(`plan-${identifier}`),
    workspaceId: input.workspaceId,
  };
  return {
    plan,
    sources: {
      authorityEnvelopeId: authority.authorityEnvelopeId,
      policySnapshotId: policy.snapshotId,
      pricingSnapshotId: pricing.snapshotId,
      workflowContentHash: workflow.workflow.contentHash,
      workflowRevision: workflow.workflow.revision,
      workflowSpecId: workflow.workflow.workflowSpecId,
    },
  };
};

const planWithInputFrom = (
  input: BootstrapPlanningInput,
  identifier: string
): PersistRunPlanInput & Readonly<{ input: ValidatedRunInput }> => {
  const persisted = planFrom(input, identifier);
  const value = { document: `synthetic-${identifier}` } as const;
  const canonical = JSON.stringify(value);
  const normalizedInputHash = hash(canonical);
  return {
    ...persisted,
    input: {
      classification: "internal",
      contentHash: normalizedInputHash,
      contract: persisted.plan.inputContract,
      finalizedAt: instant(2000),
      inputId: `input-${identifier}`,
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(canonical, "utf8"),
      validatedAt: instant(2000),
      validatorVersion: "synthetic-input-validator-v1",
      value,
    },
    plan: { ...persisted.plan, normalizedInputHash },
  };
};

test("persists immutable tenant-scoped planning inputs and plan provenance", async () => {
  const workspaceA = workspaceId("workspace-planning-a");
  const workspaceB = workspaceId("workspace-planning-b");
  const inputA = planningInput(workspaceA, "a");
  const inputB = planningInput(workspaceB, "b");
  const policyA = inputA.policies[0];
  if (policyA === undefined) {
    throw new Error("Planning fixture has no policy snapshot.");
  }

  const firstApply = await runtime.bootstrapPlanning(inputA);
  const replayApply = await runtime.bootstrapPlanning(inputA);
  const concurrentReplays = await Promise.all([
    runtime.bootstrapPlanning(inputA),
    runtime.bootstrapPlanning(inputA),
  ]);
  const tenantBApply = await runtime.bootstrapPlanning(inputB);
  assert.equal(firstApply.status, "applied");
  assert.equal(firstApply.defaults.state, "inserted");
  assert.equal(firstApply.defaults.current.revision, 1);
  assert.deepEqual(firstApply.snapshots.authorities, {
    inserted: 1,
    unchanged: 0,
  });
  assert.equal(replayApply.status, "unchanged");
  assert.equal(replayApply.defaults.state, "unchanged");
  assert.equal(replayApply.defaults.current.revision, 1);
  assert.ok(concurrentReplays.every((result) => result.status === "unchanged"));
  assert.equal(tenantBApply.status, "applied");

  const workflowIdentity = {
    workflowContentHash: hash("f"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-shared"),
  } as const;
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    async ({ snapshots }) => {
      assert.deepEqual(
        await snapshots.getWorkflow(
          { workspaceId: workspaceA },
          workflowIdentity
        ),
        inputA.workflows[0]
      );
      assert.deepEqual(
        await snapshots.getAuthority(
          { workspaceId: workspaceA },
          "authority-shared"
        ),
        inputA.authorities[0]
      );
      assert.deepEqual(
        await snapshots.getDefaults({ workspaceId: workspaceA }),
        inputA.defaults
      );
      assert.deepEqual(
        await snapshots.getPolicy(
          { workspaceId: workspaceA },
          "policy-default"
        ),
        inputA.policies[0]
      );
      assert.deepEqual(
        await snapshots.getPricing(
          { workspaceId: workspaceA },
          "pricing-default"
        ),
        inputA.pricing[0]
      );
      assert.equal(
        await snapshots.getWorkflow(
          { workspaceId: workspaceA },
          { ...workflowIdentity, workflowContentHash: hash("z") }
        ),
        undefined
      );
      await assert.rejects(() =>
        snapshots.getDefaults({ workspaceId: workspaceB })
      );
    }
  );

  await runtime.planning.transaction(
    { workspaceId: workspaceB },
    async ({ snapshots }) => {
      assert.deepEqual(
        await snapshots.getPolicy(
          { workspaceId: workspaceB },
          "policy-default"
        ),
        inputB.policies[0]
      );
    }
  );

  const nextPolicy = {
    policy: {
      factsHash: hash("n"),
      maxAttemptsPerStep: 3,
      requiredPermission: "plans:quote",
      version: "2.0.0",
    },
    snapshotId: "policy-next",
    workspaceId: workspaceA,
  } as const;
  const nextPricing = {
    guarantee: "estimated",
    snapshotId: "pricing-next",
    ttlMilliseconds: 15_000,
    unit: "credits",
    upperBound: 4,
    version: "2.0.0",
    workspaceId: workspaceA,
  } as const;
  const switchApply = await runtime.bootstrapPlanning({
    authorities: [],
    defaults: {
      policySnapshotId: nextPolicy.snapshotId,
      pricingSnapshotId: nextPricing.snapshotId,
      workspaceId: workspaceA,
    },
    expectedDefaultsRevision: 1,
    policies: [nextPolicy],
    pricing: [nextPricing],
    workflows: [],
    workspaceId: workspaceA,
  });
  assert.equal(switchApply.status, "applied");
  assert.equal(switchApply.defaults.state, "updated");
  assert.equal(switchApply.defaults.previous?.revision, 1);
  assert.equal(switchApply.defaults.current.revision, 2);
  const switchReplay = await runtime.bootstrapPlanning({
    authorities: [],
    defaults: {
      policySnapshotId: nextPolicy.snapshotId,
      pricingSnapshotId: nextPricing.snapshotId,
      workspaceId: workspaceA,
    },
    expectedDefaultsRevision: 1,
    policies: [nextPolicy],
    pricing: [nextPricing],
    workflows: [],
    workspaceId: workspaceA,
  });
  assert.equal(switchReplay.status, "unchanged");
  assert.equal(switchReplay.defaults.current.revision, 2);
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    async ({ snapshots }) => {
      assert.deepEqual(
        await snapshots.getDefaults({ workspaceId: workspaceA }),
        {
          policySnapshotId: nextPolicy.snapshotId,
          pricingSnapshotId: nextPricing.snapshotId,
          workspaceId: workspaceA,
        }
      );
      assert.deepEqual(
        await snapshots.getPolicy(
          { workspaceId: workspaceA },
          nextPolicy.snapshotId
        ),
        nextPolicy
      );
      assert.deepEqual(
        await snapshots.getPricing(
          { workspaceId: workspaceA },
          nextPricing.snapshotId
        ),
        nextPricing
      );
    }
  );

  const stalePolicy = {
    policy: {
      factsHash: hash("stale-policy"),
      maxAttemptsPerStep: 3,
      requiredPermission: "plans:quote",
      version: "3.0.0",
    },
    snapshotId: "policy-stale",
    workspaceId: workspaceA,
  } as const;
  const stalePricing = {
    guarantee: "estimated",
    snapshotId: "pricing-stale",
    ttlMilliseconds: 10_000,
    unit: "credits",
    upperBound: 3,
    version: "3.0.0",
    workspaceId: workspaceA,
  } as const;
  await assert.rejects(
    () =>
      runtime.bootstrapPlanning({
        authorities: [],
        defaults: {
          policySnapshotId: stalePolicy.snapshotId,
          pricingSnapshotId: stalePricing.snapshotId,
          workspaceId: workspaceA,
        },
        expectedDefaultsRevision: 1,
        policies: [stalePolicy],
        pricing: [stalePricing],
        workflows: [],
        workspaceId: workspaceA,
      }),
    (error: unknown) =>
      error instanceof PostgresAdapterError &&
      error.code === "planning-defaults-conflict"
  );
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    async ({ snapshots }) => {
      assert.equal(
        await snapshots.getPolicy(
          { workspaceId: workspaceA },
          stalePolicy.snapshotId
        ),
        undefined
      );
      assert.equal(
        await snapshots.getPricing(
          { workspaceId: workspaceA },
          stalePricing.snapshotId
        ),
        undefined
      );
    }
  );

  const baseAuthority = inputA.authorities[0];
  if (baseAuthority === undefined) {
    throw new Error("Planning fixture has no authority snapshot.");
  }
  await assert.rejects(
    () =>
      runtime.bootstrapPlanning({
        authorities: [
          {
            ...baseAuthority,
            authorityEnvelopeId: "authority-unsupported",
            version: "2.0.0",
          },
        ],
        defaults: {
          policySnapshotId: nextPolicy.snapshotId,
          pricingSnapshotId: nextPricing.snapshotId,
          workspaceId: workspaceA,
        },
        expectedDefaultsRevision: 2,
        policies: [],
        pricing: [],
        workflows: [],
        workspaceId: workspaceA,
      }),
    (error: unknown) =>
      error instanceof PostgresAdapterError &&
      error.code === "authority-version-unsupported"
  );
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    async ({ snapshots }) => {
      assert.equal(
        await snapshots.getAuthority(
          { workspaceId: workspaceA },
          "authority-unsupported"
        ),
        undefined
      );
    }
  );

  const persisted = planWithInputFrom(inputA, "durable");
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    ({ runPlans }) => runPlans.insert({ workspaceId: workspaceA }, persisted)
  );
  await assert.rejects(
    () =>
      runtime.planning.transaction(
        { workspaceId: workspaceA },
        ({ runPlans }) =>
          runPlans.insert(
            { workspaceId: workspaceA },
            {
              ...persisted,
              plan: { ...persisted.plan, planHash: hash("different") },
            }
          )
      ),
    ImmutableRecordConflictError
  );
  await runtime.planning.transaction(
    { workspaceId: workspaceA },
    ({ runPlans }) => runPlans.insert({ workspaceId: workspaceA }, persisted)
  );

  const mismatchedProvenance = planFrom(inputA, "mismatched-provenance");
  await assert.rejects(
    () =>
      runtime.planning.transaction(
        { workspaceId: workspaceA },
        ({ runPlans }) =>
          runPlans.insert(
            { workspaceId: workspaceA },
            {
              ...mismatchedProvenance,
              sources: {
                ...mismatchedProvenance.sources,
                pricingSnapshotId: nextPricing.snapshotId,
              },
            }
          )
      ),
    PostgresAdapterError
  );

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        policy_snapshot_id: string;
        pricing_snapshot_id: string;
        workflow_content_hash: string;
      }[]
    >`
      SELECT policy_snapshot_id, pricing_snapshot_id, workflow_content_hash
      FROM kurobara_core.run_plan_sources
      WHERE workspace_id = ${workspaceA}
        AND run_plan_id = ${persisted.plan.runPlanId}
    `;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      policy_snapshot_id: "policy-default",
      pricing_snapshot_id: "pricing-default",
      workflow_content_hash: hash("f"),
    });
    const inputRows = await inspection<
      readonly {
        content_hash: string;
        input_id: string;
        normalized_payload: unknown;
        size_bytes: number;
      }[]
    >`
      SELECT
        input_id,
        content_hash,
        normalized_payload,
        size_bytes::integer AS size_bytes
      FROM kurobara_core.run_plan_inputs
      WHERE workspace_id = ${workspaceA}
        AND run_plan_id = ${persisted.plan.runPlanId}
    `;
    assert.deepEqual(
      [...inputRows],
      [
        {
          content_hash: persisted.input.contentHash,
          input_id: "input-durable",
          normalized_payload: { document: "synthetic-durable" },
          size_bytes: persisted.input.sizeBytes,
        },
      ]
    );
    const mismatchRows = await inspection<readonly { count: number }[]>`
      SELECT count(*)::integer AS count
      FROM kurobara_core.run_plans
      WHERE workspace_id = ${workspaceA}
        AND run_plan_id = ${mismatchedProvenance.plan.runPlanId}
    `;
    assert.equal(mismatchRows[0]?.count, 0);

    await assert.rejects(
      () => inspection`
        UPDATE kurobara_core.policy_snapshots
        SET snapshot = '{}'::jsonb
        WHERE workspace_id = ${workspaceA}
          AND snapshot_id = 'policy-default'
      `,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55000"
    );
    await assert.rejects(
      () => inspection`
        UPDATE kurobara_core.run_plans
        SET plan = '{}'::jsonb
        WHERE workspace_id = ${workspaceA}
          AND run_plan_id = ${persisted.plan.runPlanId}
      `,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55000"
    );
  } finally {
    await inspection.end({ timeout: 5 });
  }

  await assert.rejects(
    () =>
      runtime.bootstrapPlanning({
        ...inputA,
        policies: [
          {
            ...policyA,
            policy: {
              ...policyA.policy,
              version: "conflicting-version",
            },
          },
        ],
      }),
    ImmutableRecordConflictError
  );

  const rollback = planWithInputFrom(inputA, "rollback");
  await assert.rejects(() =>
    runtime.planning.transaction({ workspaceId: workspaceA }, ({ runPlans }) =>
      runPlans.insert(
        { workspaceId: workspaceA },
        {
          ...rollback,
          sources: {
            ...rollback.sources,
            policySnapshotId: "policy-missing",
          },
        }
      )
    )
  );
  const verification = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await verification<
      readonly { input_count: number; plan_count: number }[]
    >`
      SELECT
        (
          SELECT count(*)::integer
          FROM kurobara_core.run_plans
          WHERE workspace_id = ${workspaceA}
            AND run_plan_id = ${rollback.plan.runPlanId}
        ) AS plan_count,
        (
          SELECT count(*)::integer
          FROM kurobara_core.run_plan_inputs
          WHERE workspace_id = ${workspaceA}
            AND run_plan_id = ${rollback.plan.runPlanId}
        ) AS input_count
    `;
    assert.deepEqual(rows[0], { input_count: 0, plan_count: 0 });
  } finally {
    await verification.end({ timeout: 5 });
  }
});

test("serializes concurrent bootstrap and defaults switches without partial losers", async () => {
  const workspace = workspaceId("workspace-planning-concurrency");
  const initial = planningInput(workspace, "concurrency");
  const initialResults = await Promise.all([
    runtime.bootstrapPlanning(initial),
    runtime.bootstrapPlanning(initial),
  ]);
  assert.deepEqual(initialResults.map(({ status }) => status).sort(), [
    "applied",
    "unchanged",
  ]);
  assert.ok(
    initialResults.every(({ defaults }) => defaults.current.revision === 1)
  );

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const beforeReplay = await inspection<
      readonly { revision: string; updated_at: string }[]
    >`
      SELECT revision::text AS revision, updated_at::text AS updated_at
      FROM kurobara_core.planning_defaults
      WHERE workspace_id = ${workspace}
    `;
    const replay = await runtime.bootstrapPlanning(initial);
    const afterReplay = await inspection<
      readonly { revision: string; updated_at: string }[]
    >`
      SELECT revision::text AS revision, updated_at::text AS updated_at
      FROM kurobara_core.planning_defaults
      WHERE workspace_id = ${workspace}
    `;
    assert.equal(replay.status, "unchanged");
    assert.deepEqual(afterReplay, beforeReplay);
  } finally {
    await inspection.end({ timeout: 5 });
  }

  const switchInput = (marker: "a" | "b"): BootstrapPlanningInput => ({
    authorities: [],
    defaults: {
      policySnapshotId: `policy-switch-${marker}`,
      pricingSnapshotId: `pricing-switch-${marker}`,
      workspaceId: workspace,
    },
    expectedDefaultsRevision: 1,
    policies: [
      {
        policy: {
          factsHash: hash(`policy-switch-${marker}`),
          maxAttemptsPerStep: 3,
          requiredPermission: "plans:quote",
          version: "2.0.0",
        },
        snapshotId: `policy-switch-${marker}`,
        workspaceId: workspace,
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: `pricing-switch-${marker}`,
        ttlMilliseconds: 30_000,
        unit: "credits",
        upperBound: marker === "a" ? 4 : 6,
        version: "2.0.0",
        workspaceId: workspace,
      },
    ],
    workflows: [],
    workspaceId: workspace,
  });
  const candidates = [switchInput("a"), switchInput("b")] as const;
  const outcomes = await Promise.allSettled(
    candidates.map((candidate) => runtime.bootstrapPlanning(candidate))
  );
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1
  );
  assert.equal(
    outcomes.filter(({ status }) => status === "rejected").length,
    1
  );

  const winningIndex = outcomes.findIndex(
    ({ status }) => status === "fulfilled"
  );
  const losingIndex = outcomes.findIndex(({ status }) => status === "rejected");
  const winner = candidates[winningIndex];
  const loser = candidates[losingIndex];
  const rejected = outcomes[losingIndex];
  if (
    winner === undefined ||
    loser === undefined ||
    rejected === undefined ||
    rejected.status !== "rejected"
  ) {
    throw new Error(
      "The concurrent switch fixture requires one winner and loser."
    );
  }
  assert.ok(
    rejected.reason instanceof PostgresAdapterError &&
      rejected.reason.code === "planning-defaults-conflict"
  );

  const readback = await runtime.readPlanningState(workspace);
  assert.equal(readback?.defaults.revision, 2);
  assert.deepEqual(readback?.defaults, { ...winner.defaults, revision: 2 });
  await runtime.planning.transaction(
    { workspaceId: workspace },
    async ({ snapshots }) => {
      assert.deepEqual(
        await snapshots.getPolicy(
          { workspaceId: workspace },
          winner.policies[0]?.snapshotId ?? ""
        ),
        winner.policies[0]
      );
      assert.deepEqual(
        await snapshots.getPricing(
          { workspaceId: workspace },
          winner.pricing[0]?.snapshotId ?? ""
        ),
        winner.pricing[0]
      );
      assert.equal(
        await snapshots.getPolicy(
          { workspaceId: workspace },
          loser.policies[0]?.snapshotId ?? ""
        ),
        undefined
      );
      assert.equal(
        await snapshots.getPricing(
          { workspaceId: workspace },
          loser.pricing[0]?.snapshotId ?? ""
        ),
        undefined
      );
    }
  );
});

test("keeps state reads and exact verification bounded beyond 256 historical snapshots", async () => {
  const workspace = workspaceId("workspace-planning-history");
  const initial = planningInput(workspace, "history");
  await runtime.bootstrapPlanning(initial);
  const historical: BootstrapPlanningInput = {
    authorities: [],
    defaults: initial.defaults,
    expectedDefaultsRevision: 1,
    policies: Array.from({ length: 256 }, (_, index) => ({
      policy: {
        factsHash: hash(`historical-policy-${index}`),
        maxAttemptsPerStep: 3,
        requiredPermission: "plans:quote",
        version: "1.0.0",
      },
      snapshotId: `policy-historical-${index}`,
      workspaceId: workspace,
    })),
    pricing: [],
    workflows: [],
    workspaceId: workspace,
  };

  const applied = await runtime.bootstrapPlanning(historical);
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.snapshots.policies, {
    inserted: 256,
    unchanged: 0,
  });
  assert.equal(await runtime.verifyPlanningBundle(historical, 1), true);

  const state = await runtime.readPlanningState(workspace);
  assert.equal(state?.defaults.revision, 1);
  assert.deepEqual(state?.policy, initial.policies[0]);
  assert.equal(state?.snapshotCounts.policies, 257);
});
