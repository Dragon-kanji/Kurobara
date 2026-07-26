import assert from "node:assert/strict";
import test from "node:test";

import { eventId, outboxMessageId, runId, workspaceId } from "@kurobara/kernel";
import type {
  ClaimNextOrchestrationReconciliationInput,
  ConfirmOrchestrationReconciliationInput,
  OrchestrationPort,
  OrchestrationReconciliationClaim,
  OrchestrationReconciliationPort,
  ReapExhaustedOrchestrationReconciliationsInput,
  ReleaseOrchestrationReconciliationInput,
} from "@kurobara/ports";

import { makeReconcileRunOrchestrations } from "../src/index.ts";

const INVALID_BATCH_SIZE =
  /batchSize must be a positive safe integer no greater than 100/u;
const INVALID_LOOKUP_MARGIN =
  /lookupTimeoutMilliseconds must be no greater than half/u;
const WRONG_SYSTEM_OPERATOR =
  /claim does not match the requested system operator/u;
const scope = { workspaceId: workspaceId("workspace-reconciliation") };
const claim: OrchestrationReconciliationClaim = {
  adapterKey: "fake-v1",
  claimedBy: "operator-test",
  claimToken: "claim-test",
  eventId: eventId("event-test"),
  messageId: outboxMessageId("outbox-test"),
  runId: runId("run-test"),
  startKey: "start-test",
  workspaceId: scope.workspaceId,
};

class FakeReconciliation implements OrchestrationReconciliationPort {
  claimInputs: ClaimNextOrchestrationReconciliationInput[] = [];
  confirmed: ConfirmOrchestrationReconciliationInput | undefined;
  confirmStatus: "claim-lost" | "settled" = "settled";
  pendingClaims: OrchestrationReconciliationClaim[] = [claim];
  reapInputs: ReapExhaustedOrchestrationReconciliationsInput[] = [];
  released: ReleaseOrchestrationReconciliationInput | undefined;
  releaseStatus: "claim-lost" | "settled" = "settled";

  claimNextForSystem(
    input: ClaimNextOrchestrationReconciliationInput
  ): Promise<OrchestrationReconciliationClaim | undefined> {
    this.claimInputs.push(input);
    return Promise.resolve(this.pendingClaims.shift());
  }

  confirm(input: ConfirmOrchestrationReconciliationInput) {
    this.confirmed = input;
    return Promise.resolve({ status: this.confirmStatus });
  }

  reapExhaustedForSystem(
    input: ReapExhaustedOrchestrationReconciliationsInput
  ) {
    this.reapInputs.push(input);
    return Promise.resolve(0);
  }

  release(input: ReleaseOrchestrationReconciliationInput) {
    this.released = input;
    return Promise.resolve({ status: this.releaseStatus });
  }
}

const makeSubject = (
  reconciliation: FakeReconciliation,
  findRunByStartKey: OrchestrationPort["findRunByStartKey"],
  timing: Readonly<{
    claimLeaseMilliseconds: number;
    lookupTimeoutMilliseconds: number;
  }> = { claimLeaseMilliseconds: 1000, lookupTimeoutMilliseconds: 250 }
) => {
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey,
    startRun: () => {
      throw new Error("The reconciler must never start a workflow.");
    },
  };
  return makeReconcileRunOrchestrations({
    batchSize: 10,
    claimLeaseMilliseconds: timing.claimLeaseMilliseconds,
    lookupTimeoutMilliseconds: timing.lookupTimeoutMilliseconds,
    maxAttempts: 5,
    operatorId: "operator-test",
    orchestration,
    reconciliation,
    retryDelayMilliseconds: 2000,
  });
};

test("confirms the exact external run found by stable start identity", async () => {
  const reconciliation = new FakeReconciliation();
  let request:
    | Parameters<OrchestrationPort["findRunByStartKey"]>[0]
    | undefined;
  const reconcile = makeSubject(reconciliation, (input) => {
    request = input;
    return Promise.resolve({
      orchestrationRunId: "external-test",
      status: "found",
    });
  });

  const result = await reconcile();

  assert.deepEqual(request, {
    eventId: claim.eventId,
    runId: claim.runId,
    startKey: claim.startKey,
    workspaceId: claim.workspaceId,
  });
  assert.equal(reconciliation.confirmed?.orchestrationRunId, "external-test");
  assert.deepEqual(reconciliation.confirmed?.scope, scope);
  assert.equal(reconciliation.claimInputs[0]?.maxAttempts, 5);
  assert.deepEqual(reconciliation.reapInputs, [
    { adapterKey: "fake-v1", maxAttempts: 5 },
  ]);
  assert.deepEqual(result, {
    claimed: 1,
    items: [
      {
        orchestrationRunId: "external-test",
        runId: claim.runId,
        status: "confirmed",
      },
    ],
  });
});

