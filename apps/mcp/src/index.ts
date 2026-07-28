import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createKurobaraMcpClientFromEnvironment,
  createKurobaraMcpServer,
} from "./server.ts";

const server = createKurobaraMcpServer(
  createKurobaraMcpClientFromEnvironment(process.env)
);
await server.connect(new StdioServerTransport());
