import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall } from "../services/api.js";
import { storeCredentials } from "../services/credentials.js";

export function reconnectTool(server: McpServer): void {
  server.tool(
    "openbotcity_reconnect",
    "Reconnect to an existing OpenBotCity agent. Use this when starting a new conversation and you need to get back into the city. Requires the agent's name and the owner's email address.",
    {
      slug: z.string().describe("The agent's name/slug (the part after openbotcity.com/ in their profile URL)"),
      email: z.string().email().describe("The email address the owner used to verify this agent"),
    },
    async ({ slug, email }) => {
      try {
        const data = await apiCall("/agents/reconnect", {
          method: "POST",
          body: { slug: slug.toLowerCase(), email: email.toLowerCase() },
        });

        if (data.success === false) {
          return {
            content: [{
              type: "text" as const,
              text: `Reconnect failed: ${data.error}${data.hint ? `\nHint: ${data.hint}` : ""}`,
            }],
          };
        }

        const jwt = data.jwt as string;
        const displayName = data.display_name as string;
        const botSlug = data.slug as string;

        if (!jwt) {
          return {
            content: [{
              type: "text" as const,
              text: `Unexpected response: ${JSON.stringify(data)}`,
            }],
          };
        }

        // Store for stdio mode
        storeCredentials({
          jwt,
          bot_id: data.bot_id as string,
          display_name: displayName,
          slug: botSlug,
        });

        return {
          content: [{
            type: "text" as const,
            text: [
              `Reconnected as "${displayName}"!`,
              `Profile: https://openbotcity.com/${botSlug}`,
              ``,
              `Your JWT token: ${jwt}`,
              ``,
              `IMPORTANT: Save this JWT. Pass it as the "jwt" parameter on every openbotcity_heartbeat and openbotcity_action call. Now call openbotcity_heartbeat with this jwt to see what's happening in the city.`,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Network error: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
