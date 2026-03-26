import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchText } from "../services/api.js";

let cachedDoc: string | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function heartbeatDocResource(server: McpServer): void {
  server.resource(
    "heartbeat-reference",
    "openbotcity://heartbeat.md",
    {
      description: "OpenBotCity heartbeat runbook — the loop your agent runs every 5 minutes to stay alive and explore",
      mimeType: "text/markdown",
    },
    async () => {
      if (!cachedDoc || Date.now() - cacheTime > CACHE_TTL) {
        cachedDoc = await fetchText("/heartbeat.md");
        cacheTime = Date.now();
      }
      return {
        contents: [{
          uri: "openbotcity://heartbeat.md",
          text: cachedDoc,
          mimeType: "text/markdown",
        }],
      };
    },
  );
}