test("claims each batch item with a fresh lease", async () => {
  const reconciliation = new FakeReconciliation();
  const secondClaim: OrchestrationReconciliationClaim = {
    ...claim,
    claimToken: "claim-second",
    eventId: eventId("event-second"),
    messageId: outboxMessageId("outbox-second"),
    runId: runId("run-second"),
    startKey: "start-second",
  };
  reconciliation.pendingClaims = [claim, secondClaim];
  const reconcile = makeSubject(reconciliation, async (input) => ({
    orchestrationRunId: `external-${input.runId}`,
    status: "found",
  }));

  const result = await reconcile();

  assert.equal(result.claimed, 2);
  assert.equal(reconciliation.claimInputs.length, 3);
  assert.equal(reconciliation.reapInputs.length, 1);
});

test("keeps authoritative absence unresolved without starting", async () => {
  const reconciliation = new FakeReconciliation();
  const result = await makeSubject(reconciliation, async () => ({
    status: "not-found",
  }))();

  assert.equal(reconciliation.confirmed, undefined);
  assert.equal(
    reconciliation.released?.reason,
    "orchestration-reconciliation-not-found"
  );
  assert.equal(reconciliation.released?.retryDelayMilliseconds, 2000);
  assert.equal(reconciliation.released?.maxAttempts, 5);
  assert.equal(result.items[0]?.status, "unresolved");
});

test("redacts a thrown lookup error before releasing the lease", async () => {
  const reconciliation = new FakeReconciliation();
  const result = await makeSubject(reconciliation, () =>
    Promise.reject(new Error("token=private host=secret.example"))
  )();

  assert.equal(
    reconciliation.released?.reason,
    "orchestration-reconciliation-lookup-failed"
  );
  assert.equal(JSON.stringify(result).includes("secret.example"), false);
});

test("settles system claims inside the workspace carried by each claim", async () => {
  const reconciliation = new FakeReconciliation();
  const foreignClaim: OrchestrationReconciliationClaim = {
    ...claim,
    claimToken: "claim-foreign",
    eventId: eventId("event-foreign"),
    messageId: outboxMessageId("outbox-foreign"),
    runId: runId("run-foreign"),
    startKey: "start-foreign",
    workspaceId: workspaceId("workspace-foreign"),
  };
  reconciliation.pendingClaims = [foreignClaim];
  const reconcile = makeSubject(reconciliation, async () => ({
    orchestrationRunId: "external-foreign",
    status: "found",
  }));

  await reconcile();

  assert.deepEqual(reconciliation.confirmed?.scope, {
    workspaceId: foreignClaim.workspaceId,
  });
});

test("rejects a claim for another system operator before lookup", async () => {
  const reconciliation = new FakeReconciliation();
  reconciliation.pendingClaims = [{ ...claim, claimedBy: "operator-foreign" }];
  let lookups = 0;
  const reconcile = makeSubject(reconciliation, () => {
    lookups += 1;
    return Promise.resolve({ status: "not-found" });
  });

  await assert.rejects(() => reconcile(), WRONG_SYSTEM_OPERATOR);
  assert.equal(lookups, 0);
});

test("times out a lookup before its claim lease expires", async () => {
  const reconciliation = new FakeReconciliation();
  const reconcile = makeSubject(
    reconciliation,
    () => new Promise<never>(() => undefined),
    { claimLeaseMilliseconds: 20, lookupTimeoutMilliseconds: 5 }
  );

  const result = await reconcile();

  assert.equal(result.items[0]?.status, "unresolved");
  assert.equal(
    reconciliation.released?.reason,
    "orchestration-reconciliation-lookup-failed"
  );
});

test("treats a lost claim as non-fatal and stops the current batch", async () => {
  const reconciliation = new FakeReconciliation();
  reconciliation.releaseStatus = "claim-lost";
  reconciliation.pendingClaims = [
    claim,
    {
      ...claim,
      claimToken: "claim-second",
      messageId: outboxMessageId("outbox-second"),
      runId: runId("run-second"),
    },
  ];
  const reconcile = makeSubject(reconciliation, () =>
    Promise.resolve({ status: "not-found" })
  );

  const result = await reconcile();

  assert.equal(result.claimed, 1);
  assert.equal(result.items[0]?.status, "unresolved");
  assert.deepEqual(result.items[0], {
    reason: "orchestration-reconciliation-claim-lost",
    runId: claim.runId,
    status: "unresolved",
  });
  assert.equal(reconciliation.claimInputs.length, 1);
});

test("rejects unbounded operator configuration", () => {
  const reconciliation = new FakeReconciliation();
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: async () => ({ status: "not-found" }),
    startRun: async () => ({
      orchestrationRunId: "unused",
      status: "accepted",
    }),
  };

  assert.throws(
    () =>
      makeReconcileRunOrchestrations({
        batchSize: 101,
        claimLeaseMilliseconds: 1000,
        lookupTimeoutMilliseconds: 250,
        maxAttempts: 5,
        operatorId: "operator-test",
        orchestration,
        reconciliation,
        retryDelayMilliseconds: 2000,
      }),
    INVALID_BATCH_SIZE
  );

  assert.throws(
    () =>
      makeReconcileRunOrchestrations({
        batchSize: 1,
        claimLeaseMilliseconds: 1000,
        lookupTimeoutMilliseconds: 501,
        maxAttempts: 5,
        operatorId: "operator-test",
        orchestration,
        reconciliation,
        retryDelayMilliseconds: 2000,
      }),
    INVALID_LOOKUP_MARGIN
  );
});
