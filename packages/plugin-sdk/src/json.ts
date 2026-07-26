export const PLUGIN_JSON_MAX_DEPTH = 32;
export const PLUGIN_JSON_MAX_NODES = 4096;
export const PLUGIN_JSON_MAX_UTF8_BYTES = 65_536;

export type PluginJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly PluginJsonValue[]
  | Readonly<{ [key: string]: PluginJsonValue }>;

export const PLUGIN_JSON_VALIDATION_REASON_CODES = [
  "plugin-json-type-invalid",
  "plugin-json-number-invalid",
  "plugin-json-cycle",
  "plugin-json-array-sparse",
  "plugin-json-accessor",
  "plugin-json-symbol",
  "plugin-json-prototype-invalid",
  "plugin-json-property-invalid",
  "plugin-json-depth-exceeded",
  "plugin-json-node-limit-exceeded",
  "plugin-json-size-exceeded",
] as const;

export type PluginJsonValidationReasonCode =
  (typeof PLUGIN_JSON_VALIDATION_REASON_CODES)[number];

export type PluginJsonValidationResult =
  | Readonly<{
      ok: true;
      sizeBytes: number;
      value: PluginJsonValue;
    }>
  | Readonly<{
      ok: false;
      reasonCode: PluginJsonValidationReasonCode;
    }>;

export interface PluginJsonValidationLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxUtf8Bytes: number;
}

interface CloneState {
  readonly limits: PluginJsonValidationLimits;
  minimumUtf8Bytes: number;
  nodes: number;
  readonly parents: Set<object>;
  reasonCode?: PluginJsonValidationReasonCode;
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/u;
const UNSAFE_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const reject = (
  state: CloneState,
  reasonCode: PluginJsonValidationReasonCode
): undefined => {
  state.reasonCode ??= reasonCode;
};

const countNode = (state: CloneState): boolean => {
  state.nodes += 1;
  if (state.nodes <= state.limits.maxNodes) {
    return true;
  }
  reject(state, "plugin-json-node-limit-exceeded");
  return false;
};

const reserveMinimumUtf8Bytes = (state: CloneState, bytes: number): boolean => {
  if (bytes > state.limits.maxUtf8Bytes - state.minimumUtf8Bytes) {
    reject(state, "plugin-json-size-exceeded");
    return false;
  }
  state.minimumUtf8Bytes += bytes;
  return true;
};

const ownSymbolsAreAbsent = (value: object, state: CloneState): boolean => {
  if (Object.getOwnPropertySymbols(value).length === 0) {
    return true;
  }
  reject(state, "plugin-json-symbol");
  return false;
};

const arrayPropertiesAreCanonical = (
  value: readonly unknown[],
  propertyNames: readonly string[],
  state: CloneState
): boolean => {
  for (const key of propertyNames) {
    if (key === "length") {
      continue;
    }
    const index = ARRAY_INDEX.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      reject(state, "plugin-json-property-invalid");
      return false;
    }
  }
  return true;
};

const cloneArray = (
  value: readonly unknown[],
  depth: number,
  state: CloneState
): readonly PluginJsonValue[] | undefined => {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return reject(state, "plugin-json-prototype-invalid");
  }
  if (!ownSymbolsAreAbsent(value, state)) {
    return;
  }

  if (value.length > state.limits.maxNodes - state.nodes) {
    return reject(state, "plugin-json-node-limit-exceeded");
  }

  const propertyNames = Object.getOwnPropertyNames(value);
  if (!reserveMinimumUtf8Bytes(state, 2 + Math.max(0, value.length - 1))) {
    return;
  }

  if (!arrayPropertiesAreCanonical(value, propertyNames, state)) {
    return;
  }

  const clone: PluginJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      return reject(state, "plugin-json-array-sparse");
    }
    if (!("value" in descriptor)) {
      return reject(state, "plugin-json-accessor");
    }
    if (!descriptor.enumerable) {
      return reject(state, "plugin-json-property-invalid");
    }
    const nested = cloneValue(descriptor.value, depth + 1, state);
    if (nested === undefined && state.reasonCode !== undefined) {
      return;
    }
    clone.push(nested ?? null);
  }
  return clone;
};

