import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  type DatasetGenerationPlan,
  type DatasetGenerationPlanId,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  fieldId,
  type IdempotencyKey,
  idempotencyKey,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationPersistencePort,
  DatasetGenerationUnitOfWork,
  StoredDatasetGeneration,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  type CreateDatasetGenerationDependencies,
  makeCreateDatasetGeneration,
} from "../src/create-dataset-generation.ts";
import { makeGetDatasetGeneration } from "../src/get-dataset-generation.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-generation");
const now = instant(1_800_000_000_000);
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;

const plan = (
  generationPlanIdentity = "generation-plan-1",
  idempotencyIdentity = "generation-plan-create-1",
  planHashCharacter = "f"
): DatasetGenerationPlan => {
  const targetDataset = {
    datasetId: datasetId("dataset-companies"),
    name: "Synthetic companies",
    workspaceId: workspace,
  };
  const fields = [
    {
      datasetId: targetDataset.datasetId,
      fieldId: fieldId("field-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string" as const,
      workspaceId: workspace,
    },
  ];
  const deadline = instant(now + 60_000);
  const budget = { limit: 10, reserved: 0, spent: 0, unit: "credits" };
  return {
    authority: {
      authorityEnvelopeId: "authority-generation",
      budgetLimit: budget,
      capabilities: [capability],
      deadline,
      permissions: ["datasets:generate", "steps:execute"],
      subjectActorId: actorId("actor-generation"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget,
    deadline,
    generationPlanId: datasetGenerationPlanId(generationPlanIdentity),
    hardExecutionCap: 2,
    idempotencyKey: idempotencyKey(idempotencyIdentity),
    limits: {
      maxCalls: 2,
      maxCompanies: 10,
      maxContactsPerCompany: 0,
      maxContactsTotal: 0,
      maxEnrichments: 0,
      maxPages: 2,
      maxPhones: 0,
      maxResults: 10,
    },
    normalizedQuery: { country: "ES" },
    normalizerVersion: "normalizer-1",
    planHash: hash(planHashCharacter),
    policy: {
      factsHash: hash("c"),
      requiredPermission: "datasets:generate",
      version: "policy-1",
    },
    queryContract: {
      catalogFingerprint: hash("a"),
      catalogVersion: "catalog-1",
      schemaFingerprint: hash("b"),
      schemaId: "organizations.discover.query",
      schemaVersion: "1.0.0",
    },
    queryHash: hash("d"),
    quote: {
      expiresAt: instant(deadline + 60_000),
      guarantee: "hard",
      pricingVersion: "pricing-1",
      quoteId: "quote-1",
      unit: "credits",
      upperBound: 2,
    },
    requestIntent: {
      actorId: actorId("actor-generation"),
      authorityEnvelopeId: "authority-generation",
      capability,
      fields,
      limits: {
        maxCalls: 2,
        maxCompanies: 10,
        maxContactsPerCompany: 0,
        maxContactsTotal: 0,
        maxEnrichments: 0,
        maxPages: 2,
        maxPhones: 0,
        maxResults: 10,
      },
      requestedBudget: { limit: 10, unit: "credits" },
      requestedDeadline: deadline,
      requestedQuery: { country: "es" },
      targetDataset,
      unknownCostPolicy: { mode: "deny" },
      workspaceId: workspace,
    },
    requestIntentHash: hash(planHashCharacter === "f" ? "e" : "7"),
    routeSnapshots: [
      {
        capability,
        effectAdapterKey: "synthetic-organizations",
        factsHash: hash("c"),
        pricingVersion: "pricing-1",
        reservableUpperBound: 2,
        reservationUnit: "credits",
        routeKey: "synthetic-primary",
      },
    ],
    schemaHash: hash("8"),
    workspaceId: workspace,
  };
};

class MemoryGenerationPersistence implements DatasetGenerationPersistencePort {
  readonly plans = new Map<string, StoredDatasetGenerationPlan>();
  readonly records = new Map<string, StoredDatasetGeneration>();
  readonly reservedDatasetIds = new Set<string>();
  readonly operationLog: string[] = [];
  datasetAppearsWhenLocked = false;
  insertCount = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(...plans: readonly DatasetGenerationPlan[]) {
    for (const candidate of plans) {
      this.plans.set(candidate.generationPlanId, {
        idempotencyKey: candidate.idempotencyKey,
        plan: structuredClone(candidate),
        requestIntentHash: candidate.requestIntentHash,
      });
    }
  }

  get(
    scope: WorkspaceScope,
    generationId: ReturnType<typeof datasetGenerationId>
  ): Promise<StoredDatasetGeneration | undefined> {
    const found = this.records.get(`${scope.workspaceId}\0${generationId}`);
    return Promise.resolve(
      found === undefined ? undefined : structuredClone(found)
    );
  }

  async transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    let release = (): void => undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const generationPlans = {
      findByIdempotencyKey: (
        scope: WorkspaceScope,
        key: IdempotencyKey
      ): Promise<StoredDatasetGenerationPlan | undefined> =>
        Promise.resolve(
          [...this.plans.values()].find(
            (stored) =>
              stored.plan.workspaceId === scope.workspaceId &&
              stored.idempotencyKey === key
          )
        ),
      get: (
        scope: WorkspaceScope,
        generationPlanId: DatasetGenerationPlanId
      ): Promise<StoredDatasetGenerationPlan | undefined> => {
        this.operationLog.push("get-plan");
        const stored = this.plans.get(generationPlanId);
        return Promise.resolve(
          stored?.plan.workspaceId === scope.workspaceId ? stored : undefined
        );
      },
      insert: (): never => {
        throw new Error("planning insert is outside this test scope");
      },
      lockIdempotencyKey: (): Promise<void> => Promise.resolve(),
    };
    const generations = {
      findByPlan: (
        scope: WorkspaceScope,
        generationPlanId: DatasetGenerationPlanId
      ): Promise<StoredDatasetGeneration | undefined> => {
        this.operationLog.push("find-by-plan");
        return Promise.resolve(
          [...this.records.values()].find(
            (stored) =>
              stored.generation.workspaceId === scope.workspaceId &&
              stored.generation.generationPlanId === generationPlanId
          )
        );
      },
      get: this.get.bind(this),
      insert: (
        scope: WorkspaceScope,
        record: StoredDatasetGeneration
      ): Promise<void> => {
        this.operationLog.push("insert");
        this.records.set(
          `${scope.workspaceId}\0${record.generation.generationId}`,
          structuredClone(record)
        );
        this.reservedDatasetIds.add(
          `${scope.workspaceId}\0${record.generation.datasetId}`
        );
        this.insertCount += 1;
        return Promise.resolve();
      },
      lockPlan: (): Promise<void> => {
        this.operationLog.push("lock-plan");
        return Promise.resolve();
      },
      lockTargetDataset: (
        scope: WorkspaceScope,
        targetDatasetId: ReturnType<typeof datasetId>
      ): Promise<void> => {
        this.operationLog.push("lock-target-dataset");
        if (this.datasetAppearsWhenLocked) {
          this.reservedDatasetIds.add(
            `${scope.workspaceId}\0${targetDatasetId}`
          );
        }
        return Promise.resolve();
      },
      targetDatasetExists: (
        scope: WorkspaceScope,
        targetDatasetId: ReturnType<typeof datasetId>
      ): Promise<boolean> => {
        this.operationLog.push("target-dataset-exists");
        return Promise.resolve(
          this.reservedDatasetIds.has(
            `${scope.workspaceId}\0${targetDatasetId}`
          )
        );
      },
    };
    try {
      return await work({ generationPlans, generations });
    } finally {
      release();
    }
  }
}

const fixture = (...plans: readonly DatasetGenerationPlan[]) => {
  const persistence = new MemoryGenerationPersistence(...plans);
  const calls = { clock: 0, identifiers: 0 };
  const dependencies: CreateDatasetGenerationDependencies = {
    clock: {
      now: () => {
        calls.clock += 1;
        return Promise.resolve(now);
      },
    },
    identifiers: {
      nextDatasetGenerationId: () => {
        calls.identifiers += 1;
        return Promise.resolve(
          datasetGenerationId(`generation-${calls.identifiers}`)
        );
      },
    },
    persistence,
  };
  return { calls, dependencies, persistence };
};

test("creates atomically and replays before allocating identities or time", async () => {
  const candidate = plan();
  const setup = fixture(candidate);
  const create = makeCreateDatasetGeneration(setup.dependencies);

  const first = await create({
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  });
  const replayed = await create({
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  });

  assert.equal(first.ok, true);
  assert.equal(replayed.ok, true);
  if (!(first.ok && replayed.ok)) {
    return;
  }
  assert.equal(first.value.replayed, false);
  assert.equal(replayed.value.replayed, true);
  assert.deepEqual(replayed.value.creation, first.value.creation);
  assert.deepEqual(setup.calls, { clock: 1, identifiers: 1 });
  assert.equal(setup.persistence.insertCount, 1);
});

test("serializes concurrent creation into one exact generation", async () => {
  const candidate = plan();
  const setup = fixture(candidate);
  const create = makeCreateDatasetGeneration(setup.dependencies);
  const request = {
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  } as const;

  const [left, right] = await Promise.all([create(request), create(request)]);

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (!(left.ok && right.ok)) {
    return;
  }
  assert.deepEqual(left.value.creation, right.value.creation);
  assert.deepEqual([left.value.replayed, right.value.replayed].sort(), [
    false,
    true,
  ]);
  assert.deepEqual(setup.calls, { clock: 1, identifiers: 1 });
  assert.equal(setup.persistence.insertCount, 1);
});

test("rejects another plan targeting the same dataset without allocating", async () => {
  const firstPlan = plan();
  const secondPlan = plan("generation-plan-2", "generation-plan-create-2", "6");
  const setup = fixture(firstPlan, secondPlan);
  const create = makeCreateDatasetGeneration(setup.dependencies);
  assert.equal(
    (
      await create({
        generationPlanId: firstPlan.generationPlanId,
        workspaceId: workspace,
      })
    ).ok,
    true
  );

  const conflict = await create({
    generationPlanId: secondPlan.generationPlanId,
    workspaceId: workspace,
  });

  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "target-dataset-conflict");
  }
  assert.deepEqual(setup.calls, { clock: 1, identifiers: 1 });
  assert.equal(setup.persistence.insertCount, 1);
});

