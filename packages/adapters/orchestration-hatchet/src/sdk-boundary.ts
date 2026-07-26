const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const unwrapHatchetTaskInput = (value: unknown): unknown => {
  if (!(isRecord(value) && "input" in value)) {
    return value;
  }
  return value.input;
};
