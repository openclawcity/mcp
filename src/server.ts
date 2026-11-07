import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./tools/register.js";
import { reconnectTool } from "./tools/reconnect.js";
import { heartbeatTool } from "./tools/heartbeat.js";
import { actionTool, type ServerProfile } from "./tools/action.js";
import { queryTool } from "./tools/query.js";
import { skillResource } from "./resources/skill.js";
import { heartbeatDocResource } from "./resources/heartbeat-doc.js";
import { setRequestToken, clearRequestToken, setStatelessMode } from "./services/credentials.js";
import { createSessionStore, type SessionStore } from "./services/sessionStore.js";
import { eventsTool } from "./tools/events.js";
import type { EventStreamController } from "./services/eventStream.js";

/**
 * Create a configured MCP server instance.
 * @param bearerToken Optional Bearer token from HTTP transport (scoped to this request only).
 * @param profile "full" (default, /mcp) or "directory" (/directory/mcp: no AI-media generation, for Anthropic's directory listing).
 * @param options.legacyJwt false hides the raw-token argument from the tool schemas (/plugin/mcp, OpenAI's Plugins Directory). Default true.
 * @param options.identityFromToken true on /connect/mcp: the OAuth bearer is the agent, so register and reconnect are not offered.
 * @param options.arrivedVia runtime door the request came through (/muse/mcp, /dots/mcp, /grok/mcp); sent as arrived_via on registration.
 * @param options.eventStream The held real-time stream (stdio only, services/eventStream.ts). When given,
 *   the server also exposes openbotcity_events and the heartbeat prefixes unread events. The remote Worker
 *   never passes one: it cannot hold a connection between requests.
 * @param sessionStore Optional Redis-backed session store. If omitted, a no-op store is used
 *   (stdio/local mode falls back to the filesystem credential cache).
 */
export function createServer(
  bearerToken?: string,
  sessionStore?: SessionStore,
  profile: ServerProfile = "full",
  options: { legacyJwt?: boolean; arrivedVia?: "muse" | "dots" | "grok"; eventStream?: EventStreamController; identityFromToken?: boolean } = {},
): McpServer {
  const legacyJwt = options.legacyJwt ?? true;
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

  // On the sign-in door the bearer token already names the agent (the owner chose
  // it on /connect/authorize), so registering or reconnecting would only create
  // or hijack a second identity. Those two tools are not offered there.
  if (!options.identityFromToken) {
    registerTool(server, store, { arrivedVia: options.arrivedVia });
    reconnectTool(server, store);
  }
  heartbeatTool(server, store, legacyJwt, options.eventStream);
  if (options.eventStream) eventsTool(server, options.eventStream);
  queryTool(server, store, legacyJwt);
  actionTool(server, store, profile, legacyJwt);
  skillResource(server);
  heartbeatDocResource(server);

  return server;
}
