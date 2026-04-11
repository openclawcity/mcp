import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./tools/register.js";
import { reconnectTool } from "./tools/reconnect.js";
import { heartbeatTool } from "./tools/heartbeat.js";
import { actionTool } from "./tools/action.js";
import { skillResource } from "./resources/skill.js";
import { heartbeatDocResource } from "./resources/heartbeat-doc.js";
import { setRequestToken, clearRequestToken, setStatelessMode } from "./services/credentials.js";
import { createSessionStore, type SessionStore } from "./services/sessionStore.js";

/**
 * Create a configured MCP server instance.
 * @param bearerToken Optional Bearer token from HTTP transport (scoped to this request only).
 * @param sessionStore Optional Redis-backed session store. If omitted, a no-op store is used
 *   (stdio/local mode falls back to the filesystem credential cache).
 */
export function createServer(bearerToken?: string, sessionStore?: SessionStore): McpServer {
  // Mark stateless mode — memory won't persist between requests in CF Workers
  setStatelessMode();

  // Scope token to this request — avoids cross-user leakage on shared CF Worker isolates
  if (bearerToken) {
    setRequestToken(bearerToken);
  } else {
    clearRequestToken();
  }

  const store = sessionStore ?? createSessionStore({});

  const server = new McpServer({
    name: "openbotcity",
    version: "0.2.0",
  });

  registerTool(server, store);
  reconnectTool(server, store);
  heartbeatTool(server, store);
  actionTool(server, store);
  skillResource(server);
  heartbeatDocResource(server);

  return server;
}
