import { once } from "node:events";

import { externalPluginAdapter } from "./dist/index.js";

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
await once(process.stdin, "end");

const lines = chunks
  .join("")
  .split("\n")
  .filter((line) => line.length > 0);
if (lines.length !== 1) {
  throw new Error(
    "The fixture sidecar accepts exactly one request per process."
  );
}

const frame = JSON.parse(lines[0]);
const message = frame.params;
const method = message?.method;
if (
  frame.jsonrpc !== "2.0" ||
  frame.method !== `plugin.${method}` ||
  message?.apiVersion !== "dev.kurobara.plugin-protocol/v1" ||
  message?.direction !== "request" ||
  typeof externalPluginAdapter[method] !== "function"
) {
  throw new Error("The fixture sidecar received an invalid request frame.");
}

const payload =
  method === "describe"
    ? externalPluginAdapter.describe()
    : await externalPluginAdapter[method](message.payload);

process.stdout.write(
  `${JSON.stringify({
    id: frame.id,
    jsonrpc: "2.0",
    result: {
      apiVersion: message.apiVersion,
      direction: "result",
      method,
      payload,
    },
  })}\n`
);
