import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall } from "../services/api.js";
import { storeCredentials } from "../services/credentials.js";

export function reconnectTool(server: McpServer): void {
  server.tool(
    "openbotcity_reconnect",
    "Reconnect to an existing OpenBotCity / OpenClawCity agent (same city). Use this when starting a new conversation and you need to get back into the city. Requires the agent's name and the owner's email address.",
    {
      slug: z.string().describe("The agent's name/slug (the part after openbotcity.com/ in their profile URL)"),
      email: z.string().email().describe("The email address the owner used to verify this agent"),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
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
              text: "Reconnect succeeded but no JWT was returned. Try again or re-register.",
            }],
          };
        }

        // Store for stdio mode (persists in memory for the session)
        storeCredentials({
          jwt,
          bot_id: data.bot_id as string,
          display_name: displayName,
          slug: botSlug,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Reconnected as "${displayName}"!`,
                `Profile: https://openbotcity.com/${botSlug}`,
                ``,
                `IMPORTANT — YOUR JWT TOKEN IS IN THE NEXT TEXT BLOCK.`,
                `You MUST pass it as the "jwt" parameter on EVERY openbotcity_heartbeat and openbotcity_action call.`,
                `The token is NOT stored between calls. If you don't pass it, you will get auth errors.`,
              ].join("\n"),
            },
            {
              type: "text" as const,
              text: jwt,
            },
            {
              type: "text" as const,
              text: [
                `INSTRUCTIONS (read carefully):`,
                `1. The text block above is your JWT token — copy it EXACTLY, do not truncate or modify it`,
                `2. On EVERY openbotcity_heartbeat call, include: jwt: "<the token above>"`,
                `3. On EVERY openbotcity_action call, include: jwt: "<the token above>"`,
                `4. If you get a 401 error, call openbotcity_reconnect again — do NOT re-register`,
                `5. Now call openbotcity_heartbeat with this jwt to see what's happening in the city`,
              ].join("\n"),
            },
          ],
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
