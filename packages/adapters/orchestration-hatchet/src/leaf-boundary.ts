import {
  attemptId,
  eventId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import type { StartLeafAttemptRequest } from "@kurobara/ports";
import { z } from "zod";

export const HATCHET_LEAF_TASK_NAME = "kurobara-step-attempt-v1";

export const HATCHET_LEAF_METADATA_KEYS = Object.freeze({
  attemptId: "kurobara.attempt_id",
  eventId: "kurobara.event_id",
  runId: "kurobara.run_id",
  startKey: "kurobara.start_key",
  stepRunId: "kurobara.step_run_id",
  workspaceId: "kurobara.workspace_id",
});

const MAX_OPAQUE_VALUE_LENGTH = 256;

const hasNoControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
  });

const opaqueValue = z
  .string()
  .min(1)
  .max(MAX_OPAQUE_VALUE_LENGTH)
  .refine((value) => value === value.trim(), "must not have outer whitespace")
  .refine(hasNoControlCharacters, "must not contain control characters");

export const HatchetLeafInputSchema = z
  .object({
    attemptId: opaqueValue,
    eventId: opaqueValue,
    runId: opaqueValue,
    startKey: opaqueValue,
    stepRunId: opaqueValue,
    workspaceId: opaqueValue,
  })
  .strict();

export type HatchetLeafInput = Readonly<z.infer<typeof HatchetLeafInputSchema>>;

export const parseHatchetLeafInput = (input: unknown): HatchetLeafInput =>
  Object.freeze(HatchetLeafInputSchema.parse(input));

export const toHatchetLeafInput = (
  request: StartLeafAttemptRequest
): HatchetLeafInput => parseHatchetLeafInput(request);

export const toStartLeafAttemptRequest = (
  input: HatchetLeafInput
): StartLeafAttemptRequest =>
  Object.freeze({
    attemptId: attemptId(input.attemptId),
    eventId: eventId(input.eventId),
    runId: runId(input.runId),
    startKey: input.startKey,
    stepRunId: stepRunId(input.stepRunId),
    workspaceId: workspaceId(input.workspaceId),
  });

export const leafMetadataFor = (
  input: HatchetLeafInput
): Readonly<Record<string, string>> =>
  Object.freeze({
    [HATCHET_LEAF_METADATA_KEYS.attemptId]: input.attemptId,
    [HATCHET_LEAF_METADATA_KEYS.eventId]: input.eventId,
    [HATCHET_LEAF_METADATA_KEYS.runId]: input.runId,
    [HATCHET_LEAF_METADATA_KEYS.startKey]: input.startKey,
    [HATCHET_LEAF_METADATA_KEYS.stepRunId]: input.stepRunId,
    [HATCHET_LEAF_METADATA_KEYS.workspaceId]: input.workspaceId,
  });

export const leafMetadataMatches = (
  metadata: unknown,
  expected: Readonly<Record<string, string>>
): boolean => {
  if (metadata === null || typeof metadata !== "object") {
    return false;
  }

  const candidate = metadata as Readonly<Record<string, unknown>>;
  return Object.entries(expected).every(
    ([key, value]) => candidate[key] === value
  );
};

export const leafInputMatches = (
  input: unknown,
  expected: HatchetLeafInput
): boolean => {
  const parsed = HatchetLeafInputSchema.safeParse(input);
  return (
    parsed.success &&
    parsed.data.attemptId === expected.attemptId &&
    parsed.data.eventId === expected.eventId &&
    parsed.data.runId === expected.runId &&
    parsed.data.startKey === expected.startKey &&
    parsed.data.stepRunId === expected.stepRunId &&
    parsed.data.workspaceId === expected.workspaceId
  );
};
