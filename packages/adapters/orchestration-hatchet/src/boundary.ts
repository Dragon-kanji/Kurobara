import { eventId, runId, workspaceId } from "@kurobara/kernel";
import type { StartRunRequest } from "@kurobara/ports";
import { z } from "zod";

export const HATCHET_WORKFLOW_NAME = "kurobara-run-v1";

export const HATCHET_METADATA_KEYS = Object.freeze({
  eventId: "kurobara.event_id",
  runId: "kurobara.run_id",
  startKey: "kurobara.start_key",
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

export const HatchetRunInputSchema = z
  .object({
    eventId: opaqueValue,
    runId: opaqueValue,
    startKey: opaqueValue,
    workspaceId: opaqueValue,
  })
  .strict();

export type HatchetRunInput = Readonly<z.infer<typeof HatchetRunInputSchema>>;

export const parseHatchetRunInput = (input: unknown): HatchetRunInput =>
  Object.freeze(HatchetRunInputSchema.parse(input));

export const toHatchetRunInput = (request: StartRunRequest): HatchetRunInput =>
  parseHatchetRunInput(request);

export const toStartRunRequest = (input: HatchetRunInput): StartRunRequest =>
  Object.freeze({
    eventId: eventId(input.eventId),
    runId: runId(input.runId),
    startKey: input.startKey,
    workspaceId: workspaceId(input.workspaceId),
  });

export const metadataFor = (
  input: HatchetRunInput
): Readonly<Record<string, string>> =>
  Object.freeze({
    [HATCHET_METADATA_KEYS.eventId]: input.eventId,
    [HATCHET_METADATA_KEYS.runId]: input.runId,
    [HATCHET_METADATA_KEYS.startKey]: input.startKey,
    [HATCHET_METADATA_KEYS.workspaceId]: input.workspaceId,
  });

export const metadataMatches = (
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

export const inputMatches = (
  input: unknown,
  expected: HatchetRunInput
): boolean => {
  const parsed = HatchetRunInputSchema.safeParse(input);
  return (
    parsed.success &&
    parsed.data.eventId === expected.eventId &&
    parsed.data.runId === expected.runId &&
    parsed.data.startKey === expected.startKey &&
    parsed.data.workspaceId === expected.workspaceId
  );
};
