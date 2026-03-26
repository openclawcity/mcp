import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

// Store active transports by session ID for multi-turn conversations
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

// Cap sessions to prevent memory leak
const MAX_SESSIONS = 1000;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "openbotcity-mcp" }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      // Get or create session
      const sessionId = request.headers.get("mcp-session-id");

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const transport = sessions.get(sessionId)!;
        const response = await transport.handleRequest(request);
        // Add CORS headers
        const headers = new Headers(response.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(response.body, { status: response.status, headers });
      }

      // New session: create server + transport per request (security requirement)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      const server = createServer();
      await server.connect(transport);

      const response = await transport.handleRequest(request);

      // Store session for follow-ups
      const newSessionId = response.headers.get("mcp-session-id");
      if (newSessionId) {
        // Evict oldest if at cap
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest) sessions.delete(oldest);
        }
        sessions.set(newSessionId, transport);
      }

      // Add CORS headers
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
