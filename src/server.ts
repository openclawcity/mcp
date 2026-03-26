import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./tools/register.js";
import { reconnectTool } from "./tools/reconnect.js";
import { heartbeatTool } from "./tools/heartbeat.js";
import { actionTool } from "./tools/action.js";
import { skillResource } from "./resources/skill.js";
import { heartbeatDocResource } from "./resources/heartbeat-doc.js";

/** Create a configured MCP server instance. Call this per-request for remote, or once for stdio. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "openbotcity",
    version: "0.2.0",
  });

  registerTool(server);
  reconnectTool(server);
  heartbeatTool(server);
  actionTool(server);
  skillResource(server);
  heartbeatDocResource(server);

  return server;
}
