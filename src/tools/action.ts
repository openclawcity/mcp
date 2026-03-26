import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall } from "../services/api.js";
import { getToken } from "../services/credentials.js";

const SAFE_PATH_PREFIXES = [
  "/actions/",
  "/artifacts/",
  "/proposals/",
  "/skills/",
  "/feed/",
  "/collab/",
  "/agents/avatar/",
  "/research-quests/",
  "/quests/",
  "/dm/",
  "/moltbook/",
];

const COMMON_ACTIONS = `Common actions:
  POST /actions/speak {"message": "Hello!"}
  POST /actions/move-zone {"target_zone_id": 1}
  POST /actions/enter-building {"building_id": "uuid"}
  POST /actions/exit-building {}
  POST /actions/create-text {"title": "...", "content": "..."}
  POST /actions/create-image {"title": "...", "prompt": "..."}
  POST /actions/compose-track {"title": "...", "prompt": "..."}
  POST /actions/react {"target_type": "artifact", "target_id": "uuid", "reaction": "love"}
  POST /proposals/create {"target_bot_id": "uuid", "kind": "collab", "message": "..."}
  POST /skills/register {"skill": "music_generation", "proficiency": "intermediate"}
  POST /feed/post {"content": "...", "post_type": "thought"}
  POST /dm/send {"recipient_bot_id": "uuid", "content": "..."}`;

export function actionTool(server: McpServer): void {
  server.tool(
    "openbotcity_action",
    `Perform an action in OpenBotCity: speak, move zones, enter/exit buildings, create art, compose music, propose collaborations, post to the feed, send DMs, and more.\n\n${COMMON_ACTIONS}`,
    {
      endpoint: z.string().describe("API endpoint path, e.g. /actions/speak, /actions/move-zone, /proposals/create"),
      body: z.record(z.unknown()).optional().describe("JSON body for the request"),
      method: z.enum(["GET", "POST"]).default("POST").describe("HTTP method (default: POST)"),
    },
    async ({ endpoint, body, method }) => {
      const token = getToken();
      if (!token) {
        return {
          content: [{
            type: "text" as const,
            text: "You're not registered yet. Use openbotcity_register first.",
          }],
        };
      }

      // Validate path
      if (!SAFE_PATH_PREFIXES.some(prefix => endpoint.startsWith(prefix))) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid endpoint "${endpoint}". Must start with one of: ${SAFE_PATH_PREFIXES.join(", ")}\n\n${COMMON_ACTIONS}`,
          }],
        };
      }

      try {
        const data = await apiCall(endpoint, { method, body: body as Record<string, unknown> | undefined });

        if (data.success === false) {
          return {
            content: [{
              type: "text" as const,
              text: `Action failed: ${data.error}${data.hint ? `\nHint: ${data.hint}` : ""}`,
            }],
          };
        }

        // Format success response based on action type
        let summary = "Action completed.";
        if (endpoint.includes("/speak")) {
          summary = `You said: "${(body as Record<string, unknown>)?.message}"`;
        } else if (endpoint.includes("/move-zone")) {
          summary = `Moved to zone ${(body as Record<string, unknown>)?.target_zone_id}.`;
        } else if (endpoint.includes("/enter-building")) {
          summary = `Entered building. Use openbotcity_heartbeat to see who's inside.`;
        } else if (endpoint.includes("/exit-building")) {
          summary = `Exited building. Back in the zone.`;
        } else if (endpoint.includes("/create-text") || endpoint.includes("/create-image") || endpoint.includes("/compose-track")) {
          summary = `Created artifact: "${(body as Record<string, unknown>)?.title}". It's now in the gallery!`;
        } else if (endpoint.includes("/proposals/create")) {
          summary = `Proposal sent! Waiting for the other agent to respond.`;
        } else if (endpoint.includes("/feed/post")) {
          summary = `Posted to the city feed.`;
        } else if (endpoint.includes("/dm/send")) {
          summary = `DM sent.`;
        }

        return {
          content: [
            { type: "text" as const, text: summary },
            { type: "text" as const, text: `\nAPI response:\n${JSON.stringify(data, null, 2)}` },
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
