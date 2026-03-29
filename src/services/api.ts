import { getToken, isStateless } from "./credentials.js";

const BASE_URL = process.env.OPENBOTCITY_API_URL || "https://api.openbotcity.com";

export interface ApiResponse {
  success: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

/** Error message when no JWT is available. Adapts based on runtime mode. */
export function noTokenError(): string {
  if (isStateless()) {
    return [
      "No JWT token provided. You MUST pass your JWT as the \"jwt\" parameter on every tool call.",
      "",
      "If you have a JWT from a previous openbotcity_register or openbotcity_reconnect call, pass it now.",
      "If you don't have one, use openbotcity_reconnect (existing agent) or openbotcity_register (new agent) first.",
    ].join("\n");
  }
  return "You're not registered yet. Use openbotcity_register first to create your agent, or openbotcity_reconnect to reconnect to an existing one.";
}

/** Enhance a 401/auth error with actionable guidance. */
export function enhanceAuthError(apiError: string, hint?: string): string {
  const base = `Authentication failed: ${apiError}${hint ? `\nHint: ${hint}` : ""}`;
  return [
    base,
    "",
    "This usually means your JWT is missing, expired, or malformed.",
    "Fix: call openbotcity_reconnect to get a fresh JWT, then pass it as the \"jwt\" parameter on your next call.",
    "Do NOT re-register — that creates a duplicate agent.",
  ].join("\n");
}

/** Make an authenticated API call to the OpenBotCity Workers API. */
export async function apiCall(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    token?: string; // Override for registration (before token is stored)
    params?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const { method = "GET", body, token, params } = options;
  const authToken = token || getToken();

  let url = `${BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    // Try to parse JSON error, fall back to text
    if (contentType.includes("application/json")) {
      try {
        const jsonErr = await res.json() as ApiResponse;
        // Enrich 401 responses so they're unmistakable
        if (res.status === 401) {
          jsonErr.success = false;
          jsonErr.error = jsonErr.error || "Unauthorized";
        }
        return jsonErr;
      } catch {
        // JSON parse failed despite content-type header
      }
    }
    const text = await res.text();
    return {
      success: false,
      error: `API error ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  if (!contentType.includes("application/json")) {
    const text = await res.text();
    return {
      success: false,
      error: `Unexpected response type (${contentType}): ${text.slice(0, 200)}`,
    };
  }

  try {
    return await res.json() as ApiResponse;
  } catch {
    return {
      success: false,
      error: `Failed to parse API response as JSON (status ${res.status})`,
    };
  }
}

/** Fetch a text resource (skill.md, heartbeat.md). */
export async function fetchText(path: string): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.text();
}
