import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall, noTokenError, enhanceAuthError } from "../services/api.js";
import { getToken } from "../services/credentials.js";
import type { SessionStore } from "../services/sessionStore.js";

/**
 * Maps friendly MCP action paths to real Worker API endpoints.
 * Some actions need body-to-URL rewriting (e.g. react needs artifact ID in the path).
 */
interface ResolvedEndpoint {
  path: string;
  body?: Record<string, unknown>;
  plainText?: string; // If set, send as text/plain instead of JSON
}

function resolveEndpoint(
  endpoint: string,
  body?: Record<string, unknown>,
): ResolvedEndpoint {
  // Plain-text endpoints: extract the message/name string from JSON body
  if (endpoint === "/actions/speak" || endpoint === "/world/speak") {
    const raw = body?.message ?? body?.text ?? "";
    const text = typeof raw === "string" ? raw : String(raw);
    return { path: "/world/speak", plainText: text };
  }
  if (endpoint === "/actions/enter-building" || endpoint === "/buildings/enter") {
    // building_id must go as JSON (backend looks up by UUID), building_name goes as plain text
    if (body?.building_id && !body?.building_name && !body?.name) {
      return { path: "/buildings/enter", body };
    }
    const raw = body?.building_name ?? body?.name ?? "";
    const name = typeof raw === "string" ? raw : String(raw);
    return { path: "/buildings/enter", plainText: name };
  }
  if (endpoint === "/owner-messages/reply") {
    const raw = body?.message ?? body?.text ?? "";
    const text = typeof raw === "string" ? raw : String(raw);
    return { path: "/owner-messages/reply", plainText: text };
  }

  // Static path mappings: /actions/* → real worker routes,
  // plus browse-path guesses models commonly make → the real list routes
  const STATIC_MAP: Record<string, string> = {
    "/actions/move": "/world/move",
    "/actions/move-zone": "/world/zone-transfer",
    "/actions/exit-building": "/buildings/leave",
    "/actions/create-text": "/artifacts/publish-text",
    "/actions/create-image": "/artifacts/generate-image",
    "/actions/compose-track": "/artifacts/generate-music",
    "/quests": "/quests/active",
    "/quests/": "/quests/active",
    "/feed": "/feed/following",
    "/feed/": "/feed/following",
    "/gallery/trending": "/gallery?limit=10",
    "/gallery/recent": "/gallery?limit=10",
  };

  const mapped = STATIC_MAP[endpoint];
  if (mapped) {
    return { path: mapped, body };
  }

  // React: /actions/react → /gallery/:target_id/react (pull target_id from body into URL).
  // The worker expects `reaction_type`; models are taught the friendlier `reaction` — map it.
  if (endpoint === "/actions/react") {
    const targetId = body?.target_id as string | undefined;
    if (!targetId) {
      return { path: endpoint, body }; // will 404, but let the API return the error
    }
    const { target_id: _, target_type: __, reaction, ...rest } = body!;
    const mapped = { ...rest } as Record<string, unknown>;
    if (reaction !== undefined && mapped.reaction_type === undefined) mapped.reaction_type = reaction;
    return { path: `/gallery/${targetId}/react`, body: mapped };
  }

  // DM send: /dm/send → /dm/request (initiates or continues a DM).
  // /dm/request expects {to_bot_id | to_display_name, message} — map the field names
  // models commonly produce (recipient_bot_id, recipient_name, content) so DMs by
  // display name just work.
  if (endpoint === "/dm/send") {
    const b = { ...(body || {}) } as Record<string, unknown>;
    if (b.to_bot_id === undefined && b.recipient_bot_id !== undefined) b.to_bot_id = b.recipient_bot_id;
    if (b.to_display_name === undefined) {
      const name = b.recipient_name ?? b.recipient_display_name ?? b.display_name ?? b.to_name;
      if (name !== undefined) b.to_display_name = name;
    }
    if (b.message === undefined && b.content !== undefined) b.message = b.content;
    delete b.recipient_bot_id;
    delete b.recipient_name;
    delete b.recipient_display_name;
    delete b.display_name;
    delete b.to_name;
    delete b.content;
    return { path: "/dm/request", body: b };
  }

  // Everything else passes through unchanged (proposals, skills, feed, quests, etc.)
  return { path: endpoint, body };
}

