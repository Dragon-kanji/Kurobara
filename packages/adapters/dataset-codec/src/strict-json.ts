interface ArrayContext {
  kind: "array";
}

interface ObjectContext {
  expectsKey: boolean;
  keys: Set<string>;
  kind: "object";
}

type Context = ArrayContext | ObjectContext;

const MAX_JSON_NESTING_DEPTH = 64;
const MAX_JSON_OBJECT_KEYS = 512;

type StrictJsonParseResult =
  | Readonly<{ ok: false }>
  | Readonly<{ ok: true; value: unknown }>;

const stringEnd = (source: string, start: number): number | undefined => {
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      return cursor + 1;
    }
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
};

const decodedKey = (
  source: string,
  start: number,
  end: number
): string | undefined => {
  try {
    const decoded = JSON.parse(source.slice(start, end)) as unknown;
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    // Invalid string tokens deliberately map to no decoded key.
  }
};

const scanString = (
  source: string,
  start: number,
  contexts: Context[]
): number | undefined => {
  const end = stringEnd(source, start);
  if (end === undefined) {
    return;
  }
  const context = contexts.at(-1);
  if (context?.kind !== "object" || !context.expectsKey) {
    return end;
  }
  const key = decodedKey(source, start, end);
  if (
    key === undefined ||
    context.keys.has(key) ||
    context.keys.size >= MAX_JSON_OBJECT_KEYS
  ) {
    return;
  }
  context.keys.add(key);
  context.expectsKey = false;
  return end;
};

const updateContexts = (character: string, contexts: Context[]): boolean => {
  if (character === "{") {
    if (contexts.length >= MAX_JSON_NESTING_DEPTH) {
      return false;
    }
    contexts.push({
      expectsKey: true,
      keys: new Set<string>(),
      kind: "object",
    });
  } else if (character === "[") {
    if (contexts.length >= MAX_JSON_NESTING_DEPTH) {
      return false;
    }
    contexts.push({ kind: "array" });
  } else if (character === "}" || character === "]") {
    contexts.pop();
  } else if (character === ",") {
    const context = contexts.at(-1);
    if (context?.kind === "object") {
      context.expectsKey = true;
    }
  }
  return true;
};

const hasUniqueObjectKeys = (source: string): boolean => {
  const contexts: Context[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      const next = scanString(source, cursor, contexts);
      if (next === undefined) {
        return false;
      }
      cursor = next;
      continue;
    }
    if (!updateContexts(character, contexts)) {
      return false;
    }
    cursor += 1;
  }
  return true;
};

export const parseJsonWithUniqueObjectKeys = (
  source: string
): StrictJsonParseResult => {
  if (!hasUniqueObjectKeys(source)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return { ok: false };
  }
};
