import {
  actorId,
  attemptId,
  correlationId,
  eventId,
  instant,
  operationKey,
  outboxMessageId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import type { LeafOutboxMessage } from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown, path: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const nonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const positiveSafeInteger = (value: unknown, path: string): number => {
  if (!(Number.isSafeInteger(value) && Number(value) > 0)) {
    throw new DatabasePayloadError(`${path} must be a positive safe integer.`);
  }
  return Number(value);
};

const safeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new DatabasePayloadError(`${path} must be a safe integer.`);
  }
  return Number(value);
};

const ATTEMPT_CLAIMED_EVENT_KEYS = [
  "actorId",
  "attemptId",
  "attemptNumber",
  "correlationId",
  "eventId",
  "eventType",
  "eventVersion",
  "occurredAt",
  "runId",
  "sequence",
  "stepRunId",
  "workspaceId",
] as const;

const assertExactKeys = (item: JsonRecord, path: string): void => {
  const actual = Object.keys(item).sort();
  const expected = [...ATTEMPT_CLAIMED_EVENT_KEYS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new DatabasePayloadError(`${path} has an unsupported shape.`);
  }
};

export const parseLeafOutboxEvent = (
  value: unknown
): LeafOutboxMessage["event"] => {
  const item = record(value, "leafOutbox.event");
  assertExactKeys(item, "leafOutbox.event");
  if (item.eventType !== "AttemptClaimed" || item.eventVersion !== 1) {
    throw new DatabasePayloadError(
      "leafOutbox.event must be an AttemptClaimed version 1 event."
    );
  }
  return {
    actorId: actorId(nonEmptyString(item.actorId, "leafOutbox.event.actorId")),
    attemptId: attemptId(
      nonEmptyString(item.attemptId, "leafOutbox.event.attemptId")
    ),
    attemptNumber: positiveSafeInteger(
      item.attemptNumber,
      "leafOutbox.event.attemptNumber"
    ),
    correlationId: correlationId(
      nonEmptyString(item.correlationId, "leafOutbox.event.correlationId")
    ),
    eventId: eventId(nonEmptyString(item.eventId, "leafOutbox.event.eventId")),
    eventType: "AttemptClaimed",
    eventVersion: 1,
    occurredAt: instant(
      safeInteger(item.occurredAt, "leafOutbox.event.occurredAt")
    ),
    runId: runId(nonEmptyString(item.runId, "leafOutbox.event.runId")),
    sequence: positiveSafeInteger(item.sequence, "leafOutbox.event.sequence"),
    stepRunId: stepRunId(
      nonEmptyString(item.stepRunId, "leafOutbox.event.stepRunId")
    ),
    workspaceId: workspaceId(
      nonEmptyString(item.workspaceId, "leafOutbox.event.workspaceId")
    ),
  };
};

export const parseLeafOutboxMessageIdentity = (input: {
  aggregateVersion: number;
  attemptId: string;
  availableAtMilliseconds: number;
  destination: string;
  effectAdapterKey: string;
  event: unknown;
  eventId: string;
  messageId: string;
  operationKey: string;
  runId: string;
  stepRunId: string;
  workspaceId: string;
}): LeafOutboxMessage => {
  if (input.destination !== "orchestration.step.attempt.claimed") {
    throw new DatabasePayloadError(
      `Unsupported leaf outbox destination ${input.destination}.`
    );
  }
  if (
    !Number.isSafeInteger(input.aggregateVersion) ||
    input.aggregateVersion < 1 ||
    !Number.isSafeInteger(input.availableAtMilliseconds)
  ) {
    throw new DatabasePayloadError(
      "The leaf outbox aggregate version or availability timestamp is invalid."
    );
  }
  const event = parseLeafOutboxEvent(input.event);
  const message: LeafOutboxMessage = {
    aggregateVersion: input.aggregateVersion,
    attemptId: attemptId(input.attemptId),
    availableAt: instant(input.availableAtMilliseconds),
    destination: "orchestration.step.attempt.claimed",
    effectAdapterKey: nonEmptyString(
      input.effectAdapterKey,
      "leafOutbox.effectAdapterKey"
    ),
    event,
    eventId: eventId(input.eventId),
    messageId: outboxMessageId(input.messageId),
    operationKey: operationKey(input.operationKey),
    runId: runId(input.runId),
    stepRunId: stepRunId(input.stepRunId),
    workspaceId: workspaceId(input.workspaceId),
  };
  if (
    message.eventId !== event.eventId ||
    message.attemptId !== event.attemptId ||
    message.runId !== event.runId ||
    message.stepRunId !== event.stepRunId ||
    message.workspaceId !== event.workspaceId
  ) {
    throw new DatabasePayloadError(
      "The leaf outbox columns do not match the event payload."
    );
  }
  return message;
};
