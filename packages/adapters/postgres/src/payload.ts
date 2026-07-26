import {
  type AuthorityEnvelope,
  actorId,
  type BudgetLimit,
  type CapabilityRef,
  type CompiledWorkflow,
  type ContractRef,
  type CostQuote,
  capabilityId,
  contentHash,
  correlationId,
  eventId,
  idempotencyKey,
  instant,
  type Run,
  type RunCommandReplayProof,
  type RunPlan,
  type RunPlanRouteSnapshot,
  type RunQueued,
  resultManifestId,
  runId,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { RunCreationRecord } from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const number = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DatabasePayloadError(`${path} must be a finite number.`);
  }
  return value;
};

const integer = (value: unknown, path: string): number => {
  const parsed = number(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw new DatabasePayloadError(`${path} must be a safe integer.`);
  }
  return parsed;
};

const strings = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an array.`);
  }
  return value.map((item, index) => string(item, `${path}[${index}]`));
};

const budget = (value: unknown, path: string): BudgetLimit => {
  const item = record(value, path);
  return {
    limit: number(item.limit, `${path}.limit`),
    reserved: number(item.reserved, `${path}.reserved`),
    spent: number(item.spent, `${path}.spent`),
    unit: string(item.unit, `${path}.unit`),
  };
};

const capability = (value: unknown, path: string): CapabilityRef => {
  const item = record(value, path);
  return {
    capabilityId: capabilityId(
      string(item.capabilityId, `${path}.capabilityId`)
    ),
    capabilityVersion: string(
      item.capabilityVersion,
      `${path}.capabilityVersion`
    ),
  };
};

const contract = (value: unknown, path: string): ContractRef => {
  const item = record(value, path);
  return {
    catalogFingerprint: contentHash(
      string(item.catalogFingerprint, `${path}.catalogFingerprint`)
    ),
    catalogVersion: string(item.catalogVersion, `${path}.catalogVersion`),
    schemaFingerprint: contentHash(
      string(item.schemaFingerprint, `${path}.schemaFingerprint`)
    ),
    schemaId: string(item.schemaId, `${path}.schemaId`),
    schemaVersion: string(item.schemaVersion, `${path}.schemaVersion`),
  };
};

const compiledWorkflow = (value: unknown): CompiledWorkflow => {
  const item = record(value, "runPlan.compiledWorkflow");
  if (!Array.isArray(item.nodes)) {
    throw new DatabasePayloadError(
      "runPlan.compiledWorkflow.nodes must be an array."
    );
  }
  return {
    compilerVersion: string(
      item.compilerVersion,
      "runPlan.compiledWorkflow.compilerVersion"
    ),
    fingerprint: string(
      item.fingerprint,
      "runPlan.compiledWorkflow.fingerprint"
    ),
    nodes: item.nodes.map((value, index) => {
      const path = `runPlan.compiledWorkflow.nodes[${index}]`;
      const node = record(value, path);
      const humanGate = node.humanGate;
      return {
        capability: capability(node.capability, `${path}.capability`),
        dependsOn: strings(node.dependsOn, `${path}.dependsOn`),
        depth: integer(node.depth, `${path}.depth`),
        ...(humanGate === undefined
          ? {}
          : { humanGate: string(humanGate, `${path}.humanGate`) }),
        key: string(node.key, `${path}.key`),
      };
    }),
    workflowContentHash: contentHash(
      string(
        item.workflowContentHash,
        "runPlan.compiledWorkflow.workflowContentHash"
      )
    ),
    workflowRevision: string(
      item.workflowRevision,
      "runPlan.compiledWorkflow.workflowRevision"
    ),
    workflowSpecId: workflowSpecId(
      string(item.workflowSpecId, "runPlan.compiledWorkflow.workflowSpecId")
    ),
  };
};

const authority = (value: unknown): AuthorityEnvelope => {
  const item = record(value, "runPlan.authority");
  if (!Array.isArray(item.capabilities)) {
    throw new DatabasePayloadError(
      "runPlan.authority.capabilities must be an array."
    );
  }
  return {
    authorityEnvelopeId: string(
      item.authorityEnvelopeId,
      "runPlan.authority.authorityEnvelopeId"
    ),
    budgetLimit: budget(item.budgetLimit, "runPlan.authority.budgetLimit"),
    capabilities: item.capabilities.map((value, index) =>
      capability(value, `runPlan.authority.capabilities[${index}]`)
    ),
    deadline: instant(integer(item.deadline, "runPlan.authority.deadline")),
    permissions: strings(item.permissions, "runPlan.authority.permissions"),
    subjectActorId: actorId(
      string(item.subjectActorId, "runPlan.authority.subjectActorId")
    ),
    version: string(item.version, "runPlan.authority.version"),
    workspaceId: workspaceId(
      string(item.workspaceId, "runPlan.authority.workspaceId")
    ),
  };
};

const quote = (value: unknown): CostQuote => {
  const item = record(value, "runPlan.quote");
  const guarantee = string(item.guarantee, "runPlan.quote.guarantee");
  if (
    guarantee !== "hard" &&
    guarantee !== "estimated" &&
    guarantee !== "unknown"
  ) {
    throw new DatabasePayloadError("runPlan.quote.guarantee is invalid.");
  }
  const upperBound = item.upperBound;
  return {
    expiresAt: instant(integer(item.expiresAt, "runPlan.quote.expiresAt")),
    guarantee: guarantee as CostQuote["guarantee"],
    pricingVersion: string(item.pricingVersion, "runPlan.quote.pricingVersion"),
    quoteId: string(item.quoteId, "runPlan.quote.quoteId"),
    unit: string(item.unit, "runPlan.quote.unit"),
    ...(upperBound === undefined
      ? {}
      : { upperBound: number(upperBound, "runPlan.quote.upperBound") }),
  };
};

const retryPolicy = (value: unknown): RunPlan["retryPolicy"] => {
  if (value === undefined) {
    return { maxAttemptsPerStep: 1 };
  }
  const item = record(value, "runPlan.retryPolicy");
  const maxAttemptsPerStep = integer(
    item.maxAttemptsPerStep,
    "runPlan.retryPolicy.maxAttemptsPerStep"
  );
  if (maxAttemptsPerStep < 1 || maxAttemptsPerStep > 100) {
    throw new DatabasePayloadError(
      "runPlan.retryPolicy.maxAttemptsPerStep must be between 1 and 100."
    );
  }
  return { maxAttemptsPerStep };
};

const routeSnapshots = (value: unknown): readonly RunPlanRouteSnapshot[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DatabasePayloadError("runPlan.routeSnapshots must be an array.");
  }
  return value.map((entry, index) => {
    const path = `runPlan.routeSnapshots[${index}]`;
    const item = record(entry, path);
    const reservableUpperBound = number(
      item.reservableUpperBound,
      `${path}.reservableUpperBound`
    );
    if (reservableUpperBound < 0) {
      throw new DatabasePayloadError(
        `${path}.reservableUpperBound must be non-negative.`
      );
    }
    return {
      capability: capability(item.capability, `${path}.capability`),
      effectAdapterKey: string(
        item.effectAdapterKey,
        `${path}.effectAdapterKey`
      ),
      factsHash: contentHash(string(item.factsHash, `${path}.factsHash`)),
      nodeKey: string(item.nodeKey, `${path}.nodeKey`),
      pricingVersion: string(item.pricingVersion, `${path}.pricingVersion`),
      reservableUpperBound,
      reservationUnit: string(item.reservationUnit, `${path}.reservationUnit`),
      routeKey: string(item.routeKey, `${path}.routeKey`),
    };
  });
};

export const parseRunPlan = (value: unknown): RunPlan => {
  const item = record(value, "runPlan");
  return {
    authority: authority(item.authority),
    budget: budget(item.budget, "runPlan.budget"),
    catalogFingerprint: contentHash(
      string(item.catalogFingerprint, "runPlan.catalogFingerprint")
    ),
    catalogVersion: string(item.catalogVersion, "runPlan.catalogVersion"),
    compiledWorkflow: compiledWorkflow(item.compiledWorkflow),
    deadline: instant(integer(item.deadline, "runPlan.deadline")),
    inputContract: contract(item.inputContract, "runPlan.inputContract"),
    normalizedInputHash: contentHash(
      string(item.normalizedInputHash, "runPlan.normalizedInputHash")
    ),
    outputContract: contract(item.outputContract, "runPlan.outputContract"),
    planHash: contentHash(string(item.planHash, "runPlan.planHash")),
    policyFactsHash: contentHash(
      string(item.policyFactsHash, "runPlan.policyFactsHash")
    ),
    policyVersion: string(item.policyVersion, "runPlan.policyVersion"),
    quote: quote(item.quote),
    retryPolicy: retryPolicy(item.retryPolicy),
    routeSnapshots: routeSnapshots(item.routeSnapshots),
    runPlanId: runPlanId(string(item.runPlanId, "runPlan.runPlanId")),
    workspaceId: workspaceId(string(item.workspaceId, "runPlan.workspaceId")),
  };
};

const RUN_STATES: readonly Run["state"][] = [
  "queued",
  "running",
  "waiting",
  "cancelling",
  "ambiguous",
  "completed",
  "failed",
  "cancelled",
];
const RESULT_COMPLETENESS: readonly Run["resultCompleteness"][] = [
  "none",
  "partial",
  "complete",
];

export const parseRun = (value: unknown): Run => {
  const item = record(value, "run");
  const state = string(item.state, "run.state") as Run["state"];
  const resultCompleteness = string(
    item.resultCompleteness,
    "run.resultCompleteness"
  ) as Run["resultCompleteness"];
  if (!RUN_STATES.includes(state)) {
    throw new DatabasePayloadError("run.state is invalid.");
  }
  if (!RESULT_COMPLETENESS.includes(resultCompleteness)) {
    throw new DatabasePayloadError("run.resultCompleteness is invalid.");
  }
  const pendingStopReason = item.pendingStopReason;
  const storedResultManifest = item.resultManifest;
  if (
    pendingStopReason !== undefined &&
    pendingStopReason !== "requested" &&
    pendingStopReason !== "deadline" &&
    pendingStopReason !== "budget" &&
    pendingStopReason !== "authority-revoked" &&
    pendingStopReason !== "ancestor-stopped"
  ) {
    throw new DatabasePayloadError("run.pendingStopReason is invalid.");
  }
  return {
    aggregateVersion: integer(item.aggregateVersion, "run.aggregateVersion"),
    createdAt: instant(integer(item.createdAt, "run.createdAt")),
    eventSequence: integer(item.eventSequence, "run.eventSequence"),
    idempotencyKey: idempotencyKey(
      string(item.idempotencyKey, "run.idempotencyKey")
    ),
    intentionHash: contentHash(string(item.intentionHash, "run.intentionHash")),
    ...(pendingStopReason === undefined
      ? {}
      : {
          pendingStopReason,
        }),
    ...(storedResultManifest === undefined
      ? {}
      : {
          resultManifest: (() => {
            const reference = record(
              storedResultManifest,
              "run.resultManifest"
            );
            return {
              manifestHash: contentHash(
                string(
                  reference.manifestHash,
                  "run.resultManifest.manifestHash"
                )
              ),
              resultManifestId: resultManifestId(
                string(
                  reference.resultManifestId,
                  "run.resultManifest.resultManifestId"
                )
              ),
            };
          })(),
        }),
    resultCompleteness,
    runId: runId(string(item.runId, "run.runId")),
    runPlanId: runPlanId(string(item.runPlanId, "run.runPlanId")),
    state,
    workspaceId: workspaceId(string(item.workspaceId, "run.workspaceId")),
  };
};

export const parseRunQueued = (value: unknown): RunQueued => {
  const item = record(value, "event");
  if (
    item.eventType !== "RunQueued" ||
    item.eventVersion !== 1 ||
    item.sequence !== 1
  ) {
    throw new DatabasePayloadError("event is not a supported RunQueued event.");
  }
  return {
    actorId: actorId(string(item.actorId, "event.actorId")),
    correlationId: correlationId(
      string(item.correlationId, "event.correlationId")
    ),
    eventId: eventId(string(item.eventId, "event.eventId")),
    eventType: "RunQueued",
    eventVersion: 1,
    occurredAt: instant(integer(item.occurredAt, "event.occurredAt")),
    runId: runId(string(item.runId, "event.runId")),
    runPlanId: runPlanId(string(item.runPlanId, "event.runPlanId")),
    sequence: 1,
    workspaceId: workspaceId(string(item.workspaceId, "event.workspaceId")),
  };
};

export const parseRunCreationRecord = (value: unknown): RunCreationRecord => {
  const item = record(value, "runCreationRecord");
  return {
    idempotencyKey: idempotencyKey(
      string(item.idempotencyKey, "runCreationRecord.idempotencyKey")
    ),
    intentionHash: contentHash(
      string(item.intentionHash, "runCreationRecord.intentionHash")
    ),
    run: parseRun(item.run),
  };
};

export const parseRunCommandReplayProof = (
  value: unknown
): RunCommandReplayProof => {
  const item = record(value, "runCommandReplayProof");
  if (
    item.commandType !== "ClaimRun" &&
    item.commandType !== "CompleteRun" &&
    item.commandType !== "FailRun" &&
    item.commandType !== "RequestStop" &&
    item.commandType !== "SettleCancellation"
  ) {
    throw new DatabasePayloadError(
      "runCommandReplayProof.commandType is unsupported."
    );
  }
  const identity = record(item.identity, "runCommandReplayProof.identity");
  return {
    commandType: item.commandType,
    identity: {
      commandHash: contentHash(
        string(
          identity.commandHash,
          "runCommandReplayProof.identity.commandHash"
        )
      ),
      idempotencyKey: idempotencyKey(
        string(
          identity.idempotencyKey,
          "runCommandReplayProof.identity.idempotencyKey"
        )
      ),
    },
    runId: runId(string(item.runId, "runCommandReplayProof.runId")),
    workspaceId: workspaceId(
      string(item.workspaceId, "runCommandReplayProof.workspaceId")
    ),
  };
};
