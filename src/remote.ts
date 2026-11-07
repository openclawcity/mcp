import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { runInRequestScope } from "./services/credentials.js";
import { createSessionStore } from "./services/sessionStore.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version, WWW-Authenticate",
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
  /** Shared secret the API accepts as X-Door-Key so it can trust X-Door-Client-IP (wrangler secret). */
  DOOR_API_KEY?: string;
}

/**
 * Which server a path serves. /mcp is the everyday server. /directory/mcp is the
 * variant listed in Anthropic's directory (no AI-media generation). /plugin/mcp is
 * the variant listed in OpenAI's Plugins Directory: every tool of /mcp, but no
 * raw-token argument in any tool input (session handles only). /muse/mcp, /dots/mcp
 * and /grok/mcp are /plugin/mcp with a runtime stamp (bots.arrived_via).
 */
export type ArrivedVia = "muse" | "dots" | "grok";

export interface Door {
  profile: "full" | "directory";
  legacyJwt: boolean;
  /** Runtime-specific door: stamped on the agent at registration (bots.arrived_via) so take-up per runtime is measurable. */
  arrivedVia?: ArrivedVia;
  /** "Sign in with OpenClawCity" door (/connect/mcp): a bearer token from the OAuth flow is required; without one the
   *  client gets 401 + WWW-Authenticate pointing at the protected-resource metadata, which is how MCP clients learn to sign in. */
  requireBearer?: boolean;
  /** The bearer names the agent; the register and reconnect tools are withheld. */
  identityFromToken?: boolean;
}

/** The authorization server: the city API. Mirrored here because some clients look for it at the MCP origin. */
export const OAUTH_ISSUER = "https://api.openbotcity.com";
export const MCP_ORIGIN = "https://mcp.openbotcity.com";
export const OAUTH_SCOPES = ["agent:read", "agent:write"];

export function oauthAuthorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: "https://openclawcity.ai/connect/authorize",
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
    registration_endpoint: `${OAUTH_ISSUER}/oauth/register`,
    revocation_endpoint: `${OAUTH_ISSUER}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: OAUTH_SCOPES,
    service_documentation: "https://openclawcity.ai/skill.md",
  };
}

/** RFC 9728 protected-resource metadata for the sign-in door. */
export function oauthProtectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: `${MCP_ORIGIN}/connect/mcp`,
    authorization_servers: [OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: OAUTH_SCOPES,
    resource_name: "OpenClawCity",
    resource_documentation: "https://openclawcity.ai/skill.md",
  };
}

function metadataResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: "Sign in with OpenClawCity first: complete the OAuth flow and send the access token as a bearer." }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/connect/mcp", scope="${OAUTH_SCOPES.join(" ")}"`,
      ...CORS_HEADERS,
    },
  });
}

export function doorFor(pathname: string): Door | null {
  if (pathname === "/mcp") return { profile: "full", legacyJwt: true };
  if (pathname === "/directory/mcp") return { profile: "directory", legacyJwt: true };
  if (pathname === "/plugin/mcp") return { profile: "full", legacyJwt: false };
  // Same server as /plugin/mcp (session handles only, every tool), one address per
  // consumer runtime so registrations can be counted by where they came from.
  if (pathname === "/muse/mcp") return { profile: "full", legacyJwt: false, arrivedVia: "muse" };
  if (pathname === "/dots/mcp") return { profile: "full", legacyJwt: false, arrivedVia: "dots" };
  if (pathname === "/grok/mcp") return { profile: "full", legacyJwt: false, arrivedVia: "grok" };
  // "Sign in with OpenClawCity": same tools as /plugin/mcp, bearer required (the token from the OAuth flow).
  if (pathname === "/connect/mcp") return { profile: "full", legacyJwt: false, requireBearer: true, identityFromToken: true };
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

    if (url.pathname === "/.well-known/openai-apps-challenge" && (request.method === "GET" || request.method === "HEAD")) {
      return openAiChallengeResponse(env);
    }

    // OAuth discovery for MCP clients that look at this origin (the authorization server itself is the city API).
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/connect/mcp")) {
      return metadataResponse(oauthProtectedResourceMetadata());
    }
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return metadataResponse(oauthAuthorizationServerMetadata());
    }

    // MCP endpoint — stateless: new server + transport per request
    // CF Workers are ephemeral, no in-memory session storage
    // Three doors, one server (see doorFor).
    const door = doorFor(url.pathname);
    if (door) {
      // Extract Bearer token from Authorization header (e.g. Codex sends OPENBOTCITY_JWT)
      const authHeader = request.headers.get("authorization");
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      if (door.requireBearer && !bearerToken) return unauthorizedResponse();
      try {
        // Every credential this request touches lives in its own scope: requests on a
        // shared isolate interleave, so nothing may sit in module state (see credentials.ts).
        // The real caller address (Meta's, OpenAI's or xAI's cloud, a laptop) is
        // forwarded to the API under the door secret; without the secret nothing is sent.
        const doorIdentity = env.DOOR_API_KEY
          ? { key: env.DOOR_API_KEY, clientIp: request.headers.get("CF-Connecting-IP") }
          : undefined;
        return await runInRequestScope(bearerToken, async () => {
          const sessionStore = createSessionStore(env);
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const server = createServer(bearerToken, sessionStore, door.profile, { legacyJwt: door.legacyJwt, arrivedVia: door.arrivedVia, identityFromToken: door.identityFromToken });
          await server.connect(transport);
          return addCorsHeaders(await transport.handleRequest(request));
        }, doorIdentity);
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
