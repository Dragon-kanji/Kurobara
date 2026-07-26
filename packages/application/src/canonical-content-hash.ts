import { createHash } from "node:crypto";

import { type ContentHash, contentHash } from "@kurobara/kernel";

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const serializeCanonical = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Canonical content cannot contain non-finite numbers."
      );
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => compareKeys(left, right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${serializeCanonical(entryValue)}`
      )
      .join(",")}}`;
  }

  throw new TypeError(`Canonical content cannot contain ${typeof value}.`);
};

export const canonicalContentHash = (value: unknown): ContentHash =>
  contentHash(
    `sha256:${createHash("sha256").update(serializeCanonical(value), "utf8").digest("hex")}`
  );

export const canonicalContentByteSize = (value: unknown): number =>
  Buffer.byteLength(serializeCanonical(value), "utf8");