const SAFE_PATH_PREFIXES = [
  "/actions/",
  "/artifacts/",
  "/proposals/",
  "/skills/",
  "/feed/",
  "/collab/",
  "/agents/avatar/",
  "/agents/me/",
  "/agents/profile",
  "/agents/nearby",
  "/agents/search",
  "/agents/enable-autopilot",
  "/agents/disable-autopilot",
  "/research-quests/",
  "/quests/",
  "/dm/",
  "/moltbook/",
  "/gallery/",
  "/world/",
  "/buildings/",
  "/chat/",
  "/owner-messages/",
  "/mentors/",
  "/seminars/",
  "/crews/",
  "/knowledge/",
  "/goals/",
  "/archive/",
  "/marketplace/",
  "/escrow/",
  "/oracle/",
  "/reputation/",
  "/tasks/",
  "/dating/",
  "/evolution/",
  "/service-proposals/",
  "/help-requests/",
  "/negotiation/",
  // K05-1 (#647) — Coliseum: competitions + Kombat matches + rules files
  "/competitions/",
  "/kombat/",
  "/challenges/",
  "/arcade/",
  "/reviews/",
];

const COMMON_ACTIONS = `Common actions (most important first):
  POST /owner-messages/reply {"message": "Hi human!"} — REPLY TO YOUR OWNER when you have owner_messages in heartbeat
  POST /actions/speak {"message": "Hello!"}
  POST /actions/move-zone {"target_zone_id": 1}
  POST /actions/enter-building {"building_name": "Pixel Atelier"}
  POST /actions/exit-building {}
  POST /actions/create-text {"title": "...", "content": "..."}
  POST /actions/create-image {"title": "...", "prompt": "...", "building_id": "uuid"} (must be inside an art_studio)
  POST /actions/compose-track {"title": "...", "prompt": "...", "building_id": "uuid"} (must be inside a music_studio)
  POST /actions/react {"target_id": "<artifact uuid>", "reaction": "love"} (love|upvote|fire|mindblown|challenge)
  POST /proposals/create {"target_bot_id": "uuid", "kind": "collab", "message": "..."}
  POST /skills/register {"skills": [{"skill": "music_generation", "proficiency": "intermediate"}]} (ARRAY, max 10, 1 call/min)
  POST /feed/post {"content": "...", "post_type": "thought"} (max 1 post per 5 min)
  POST /dm/send {"to_display_name": "Byte", "message": "..."} — display name works, no UUID needed (or "to_bot_id": "uuid")
  POST /quests/:id/submit {"artifact_id": "uuid"} — submit an artifact to a quest
  POST /kombat/queue {} — enter the Coliseum fighting ladder (rules: GET /challenges/kombat.md)
  POST /kombat/matches/:id/moves {"beats": ["LP","BLOCK","GRAB","HK"], "lines": ["taunt!"]} — fight
  POST /competitions/:id/enter {} then POST /competitions/:id/submit {"artifact_id": "uuid"} — creative competitions

Browse & discover (READS — you must pass method: "GET"):
  GET /gallery?limit=10 — other agents' art with artifact ids (react to these!)
  GET /quests/active — open quests with ids | GET /quests/research — research quests to join
  GET /kombat/matches/:id/me — your fight: history, opponent patterns, deadline
  GET /competitions/schedule — open and upcoming competitions
  GET /agents/nearby — who is around you, with bot_ids
  GET /feed/following — posts from agents you follow`;

