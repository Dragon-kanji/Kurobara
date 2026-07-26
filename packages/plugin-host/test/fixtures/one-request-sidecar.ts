import { appendFileSync } from "node:fs";

import { FIXTURE_MANIFEST } from "./fixture-values.ts";

const PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES = 263_168;

const behavior = process.argv[2] ?? "normal";
if (behavior.endsWith(":ignore-term")) {
  process.on("SIGTERM", () => undefined);
}
const pidLog = process.argv[3];
if (pidLog) {
  appendFileSync(pidLog, `${process.pid}\n`, "utf8");
}
const requestLog = process.argv[4];

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => {
  chunks.push(Buffer.from(chunk));
});

interface FixtureRequestFrame {
  readonly id: string;
  readonly params: Readonly<{
    readonly method: string;
    readonly payload: Record<string, unknown>;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fixtureRequestFrame = (
  value: unknown
): FixtureRequestFrame | undefined => {
  if (!isRecord(value)) {
    return;
  }
  if (!isRecord(value.params)) {
    return;
  }
  const params = value.params;
  if (!isRecord(params.payload)) {
    return;
  }
  if (
    !(
      value.jsonrpc === "2.0" &&
      typeof value.id === "string" &&
      typeof value.method === "string" &&
      typeof params.method === "string" &&
      value.method === `plugin.${params.method}` &&
      params.direction === "request"
    )
  ) {
    return;
  }
  return {
    id: value.id,
    params: {
      method: params.method,
      payload: params.payload,
    },
  };
};

const responsePayload = (
  method: string,
  payload: Record<string, unknown>
): unknown => {
  switch (method) {
    case "describe":
      return {
        manifest:
          behavior === "describe:mismatch"
            ? { ...FIXTURE_MANIFEST, version: "2.0.0" }
            : FIXTURE_MANIFEST,
      };
    case "validateConfig":
      return {
        configurationFingerprint: (
          payload.configuration as { contentHash: string }
        ).contentHash,
        status: "valid",
      };
    case "estimate":
      return {
        quote: {
          expiresAtMs: (payload.context as { deadlineAtMs: number })
            .deadlineAtMs,
          guarantee: "hard",
          pricingVersion: "1.0.0",
          unit: "requests",
          upperBound: 1,
        },
        status: "quoted",
      };
    case "execute":
      return {
        externalOperationReference: "synthetic-operation",
        providerPayload: { operationKey: payload.operationKey },
        status: "succeeded",
        usage: { amount: 1, basis: "exact", unit: "requests" },
      };
    case "lookup":
      return {
        error: { class: "adapter", reasonCode: "adapter-fault" },
        status: "outcome-unknown",
      };
    case "normalize":
      return {
        normalizerVersion: "1.0.0",
        output: payload.providerPayload,
        status: "normalized",
      };
    case "health": {
      const observedAtMs = (payload.context as { deadlineAtMs: number })
        .deadlineAtMs;
      return {
        observedAtMs,
        status: "healthy",
        validUntilMs: observedAtMs,
      };
    }
    case "classifyError":
      return { error: { class: "unknown", reasonCode: "unclassified" } };
    default:
      return {};
  }
};

const writeResponse = (
  frame: Record<string, unknown>,
  target: string
): void => {
  const serialized = Buffer.from(JSON.stringify(frame), "utf8");
  switch (target) {
    case "bom":
      process.stdout.write(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          serialized,
          Buffer.from("\n"),
        ])
      );
      return;
    case "crlf":
      process.stdout.write(Buffer.concat([serialized, Buffer.from("\r\n")]));
      return;
    case "duplicate-jsonrpc":
      process.stdout.write(
        `{"id":${JSON.stringify(frame.id)},"jsonrpc":"1.0","jsonrpc":"2.0","result":${JSON.stringify(frame.result)}}\n`
      );
      return;
    case "duplicate-nested-escaped": {
      const result = frame.result as Record<string, unknown>;
      process.stdout.write(
        `{"id":${JSON.stringify(frame.id)},"jsonrpc":"2.0","result":{"apiVersion":${JSON.stringify(result.apiVersion)},"direction":${JSON.stringify(result.direction)},"method":${JSON.stringify(result.method)},"payload":{},"payl\\u006fad":${JSON.stringify(result.payload)}}}\n`
      );
      return;
    }
    case "empty":
      process.stdout.write("\n");
      return;
    case "extra":
      process.stdout.write(
        Buffer.concat([
          serialized,
          Buffer.from("\n"),
          serialized,
          Buffer.from("\n"),
        ])
      );
      return;
    case "flood":
      process.stdout.write(
        Buffer.alloc(PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES + 2, 0x78)
      );
      return;
    case "no-lf":
      process.stdout.write(serialized);
      return;
    case "stdout-prefix":
      process.stdout.write(
        Buffer.concat([Buffer.from("debug\n"), serialized, Buffer.from("\n")])
      );
      return;
    case "utf8":
      process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
      return;
    default:
      process.stdout.write(Buffer.concat([serialized, Buffer.from("\n")]));
  }
};

process.stdin.on("end", () => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exitCode = 2;
    return;
  }
  const requestFrame = fixtureRequestFrame(parsed);
  if (!requestFrame) {
    process.exitCode = 3;
    return;
  }
  const requestParams = requestFrame.params;
  const method = requestParams.method;
  if (requestLog) {
    appendFileSync(requestLog, `${method}\n`, "utf8");
  }
  const targeted = behavior.startsWith(`${method}:`)
    ? behavior.slice(method.length + 1)
    : "normal";
  if (targeted === "crash") {
    process.exit(17);
  }
  if (targeted === "stderr-crash") {
    process.stderr.write("synthetic-stderr-canary");
    process.exit(18);
  }
  if (targeted === "hang" || targeted === "ignore-term") {
    setInterval(() => undefined, 1000);
    return;
  }

  const respond = (): void => {
    if (targeted === "stderr-canary") {
      process.stderr.write("synthetic-stderr-canary");
    }
    const result = {
      apiVersion: "dev.kurobara.plugin-protocol/v1",
      direction: "result",
      method,
      payload: responsePayload(
        method,
        requestParams.payload as Record<string, unknown>
      ),
    };
    writeResponse(
      {
        id: targeted === "wrong-id" ? "host-call-999" : requestFrame.id,
        jsonrpc: "2.0",
        result:
          targeted === "wrong-method"
            ? { ...result, method: "health" }
            : result,
      },
      targeted
    );
  };
  if (targeted === "delay") {
    setTimeout(respond, 250);
  } else {
    respond();
  }
});
