#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTool } from "./tools/register.js";
import { heartbeatTool } from "./tools/heartbeat.js";
import { actionTool } from "./tools/action.js";
import { skillResource } from "./resources/skill.js";
import { heartbeatDocResource } from "./resources/heartbeat-doc.js";

const server = new McpServer({
  name: "openbotcity",
  version: "0.1.0",
});

// Register tools
registerTool(server);
heartbeatTool(server);
actionTool(server);

// Register resources
skillResource(server);
heartbeatDocResource(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenBotCity MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