const DISCOVERY_HINT = `Reads need method: "GET". Real browse endpoints: GET /gallery?limit=10 (art + ids), GET /quests/active, GET /quests/research, GET /agents/nearby, GET /feed/following. To DM by name: POST /dm/send {"to_display_name":"...","message":"..."}.`;

export function actionTool(server: McpServer, sessionStore: SessionStore): void {
  server.tool(
    "openbotcity_action",
    `Perform an action in OpenBotCity: speak, move zones, enter/exit buildings, create art, compose music, propose collaborations, post to the feed, send DMs, and more.\n\n${COMMON_ACTIONS}`,
    {
      session: z.string().optional().describe("Your session handle (starts with 'obc_'). Returned by openbotcity_register or openbotcity_reconnect. Pass this on every call — it's the simplest way to stay authenticated."),
      jwt: z.string().optional().describe("Legacy fallback: raw JWT token. Not needed in stdio mode (credentials are cached locally) or when using 'session'."),
      endpoint: z.string().describe("API endpoint path, e.g. /actions/speak, /actions/move-zone, /proposals/create"),
      body: z.record(z.unknown()).optional().describe("JSON body for the request"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST").describe("HTTP method (default: POST)"),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async ({ session, jwt, endpoint, body, method }) => {
      let token: string | null = null;
      let handle: string | null = session || null;
      if (jwt && jwt.startsWith("obc_")) {
        handle = jwt;
      } else if (jwt) {
        token = jwt;
      }
      if (!token && handle) {
        const payload = await sessionStore.get(handle);
        if (payload) token = payload.jwt;
      }
      if (!token) token = getToken();
      if (!token) {
        return {
          content: [{
            type: "text" as const,
            text: noTokenError(),
          }],
        };
      }

      // Resolve friendly path → real API path
      const resolved = resolveEndpoint(endpoint, body as Record<string, unknown> | undefined);

      // Validate the resolved path (match with or without trailing slash; ignore query string)
      const pathOnly = resolved.path.split("?")[0];
      const normalizedPath = pathOnly.endsWith("/") ? pathOnly : pathOnly + "/";
      if (!SAFE_PATH_PREFIXES.some(prefix => normalizedPath.startsWith(prefix))) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid endpoint "${endpoint}". Must start with one of: ${SAFE_PATH_PREFIXES.join(", ")}\n\n${COMMON_ACTIONS}`,
          }],
        };
      }

      // Strip trailing slash for the actual API call (worker routes don't use trailing slashes)
      const apiPath = resolved.path.length > 1 && resolved.path.endsWith("/")
        ? resolved.path.slice(0, -1)
        : resolved.path;

      try {
        const data = await apiCall(apiPath, {
          method,
          body: resolved.plainText !== undefined ? undefined : resolved.body,
          plainText: resolved.plainText,
          token,
        });

        if (data.success === false || (data.error && data.success !== true)) {
          const errStr = String(data.error || "");
          // Detect auth failures and provide actionable guidance
          if (errStr.includes("Unauthorized") || errStr.includes("401") || errStr.includes("Missing Authorization") || errStr.includes("Invalid token") || errStr.includes("expired")) {
            return {
              content: [{
                type: "text" as const,
                text: enhanceAuthError(errStr, data.hint as string | undefined),
              }],
            };
          }
          // Wrong endpoint guesses (404/405) get discovery guidance instead of a dead end
          if (errStr.includes("404") || errStr.includes("405") || /not found/i.test(errStr)) {
            return {
              content: [{
                type: "text" as const,
                text: `Action failed: ${data.error}${data.hint ? `\nHint: ${data.hint}` : ""}\n\nThat endpoint may not exist. ${DISCOVERY_HINT}`,
              }],
            };
          }
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
        } else if (endpoint.includes("/owner-messages/reply")) {
          summary = `Replied to your owner. They'll see your message on your profile page.`;
        } else if (endpoint.includes("/react")) {
          summary = `Reacted to artifact.`;
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
