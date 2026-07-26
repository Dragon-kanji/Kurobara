import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { runPlanningOperator } from "../../apps/api/src/bootstrap-planning.ts";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_operator_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let directory: string;

const hash = (marker: string): string =>
  `sha256:${marker.repeat(64).slice(0, 64)}`;

const manifest = {
  formatVersion: "1.0.0",
  planning: {
    authorities: [
      {
        authorityEnvelopeId: "authority-operator",
        budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
        capabilities: [
          {
            capabilityId: "documents.summarize",
            capabilityVersion: "1.0.0",
          },
        ],
        deadline: 4_102_444_800_000,
        permissions: ["capabilities:list", "plans:quote", "runs:create"],
        subjectActorId: "actor-operator",
        version: "1.0.0",
        workspaceId: "workspace-operator",
      },
    ],
    defaults: {
      policySnapshotId: "policy-operator",
      pricingSnapshotId: "pricing-operator",
      workspaceId: "workspace-operator",
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash("c"),
          maxAttemptsPerStep: 3,
          requiredPermission: "plans:quote",
          version: "1.0.0",
        },
        snapshotId: "policy-operator",
        workspaceId: "workspace-operator",
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-operator",
        ttlMilliseconds: 60_000,
        unit: "credits",
        upperBound: 5,
        version: "1.0.0",
        workspaceId: "workspace-operator",
      },
    ],
    workflows: [],
    workspaceId: "workspace-operator",
  },
} as const;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  directory = await mkdtemp(join(tmpdir(), "kurobara-operator-integration-"));
});

after(async () => {
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
  if (directory !== undefined) {
    await rm(directory, { force: true, recursive: true });
  }
});

test("applies and verifies an offline planning bundle, then reports an exact replay", async () => {
  const file = join(directory, "planning.json");
  await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
  const environment = { KUROBARA_DATABASE_URL: databaseUrl.toString() };

  const first = await runPlanningOperator(
    ["--apply", "--file", file],
    environment
  );
  const replay = await runPlanningOperator(
    ["--apply", "--file", file],
    environment
  );
  const readback = await runPlanningOperator(
    ["--read", "--workspace", "workspace-operator"],
    environment
  );
  const missingReadback = await runPlanningOperator(
    ["--read", "--workspace", "workspace-not-configured"],
    environment
  );

  assert.equal(first.status, "applied");
  assert.equal(first.mutation_state, "applied-verified");
  assert.equal(replay.status, "unchanged");
  assert.equal(replay.mutation_state, "applied-verified");
  assert.equal(readback.status, "available");
  assert.equal(readback.database_verified, true);
  assert.equal(readback.mutation_state, "not-started");
  assert.deepEqual(readback.state, {
    defaults: { ...manifest.planning.defaults, revision: 1 },
    policy: manifest.planning.policies[0],
    pricing: manifest.planning.pricing[0],
    snapshotCounts: {
      authorities: 1,
      policies: 1,
      pricing: 1,
      workflows: 0,
    },
    workspaceId: "workspace-operator",
  });
  assert.equal(missingReadback.status, "not-configured");
  assert.equal(missingReadback.state, null);

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        authority_count: number;
        event_count: number;
        outbox_count: number;
        revision: number;
        run_count: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM kurobara_core.authority_snapshots)
          AS authority_count,
        (SELECT count(*)::integer FROM kurobara_core.run_events) AS event_count,
        (SELECT count(*)::integer FROM kurobara_core.outbox_messages)
          AS outbox_count,
        (SELECT revision::integer FROM kurobara_core.planning_defaults
          WHERE workspace_id = 'workspace-operator') AS revision,
        (SELECT count(*)::integer FROM kurobara_core.runs) AS run_count
    `;
    assert.deepEqual(rows[0], {
      authority_count: 1,
      event_count: 0,
      outbox_count: 0,
      revision: 1,
      run_count: 0,
    });
  } finally {
    await inspection.end({ timeout: 5 });
  }
});
