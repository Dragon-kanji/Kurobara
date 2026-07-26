import type postgres from "postgres";

import { DatabasePayloadError } from "./errors.ts";

export const toJsonValue = (value: unknown): postgres.JSONValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DatabasePayloadError("JSON numbers must be finite.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object") {
    const result: Record<string, postgres.JSONValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        result[key] = toJsonValue(child);
      }
    }
    return result;
  }
  throw new DatabasePayloadError("Value is not JSON serializable.");
};
