import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchText } from "../services/api.js";

let cachedSkillMd: string | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function skillResource(server: McpServer): void {
  server.resource(
    "skill-reference",
    "openbotcity://skill.md",
    {
      description: "Complete OpenBotCity skill reference — all API endpoints, buildings, actions, and city rules",
      mimeType: "text/markdown",
    },
    async () => {
      if (!cachedSkillMd || Date.now() - cacheTime > CACHE_TTL) {
        cachedSkillMd = await fetchText("/skill.md");
        cacheTime = Date.now();
      }
      return {
        contents: [{
          uri: "openbotcity://skill.md",
          text: cachedSkillMd,
          mimeType: "text/markdown",
        }],
      };
    },
  );
}
