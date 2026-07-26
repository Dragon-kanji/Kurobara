import { visit } from "jsonc-parser";

interface StrictJsonSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface StrictJsonFailure {
  readonly ok: false;
}

type StrictJsonResult = StrictJsonFailure | StrictJsonSuccess;

const STRICT_JSON_FAILURE = Object.freeze({ ok: false } as const);

export const parseStrictJson = (source: string): StrictJsonResult => {
  const objectProperties: Set<string>[] = [];
  let invalid = false;

  try {
    visit(
      source,
      {
        onError: () => {
          invalid = true;
        },
        onObjectBegin: () => {
          objectProperties.push(new Set());
        },
        onObjectEnd: () => {
          if (!objectProperties.pop()) {
            invalid = true;
          }
        },
        onObjectProperty: (property) => {
          const properties = objectProperties.at(-1);
          if (!properties || properties.has(property)) {
            invalid = true;
            return;
          }
          properties.add(property);
        },
      },
      { allowTrailingComma: false, disallowComments: true }
    );
    if (invalid || objectProperties.length !== 0) {
      return STRICT_JSON_FAILURE;
    }
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return STRICT_JSON_FAILURE;
  }
};
