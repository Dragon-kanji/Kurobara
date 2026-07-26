import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { pluginAdapter } from "./dist/index.js";

const modes = new Set([
  "conformant",
  "errors",
  "idempotence",
  "lookup-always-found",
  "lookup-failed-outcome",
  "lookup-mismatch",
  "redaction",
  "redelivery-reference-drift",
  "schema",
  "second-execute-timeout",
  "timeout",
]);

const readOptions = () => {
  const values = { journalPath: undefined, mode: "conformant" };
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (flag === "--journal" && value) {
      values.journalPath = path.resolve(value);
      continue;
    }
    if (flag === "--mode" && value && modes.has(value)) {
      values.mode = value;
      continue;
    }
    throw new Error("plugin-sidecar-options-invalid");
  }
  if (!values.journalPath || process.argv.length !== 6) {
    throw new Error("plugin-sidecar-options-invalid");
  }
  return values;
};

const emptyJournal = () => ({ effects: {}, invocations: [], version: 1 });

const readJournal = async (journalPath) => {
  try {
    const value = JSON.parse(await readFile(journalPath, "utf8"));
    if (
      value?.version !== 1 ||
      !Array.isArray(value.invocations) ||
      value.effects === null ||
      typeof value.effects !== "object" ||
      Array.isArray(value.effects)
    ) {
      throw new Error("plugin-sidecar-journal-invalid");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyJournal();
    }
    throw error;
  }
};

const recordInvocation = async ({
  externalOperationReference,
  journalPath,
  method,
  mode,
  operationKey,
}) => {
  const journal = await readJournal(journalPath);
  const invocation = { method };
  if (operationKey) {
    invocation.operationKey = operationKey;
  }
  journal.invocations.push(invocation);
  if (method === "execute" && operationKey) {
    const existing = journal.effects[operationKey];
    const effectCount = (existing?.effectCount ?? 0) + 1;
    journal.effects[operationKey] = {
      effectCount: mode === "idempotence" ? effectCount : 1,
      externalOperationReference,
    };
  }
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
  return journal;
};

const readFrame = async () => {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  await once(process.stdin, "end");
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error("plugin-sidecar-frame-invalid");
  }
  return JSON.parse(lines[0]);
};

const resultFrame = (frame, method, payload) => ({
  id: frame.id,
  jsonrpc: "2.0",
  result: {
    apiVersion: "dev.kurobara.plugin-protocol/v1",
    direction: "result",
    method,
    payload,
  },
});

const options = readOptions();
const frame = await readFrame();
const message = frame.params;
const method = message?.method;
if (
  frame.jsonrpc !== "2.0" ||
  frame.method !== `plugin.${method}` ||
  message?.apiVersion !== "dev.kurobara.plugin-protocol/v1" ||
  message?.direction !== "request" ||
  typeof pluginAdapter[method] !== "function"
) {
  throw new Error("plugin-sidecar-frame-invalid");
}

const request = message.payload;
const operationKey = request?.operationKey;
const journalBefore = await readJournal(options.journalPath);
const alreadyDelivered = Boolean(
  operationKey && journalBefore.effects[operationKey]
);
let payload =
  method === "describe"
    ? pluginAdapter.describe()
    : await pluginAdapter[method](request);

if (
  method === "lookup" &&
  !journalBefore.effects[operationKey] &&
  options.mode !== "lookup-always-found"
) {
  payload = {
    proof: {
      observedAtMs: request.context.deadlineAtMs,
      proofReference: `proof:absent:${operationKey}`,
    },
    status: "authoritative-absent",
  };
}

if (
  method === "execute" &&
  (options.mode === "idempotence" ||
    (options.mode === "redelivery-reference-drift" && alreadyDelivered))
) {
  const effectCount =
    (journalBefore.effects[operationKey]?.effectCount ?? 0) + 1;
  payload = {
    ...payload,
    externalOperationReference: `external:${operationKey}:${effectCount}`,
  };
}

await recordInvocation({
  externalOperationReference: payload?.externalOperationReference,
  journalPath: options.journalPath,
  method,
  mode: options.mode,
  operationKey,
});

if (
  method === "execute" &&
  (options.mode === "timeout" ||
    (options.mode === "second-execute-timeout" && alreadyDelivered))
) {
  await new Promise(() => undefined);
}
if (method === "execute" && options.mode === "errors") {
  payload = {
    error: { class: "provider", reasonCode: "provider-rejected" },
    status: "failed",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "receipt:template:1",
      unit: "credits",
    },
  };
}
if (method === "classifyError" && options.mode === "errors") {
  throw new Error("plugin-sidecar-defective-errors");
}
if (method === "classifyError" && options.mode === "redaction") {
  payload = {
    error: {
      class: "unknown",
      reasonCode: request.diagnostic.providerCode,
    },
  };
}
if (method === "validateConfig" && options.mode === "schema") {
  payload = { ...payload, unexpected: true };
}
if (
  method === "lookup" &&
  payload.status === "found" &&
  options.mode === "lookup-failed-outcome"
) {
  payload = {
    ...payload,
    outcome: {
      error: { class: "provider", reasonCode: "provider-rejected" },
      status: "failed",
      usage: payload.outcome.usage,
    },
  };
}
if (
  method === "lookup" &&
  payload.status === "found" &&
  options.mode === "lookup-mismatch"
) {
  payload = {
    ...payload,
    outcome: {
      ...payload.outcome,
      externalOperationReference: `external:wrong:${operationKey}`,
    },
  };
}

process.stdout.write(
  `${JSON.stringify(resultFrame(frame, method, payload))}\n`
);
