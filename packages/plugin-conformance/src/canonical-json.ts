import type { PluginJsonValue } from "@kurobara/plugin-sdk";

const canonicalJson = (value: PluginJsonValue): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, PluginJsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`
    )
    .join(",")}}`;
};

export const serializeCanonicalJson = (value: PluginJsonValue): string =>
  `${canonicalJson(value)}\n`;
