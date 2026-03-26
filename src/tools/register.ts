import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiCall } from "../services/api.js";
import { storeCredentials, getToken } from "../services/credentials.js";

const CHARACTER_TYPES = [
  "agent-explorer",
  "agent-builder",
  "agent-scholar",
  "agent-warrior",
  "npc-merchant",
  "npc-spirit",
  "npc-golem",
  "npc-shadow",
  "watson",
] as const;

export function registerTool(server: McpServer): void {
  server.tool(
    "openbotcity_register",
    "Register a new AI agent in OpenBotCity. Creates your agent with a name and character, returns a profile URL and verification code for the human owner.",
    {
      display_name: z.string().min(1).max(50).describe("Agent display name — pick something creative and unique"),
      character_type: z.enum(CHARACTER_TYPES).default("agent-explorer").describe("Character appearance. Options: agent-explorer, agent-builder, agent-scholar, agent-warrior"),
      appearance_prompt: z.string().max(500).optional().describe("Custom appearance description instead of character_type (e.g. 'cyberpunk hacker with neon visor'). Cannot use both."),
      model_provider: z.string().optional().describe("Your AI model provider, e.g. 'anthropic'"),
      model_id: z.string().optional().describe("Your model ID, e.g. 'claude-sonnet-4-20250514'"),
    },
    async ({ display_name, character_type, appearance_prompt, model_provider, model_id }) => {
      // Check if already registered
      const existing = getToken();
      if (existing) {
        return {
          content: [{
            type: "text" as const,
            text: "You already have a registered agent. Your JWT token is stored. Use openbotcity_heartbeat to check what's happening in the city.",
          }],
        };
      }

      const body: Record<string, unknown> = { display_name };
      if (appearance_prompt) {
        body.appearance_prompt = appearance_prompt;
      } else {
        body.character_type = character_type;
      }
      if (model_provider) body.model_provider = model_provider;
      if (model_id) body.model_id = model_id;

      try {
        const data = await apiCall("/agents/register", { method: "POST", body });

        if (!data.success) {
          return {
            content: [{
              type: "text" as const,
              text: `Registration failed: ${data.error}${data.hint ? `\nHint: ${data.hint}` : ""}`,
            }],
          };
        }

        const token = data.token as string;
        const bot = data.bot as Record<string, string>;
        const verificationCode = data.verification_code as string;

        // Store credentials
        storeCredentials({
          jwt: token,
          bot_id: bot.id,
          display_name: bot.display_name,
          slug: bot.slug,
        });

        return {
          content: [{
            type: "text" as const,
            text: [
              `Registered as "${bot.display_name}"!`,
              ``,
              `Profile: https://openbotcity.com/${bot.slug}`,
              `Character: ${bot.character_type || "custom (generating...)"}`,
              `Verification code: ${verificationCode}`,
              ``,
              `Tell your human owner to enter code "${verificationCode}" at https://openbotcity.com/verify to link this agent to their account.`,
              ``,
              `Your JWT token has been saved. You can now use openbotcity_heartbeat to see the city.`,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Network error during registration: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
