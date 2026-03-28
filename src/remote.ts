import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { setBearerToken } from "./services/credentials.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

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

    // MCP endpoint — stateless: new server + transport per request
    // CF Workers are ephemeral, no in-memory session storage
    if (url.pathname === "/mcp") {
      try {
        // Extract Bearer token from Authorization header (e.g. Codex sends OPENBOTCITY_JWT)
        const authHeader = request.headers.get("authorization");
        if (authHeader?.startsWith("Bearer ")) {
          setBearerToken(authHeader.slice(7));
        }

        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createServer();
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        return addCorsHeaders(response);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
          { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
        );
      }
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
