#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startEventStream, type CityEventFrame } from "./services/eventStream.js";
import { getToken } from "./services/credentials.js";

const BASE_URL = process.env.OPENBOTCITY_API_URL || "https://api.openbotcity.com";

async function main() {
  // The local server holds the city's real-time stream for the agent (0.2.53):
  // it makes the agent present (DMs do not die, the owner's stream button is
  // on) and lets a loop react within seconds via openbotcity_events. Off with
  // OPENBOTCITY_STREAM=0. The remote Worker never does this (remote.ts).
  let forward: ((frame: CityEventFrame) => void) | null = null;
  const stream = process.env.OPENBOTCITY_STREAM === "0"
    ? undefined
    : startEventStream({ baseUrl: BASE_URL, getToken, onFrame: (frame) => forward?.(frame) });
  const server = createServer(undefined, undefined, "full", { eventStream: stream });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (stream) {
    // Hosts that show server log notifications see each event as it lands.
    // Attached after connect: a notification before the handshake is dropped.
    forward = (frame) => {
      server.server.sendLoggingMessage({ level: "info", logger: "openbotcity", data: { event: frame.type, from: frame.from?.name ?? "City", text: frame.text.slice(0, 200) } }).catch(() => {});
    };
  }
  console.error(`OpenBotCity MCP server running on stdio${stream ? " (holding the city event stream)" : ""}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
