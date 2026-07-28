import assert from "node:assert/strict";
import test from "node:test";
import type { KurobaraClient } from "@kurobara/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createKurobaraMcpServer,
  executeKurobaraMcpTool,
  KUROBARA_MCP_TOOLS,
} from "../src/server.ts";

const UNAVAILABLE_TOOL_PATTERN = /mcp-tool-unavailable/u;

const client = {
  contexts: {
    apply: () => Promise.reject(new Error("not used")),
    plan: () => Promise.reject(new Error("not used")),
    questions: ({ profile }: { profile: string }) =>
      Promise.resolve({
        profile,
        questionnaire_version: "1.0.0",
        questions: [],
      }),
    status: () => Promise.reject(new Error("not used")),
  },
  playRuns: { get: () => Promise.reject(new Error("not used")) },
  plays: {
    apply: () => Promise.reject(new Error("not used")),
    preview: () => Promise.reject(new Error("not used")),
  },
  workbooks: {
    get: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
  },
} as unknown as KurobaraClient;

test("exposes exactly the bounded agent-first tools from the canonical catalog", () => {
  assert.deepEqual(
    KUROBARA_MCP_TOOLS.map((tool) => tool.name),
    [
      "kurobara_context_apply",
      "kurobara_context_plan",
      "kurobara_context_questions",
      "kurobara_context_status",
      "kurobara_play_run",
      "kurobara_play_apply",
      "kurobara_play_preview",
      "kurobara_workbook_get",
      "kurobara_workbook_update",
    ]
  );
  assert.equal(
    KUROBARA_MCP_TOOLS.every(
      (tool) =>
        tool.inputSchema.additionalProperties === false &&
        tool.annotations?.openWorldHint === false
    ),
    true
  );
});

test("returns structured JSON without exposing transport or provider detail", async () => {
  const result = await executeKurobaraMcpTool(
    client,
    "kurobara_context_questions",
    { profile: "agentic_outbound_play" }
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    profile: "agentic_outbound_play",
    questionnaire_version: "1.0.0",
    questions: [],
  });

  const unavailable = await executeKurobaraMcpTool(client, "unknown-tool", {});
  assert.equal(unavailable.isError, true);
  assert.match(
    unavailable.content[0]?.type === "text" ? unavailable.content[0].text : "",
    UNAVAILABLE_TOOL_PATTERN
  );
});

test("negotiates tools and executes a call through the real MCP protocol", async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createKurobaraMcpServer(client);
  const protocolClient = new Client({
    name: "kurobara-test-client",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    protocolClient.connect(clientTransport),
  ]);
  try {
    const listed = await protocolClient.listTools();
    assert.equal(listed.tools.length, 9);
    const result = await protocolClient.callTool({
      arguments: { profile: "agentic_outbound_play" },
      name: "kurobara_context_questions",
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      profile: "agentic_outbound_play",
      questionnaire_version: "1.0.0",
      questions: [],
    });
  } finally {
    await Promise.all([protocolClient.close(), server.close()]);
  }
});
