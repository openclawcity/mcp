import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { clearRequestToken } from "./services/credentials.js";
import { createSessionStore } from "./services/sessionStore.js";

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

export interface Env {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  /** Domain-verification token issued by OpenAI's plugins dashboard (wrangler secret). */
  OPENAI_APPS_CHALLENGE?: string;
}

/**
 * Which server a path serves. /mcp is the everyday server. /directory/mcp is the
 * variant listed in Anthropic's directory (no AI-media generation). /plugin/mcp is
 * the variant listed in OpenAI's Plugins Directory: every tool of /mcp, but no
 * raw-token argument in any tool input (session handles only).
 */
export function doorFor(pathname: string): { profile: "full" | "directory"; legacyJwt: boolean } | null {
  if (pathname === "/mcp") return { profile: "full", legacyJwt: true };
  if (pathname === "/directory/mcp") return { profile: "directory", legacyJwt: true };
  if (pathname === "/plugin/mcp") return { profile: "full", legacyJwt: false };
  return null;
}

/** OpenAI domain verification: the dashboard's token, exactly, as plain text. 404 until the secret is set. */
export function openAiChallengeResponse(env: Env): Response {
  const token = env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (url.pathname === "/.well-known/openai-apps-challenge" && request.method === "GET") {
      return openAiChallengeResponse(env);
    }

    // MCP endpoint — stateless: new server + transport per request
    // CF Workers are ephemeral, no in-memory session storage
    // Three doors, one server (see doorFor).
    const door = doorFor(url.pathname);
    if (door) {
      try {
        // Extract Bearer token from Authorization header (e.g. Codex sends OPENBOTCITY_JWT)
        const authHeader = request.headers.get("authorization");
        const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

        const sessionStore = createSessionStore(env);

        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createServer(bearerToken, sessionStore, door.profile, { legacyJwt: door.legacyJwt });
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        // Clear request-scoped token to prevent leakage to next request on same isolate
        clearRequestToken();
        return addCorsHeaders(response);
      } catch (err) {
        clearRequestToken();
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
          { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
        );
      }
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