test("rejects an imported target dataset without allocating", async () => {
  const candidate = plan();
  const setup = fixture(candidate);
  setup.persistence.reservedDatasetIds.add(
    `${workspace}\0${candidate.requestIntent.targetDataset.datasetId}`
  );

  const conflict = await makeCreateDatasetGeneration(setup.dependencies)({
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  });

  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "target-dataset-conflict");
  }
  assert.deepEqual(setup.calls, { clock: 0, identifiers: 0 });
  assert.equal(setup.persistence.insertCount, 0);
});

test("locks the target dataset before observing an import race and allocating", async () => {
  const candidate = plan();
  const setup = fixture(candidate);
  setup.persistence.datasetAppearsWhenLocked = true;

  const conflict = await makeCreateDatasetGeneration(setup.dependencies)({
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  });

  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "target-dataset-conflict");
  }
  assert.deepEqual(setup.persistence.operationLog, [
    "lock-plan",
    "get-plan",
    "lock-target-dataset",
    "find-by-plan",
    "target-dataset-exists",
  ]);
  assert.deepEqual(setup.calls, { clock: 0, identifiers: 0 });
  assert.equal(setup.persistence.insertCount, 0);
});

test("get is workspace-scoped and performs no mutation", async () => {
  const candidate = plan();
  const setup = fixture(candidate);
  const created = await makeCreateDatasetGeneration(setup.dependencies)({
    generationPlanId: candidate.generationPlanId,
    workspaceId: workspace,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const get = makeGetDatasetGeneration(setup.persistence);
  const found = await get({
    generationId: created.value.creation.generation.generationId,
    workspaceId: workspace,
  });
  const hidden = await get({
    generationId: created.value.creation.generation.generationId,
    workspaceId: workspaceId("workspace-other"),
  });

  assert.equal(found.ok, true);
  assert.equal(hidden.ok, false);
  assert.equal(setup.persistence.insertCount, 1);
  assert.deepEqual(setup.calls, { clock: 1, identifiers: 1 });
});