const cloneObject = (
  value: object,
  depth: number,
  state: CloneState
): Readonly<{ [key: string]: PluginJsonValue }> | undefined => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return reject(state, "plugin-json-prototype-invalid");
  }
  if (!ownSymbolsAreAbsent(value, state)) {
    return;
  }

  const propertyNames = Object.getOwnPropertyNames(value);
  if (propertyNames.length > state.limits.maxNodes - state.nodes) {
    return reject(state, "plugin-json-node-limit-exceeded");
  }
  if (
    !reserveMinimumUtf8Bytes(state, 2 + Math.max(0, propertyNames.length - 1))
  ) {
    return;
  }

  const clone: { [key: string]: PluginJsonValue } = {};
  for (const key of propertyNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return reject(state, "plugin-json-property-invalid");
    }
    if (UNSAFE_PROPERTY_NAMES.has(key) || !descriptor.enumerable) {
      return reject(state, "plugin-json-property-invalid");
    }
    if (!("value" in descriptor)) {
      return reject(state, "plugin-json-accessor");
    }
    if (!reserveMinimumUtf8Bytes(state, key.length + 3)) {
      return;
    }
    const nested = cloneValue(descriptor.value, depth + 1, state);
    if (nested === undefined && state.reasonCode !== undefined) {
      return;
    }
    clone[key] = nested ?? null;
  }
  return clone;
};

const cloneNumber = (value: number, state: CloneState): number | undefined => {
  if (!Number.isFinite(value)) {
    return reject(state, "plugin-json-number-invalid");
  }
  return reserveMinimumUtf8Bytes(state, JSON.stringify(value).length)
    ? value
    : undefined;
};

const cloneValue = (
  value: unknown,
  depth: number,
  state: CloneState
): PluginJsonValue | undefined => {
  if (depth > state.limits.maxDepth) {
    return reject(state, "plugin-json-depth-exceeded");
  }
  if (!countNode(state)) {
    return;
  }
  if (value === null || typeof value === "boolean") {
    const minimumBytes = value === null || value ? 4 : 5;
    return reserveMinimumUtf8Bytes(state, minimumBytes) ? value : undefined;
  }
  if (typeof value === "string") {
    return value.length <= state.limits.maxUtf8Bytes &&
      reserveMinimumUtf8Bytes(state, value.length + 2)
      ? value
      : reject(state, "plugin-json-size-exceeded");
  }
  if (typeof value === "number") {
    return cloneNumber(value, state);
  }
  if (typeof value !== "object") {
    return reject(state, "plugin-json-type-invalid");
  }
  if (state.parents.has(value)) {
    return reject(state, "plugin-json-cycle");
  }

  state.parents.add(value);
  const clone = Array.isArray(value)
    ? cloneArray(value, depth, state)
    : cloneObject(value, depth, state);
  state.parents.delete(value);
  return clone;
};

const deepFreeze = <Value extends PluginJsonValue>(value: Value): Value => {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const validatePluginJsonCandidate = (
  candidate: unknown,
  limits: PluginJsonValidationLimits
): PluginJsonValidationResult => {
  const state: CloneState = {
    limits,
    minimumUtf8Bytes: 0,
    nodes: 0,
    parents: new Set(),
  };
  const value = cloneValue(candidate, 0, state);
  if (state.reasonCode !== undefined || value === undefined) {
    return {
      ok: false,
      reasonCode: state.reasonCode ?? "plugin-json-type-invalid",
    };
  }

  const serialized = JSON.stringify(value);
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;
  if (sizeBytes > limits.maxUtf8Bytes) {
    return { ok: false, reasonCode: "plugin-json-size-exceeded" };
  }
  return { ok: true, sizeBytes, value: deepFreeze(value) };
};

export const validatePluginJsonWithLimits = (
  candidate: unknown,
  limits: PluginJsonValidationLimits
): PluginJsonValidationResult => {
  try {
    return validatePluginJsonCandidate(candidate, limits);
  } catch {
    return { ok: false, reasonCode: "plugin-json-type-invalid" };
  }
};

export const validatePluginJson = (
  candidate: unknown
): PluginJsonValidationResult =>
  validatePluginJsonWithLimits(candidate, {
    maxDepth: PLUGIN_JSON_MAX_DEPTH,
    maxNodes: PLUGIN_JSON_MAX_NODES,
    maxUtf8Bytes: PLUGIN_JSON_MAX_UTF8_BYTES,
  });

export const isPluginJsonValue = (
  candidate: unknown
): candidate is PluginJsonValue => validatePluginJson(candidate).ok;
