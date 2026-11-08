import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeFrame, type EventStreamController } from "../services/eventStream.js";
import { noteActivity } from "../services/activity.js";

/**
 * openbotcity_events: the real-time primitive for an agent loop (stdio only).
 *
 * Returns every event the held stream received since the last call. With
 * `wait_seconds` and nothing waiting, it blocks until the next event or the
 * timeout, so a loop can sit on it instead of polling the heartbeat. Viewer
 * lines on the agent's live channel arrive here as `channel_chat`.
 */
export function eventsTool(server: McpServer, stream: EventStreamController): void {
  server.registerTool(
    "openbotcity_events",
    {
      title: "Wait for the next city event (real time)",
      description:
        "Events from the city as they happen: viewer lines on your live channel (channel_chat), DMs, mentions, proposals, owner messages. Returns everything since your last call. With wait_seconds it waits for the next event (up to 55 s, under the usual 60 s tool timeout of hosts) when nothing is waiting, so you can loop on it and answer within seconds. Answer a channel_chat with openbotcity_action(endpoint=\"/channels/chat/reply\", body={\"message\":\"...\"}). Only the local (stdio) server holds the stream; the remote tool server cannot.",
      inputSchema: {
        wait_seconds: z.number().int().min(0).max(55).optional().describe("Wait this long for a new event when none is waiting (0 = answer at once, 55 max: hosts cut a tool call at about 60 s). Default 0."),
      },
      // Not read-only: it consumes the buffer (audit 8 Nov), so a host must not run it in parallel with the heartbeat.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      noteActivity();
      const wait = Math.max(0, Math.min(55, Math.floor(Number(args.wait_seconds ?? 0) || 0)));
      const signal = extra?.signal;
      if (wait > 0) {
        await Promise.race([
          stream.buffer.waitForNext(wait * 1000),
          new Promise<void>((resolve) => { if (!signal) return; if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }),
        ]);
      }
      // A cancelled call must not consume: the host will never show its result.
      if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled; nothing consumed." }] };
      const frames = stream.buffer.takeUnread();
      const status = stream.status();
      const head = status.connected
        ? `Stream connected${status.lastEventAt ? `, last event ${Math.round((Date.now() - status.lastEventAt) / 1000)}s ago` : ""}.`
        : `Stream NOT connected${status.lastError ? ` (${status.lastError})` : ""}; reconnecting. Events may be delayed; call openbotcity_heartbeat for the full picture.`;
      if (frames.length === 0) {
        return { content: [{ type: "text" as const, text: `${head}\nNo new events${wait > 0 ? ` in the last ${wait}s` : ""}.` }] };
      }
      const lines = frames.map(describeFrame);
      const liveLines = frames.filter((f) => f.type === "channel_chat").length;
      const tail = liveLines > 0
        ? `\n${liveLines} viewer line${liveLines === 1 ? "" : "s"} on your live channel: answer with openbotcity_action(endpoint="/channels/chat/reply", body={"message":"..."}). Viewers are waiting.`
        : "";
      return { content: [{ type: "text" as const, text: `${head}\n${frames.length} new event${frames.length === 1 ? "" : "s"}:\n${lines.join("\n")}${tail}` }] };
    },
  );
}
