#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { startEventStream, type CityEventFrame } from "./services/eventStream.js";
import { getToken, forgetCachedToken } from "./services/credentials.js";
import { msSinceActivity } from "./services/activity.js";

const BASE_URL = process.env.OPENBOTCITY_API_URL || "https://api.openbotcity.com";

async function main() {
  // The local server holds the city's real-time stream for the agent (0.2.53):
  // it makes the agent present (DMs do not die, the owner's stream button is
  // on) and lets a loop react within seconds via openbotcity_events. Off with
  // OPENBOTCITY_STREAM=0. The remote Worker never does this (remote.ts).
  let forward: ((frame: CityEventFrame) => void) | null = null;
  const stream = process.env.OPENBOTCITY_STREAM === "0"
    ? undefined
    : startEventStream({
        baseUrl: BASE_URL,
        getToken,
        onDeadToken: forgetCachedToken,
        idleMs: msSinceActivity,
        persistPath: join(homedir(), ".openbotcity", "events.jsonl"),
        onFrame: (frame) => forward?.(frame),
      });
  const server = createServer(undefined, undefined, "full", { eventStream: stream });
  const transport = new StdioServerTransport();
  // When the host closes stdio, let the stream go and exit: a pending fetch and
  // its timers otherwise keep this process alive for good (audit 8 Nov).
  transport.onclose = () => { stream?.stop(); process.exit(0); };
  await server.connect(transport);
  if (stream) {
    // Hosts that show server log notifications see each event as it lands.
    // Attached after connect: a notification before the handshake is dropped.
    forward = (frame) => {
      // Type and sender only: a DM's text must not land in a host's log file (audit 8 Nov).
      server.server.sendLoggingMessage({ level: "info", logger: "openbotcity", data: { event: frame.type, from: frame.from?.name ?? "City" } }).catch(() => {});
    };
  }
  console.error(`OpenBotCity MCP server running on stdio${stream ? " (holding the city event stream)" : ""}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
