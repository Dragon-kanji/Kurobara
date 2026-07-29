import mcpCatalog from "@kurobara/contracts/mcp-tools.json" with {
  type: "json",
};
import {
  createKurobaraClient,
  type GtmContextCommand,
  type GtmContextStatusInput,
  type GtmQuestionnaireInput,
  type KurobaraClient,
  KurobaraProblemError,
  type PlayCommand,
  type PlayRunGetInput,
  type WorkbookGetInput,
  type WorkbookUpdateInput,
} from "@kurobara/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "kurobara";
const SERVER_VERSION = "0.1.0";
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const AGENT_FIRST_TOOL_NAMES = new Set([
  "kurobara_context_apply",
  "kurobara_context_plan",
  "kurobara_context_questions",
  "kurobara_context_status",
  "kurobara_play_apply",
  "kurobara_play_preview",
  "kurobara_play_run",
  "kurobara_workbook_get",
  "kurobara_workbook_update",
]);

export const KUROBARA_MCP_TOOLS: readonly Tool[] = Object.freeze(
  mcpCatalog.tools
    .filter((tool) => AGENT_FIRST_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      annotations: {
        destructiveHint: false,
        idempotentHint: tool.idempotence !== "not-supported",
        openWorldHint: false,
        readOnlyHint:
          tool.idempotence === "inherent" &&
          !tool.operation_id.endsWith(".apply") &&
          !tool.operation_id.endsWith(".update"),
      },
      description: `Kurobara ${tool.operation_id}. Required permissions: ${tool.required_permissions.join(", ") || "none"}.`,
      inputSchema: tool.inputSchema as unknown as Tool["inputSchema"],
      name: tool.name,
      title: tool.operation_id,
    }))
);

const requestObject = (arguments_: unknown): JsonObject => {
  if (!isObject(arguments_)) {
    throw new TypeError("MCP tool arguments must be one bounded JSON object.");
  }
  return arguments_;
};

const execute = (
  client: KurobaraClient,
  name: string,
  arguments_: JsonObject
): Promise<unknown> => {
  switch (name) {
    case "kurobara_context_questions":
      return client.contexts.questions(arguments_ as GtmQuestionnaireInput);
    case "kurobara_context_plan":
      return client.contexts.plan(
        arguments_ as Extract<GtmContextCommand, Readonly<{ mode: "plan" }>>
      );
    case "kurobara_context_apply":
      return client.contexts.apply(
        arguments_ as Extract<GtmContextCommand, Readonly<{ mode: "apply" }>>
      );
    case "kurobara_context_status":
      return client.contexts.status(arguments_ as GtmContextStatusInput);
    case "kurobara_play_preview":
      return client.plays.preview(
        arguments_ as Extract<PlayCommand, Readonly<{ action: "preview" }>>
      );
    case "kurobara_play_apply":
      return client.plays.apply(
        arguments_ as Exclude<PlayCommand, Readonly<{ action: "preview" }>>
      );
    case "kurobara_play_run":
      return client.playRuns.get(arguments_ as PlayRunGetInput);
    case "kurobara_workbook_get":
      return client.workbooks.get(arguments_ as WorkbookGetInput);
    case "kurobara_workbook_update":
      return client.workbooks.update(arguments_ as WorkbookUpdateInput);
    default:
      throw new TypeError("Unknown or unavailable Kurobara MCP tool.");
  }
};

const jsonTextResult = (value: unknown): CallToolResult => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    return {
      content: [
        {
          text: JSON.stringify({
            code: "mcp-result-too-large",
            retryable: false,
            title: "The bounded MCP result limit was exceeded.",
          }),
          type: "text",
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ text, type: "text" }],
    structuredContent: isObject(value) ? value : { value },
  };
};

export const executeKurobaraMcpTool = async (
  client: KurobaraClient,
  name: string,
  arguments_: unknown
): Promise<CallToolResult> => {
  if (!AGENT_FIRST_TOOL_NAMES.has(name)) {
    return {
      ...jsonTextResult({
        code: "mcp-tool-unavailable",
        retryable: false,
        title: "The requested tool is not exposed by this bounded server.",
      }),
      isError: true,
    };
  }
  try {
    return jsonTextResult(
      await execute(client, name, requestObject(arguments_))
    );
  } catch (error) {
    if (error instanceof KurobaraProblemError) {
      return {
        ...jsonTextResult(error.problem),
        isError: true,
      };
    }
    return {
      ...jsonTextResult({
        code: "mcp-tool-failed",
        retryable: false,
        title:
          "The Kurobara operation failed without exposing sensitive detail.",
      }),
      isError: true,
    };
  }
};

export const createKurobaraMcpServer = (client: KurobaraClient): Server => {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Inspect GTM readiness and questions before planning. Never infer a human-confirmation field. Preview the exact Play before apply or start, preserve fingerprints and idempotency keys, and stop on ambiguity or missing authority.",
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: KUROBARA_MCP_TOOLS })
  );
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    executeKurobaraMcpTool(
      client,
      request.params.name,
      request.params.arguments
    )
  );
  return server;
};

export const createKurobaraMcpClientFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): KurobaraClient => {
  const apiKey = environment.KUROBARA_API_KEY;
  if (apiKey === undefined) {
    throw new TypeError("KUROBARA_API_KEY is required.");
  }
  return createKurobaraClient({
    apiKey,
    baseUrl: environment.KUROBARA_API_URL ?? "http://127.0.0.1:3000",
  });
};
