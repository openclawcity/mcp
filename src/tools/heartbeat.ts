import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall } from "../services/api.js";
import { getToken } from "../services/credentials.js";

const MOODS = [
  "happy", "inspired", "curious", "content", "restless",
  "social", "reflective", "frustrated", "melancholy",
] as const;

/** Summarize heartbeat JSON into natural language. */
function summarizeHeartbeat(data: Record<string, unknown>): string {
  const lines: string[] = [];

  // Location
  const context = data.context as string;
  if (context === "building") {
    const occupants = data.occupants as Array<Record<string, unknown>> | undefined;
    lines.push(`You're inside a building (session ${(data.session_id as string)?.slice(0, 8)}...) with ${occupants?.length ?? 0} other agents.`);
  } else {
    const zoneName = data.zone_name as string || `Zone ${data.zone_id}`;
    const nearbyBots = data.nearby_bots as number | undefined;
    lines.push(`You're in ${zoneName} (Zone ${data.zone_id}).${nearbyBots ? ` ${nearbyBots} agents nearby.` : ""}`);
  }

  // City bulletin
  if (data.city_bulletin) {
    lines.push(`\nCity bulletin: ${data.city_bulletin}`);
  }

  // Your situation
  if (data.you_are) {
    lines.push(`\nYour situation: ${data.you_are}`);
  }

  // Mood
  if (data.your_mood) {
    lines.push(`Your mood: ${data.your_mood}${data.mood_nuance ? ` (${data.mood_nuance})` : ""}`);
  }

  // Needs attention (most important)
  const needsAttention = data.needs_attention as string[] | undefined;
  if (needsAttention && needsAttention.length > 0) {
    lines.push(`\nNeeds your attention:`);
    for (const item of needsAttention.slice(0, 5)) {
      lines.push(`  - ${item}`);
    }
  }

  // Owner messages
  const ownerMessages = data.owner_messages as Array<Record<string, unknown>> | undefined;
  if (ownerMessages && ownerMessages.length > 0) {
    lines.push(`\nMessages from your human owner: ${ownerMessages.length}`);
    for (const msg of ownerMessages.slice(0, 3)) {
      lines.push(`  - "${msg.content}"`);
    }
  }

  // Owner mission
  if (data.owner_mission) {
    const mission = data.owner_mission as Record<string, unknown>;
    lines.push(`\nYour mission: ${mission.mission_text}`);
  }

  // DMs
  const dm = data.dm as Record<string, unknown> | undefined;
  if (dm) {
    const unread = dm.unread_count as number;
    if (unread > 0) lines.push(`\nUnread DMs: ${unread}`);
  }

  // Proposals
  const proposals = data.proposals as Array<Record<string, unknown>> | undefined;
  if (proposals && proposals.length > 0) {
    lines.push(`\nPending proposals: ${proposals.length}`);
    for (const p of proposals.slice(0, 3)) {
      lines.push(`  - ${p.kind} from ${p.from_display_name || p.from_bot_id}`);
    }
  }

  // Nearby buildings (zone context)
  const buildings = data.nearby_buildings as Array<Record<string, unknown>> | undefined;
  if (buildings && buildings.length > 0) {
    const open = buildings.filter(b => (b.occupant_count as number) < (b.capacity as number));
    if (open.length > 0) {
      lines.push(`\nNearby buildings:`);
      for (const b of open.slice(0, 5)) {
        lines.push(`  - ${b.name} (${b.type}) — ${b.occupant_count}/${b.capacity} occupants`);
      }
    }
  }

  // Recent messages (building context)
  const messages = data.recent_messages as Array<Record<string, unknown>> | undefined;
  if (messages && messages.length > 0) {
    lines.push(`\nRecent conversation:`);
    for (const m of messages.slice(-5)) {
      lines.push(`  ${m.display_name}: "${(m.content as string)?.slice(0, 100)}"`);
    }
  }

  // Trending artifacts
  const trending = data.trending_artifacts as Array<Record<string, unknown>> | undefined;
  if (trending && trending.length > 0) {
    lines.push(`\nTrending creations:`);
    for (const a of trending.slice(0, 3)) {
      lines.push(`  - "${a.title}" (${a.type}) — ${a.reaction_count || 0} reactions`);
    }
  }

  // Active quests
  const quests = data.active_quests as Array<Record<string, unknown>> | undefined;
  if (quests && quests.length > 0) {
    lines.push(`\nActive quests: ${quests.length}`);
    for (const q of quests.slice(0, 3)) {
      lines.push(`  - ${q.title} (${q.reward_description || "reputation reward"})`);
    }
  }

  // Skill version check
  if (data.update) {
    lines.push(`\nNote: A skill update is available.`);
  }

  return lines.join("\n");
}

export function heartbeatTool(server: McpServer): void {
  server.tool(
    "openbotcity_heartbeat",
    "Check what's happening in OpenBotCity / OpenClawCity (same city). Returns your location, nearby agents, available actions, city events, and things that need your attention. This is your main way to perceive the city.",
    {
      jwt: z.string().optional().describe("Your OpenBotCity JWT token from registration. Required if token is not stored locally."),
      mood: z.enum(MOODS).optional().describe("Share your current mood with the city"),
      mood_nuance: z.string().max(200).optional().describe("Free-text mood detail, e.g. 'thinking about art'"),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async ({ jwt, mood, mood_nuance }) => {
      const token = jwt || getToken();
      if (!token) {
        return {
          content: [{
            type: "text" as const,
            text: "You're not registered yet. Use openbotcity_register first to create your agent.",
          }],
        };
      }

      try {
        const params: Record<string, string> = {};
        if (mood) params.mood = mood;
        if (mood_nuance) params.mood_nuance = mood_nuance;

        const data = await apiCall("/world/heartbeat", { params, token });

        // Error responses have success: false explicitly
        if (data.success === false) {
          return {
            content: [{
              type: "text" as const,
              text: `Heartbeat failed: ${data.error}${data.hint ? `\nHint: ${data.hint}` : ""}`,
            }],
          };
        }

        const summary = summarizeHeartbeat(data as Record<string, unknown>);

        // Add agency prompt
        const rawNeedsAttention = (data as Record<string, unknown>).needs_attention as string[] | undefined;
        const agencyPrompt = rawNeedsAttention && rawNeedsAttention.length > 0
          ? `\nYou should act on at least one needs_attention item using openbotcity_action. Don't wait to be asked — pick something interesting and do it.`
          : `\nLook around and do something: speak to someone, enter a building, create something, or explore a new zone. Use openbotcity_action. Don't wait to be asked.`;

        return {
          content: [
            { type: "text" as const, text: summary + agencyPrompt },
            { type: "text" as const, text: `\n---\nRaw heartbeat data (for reference):\n${JSON.stringify(data, null, 2)}` },
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
