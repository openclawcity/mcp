/**
 * Session store for MCP server.
 *
 * Problem: The MCP server runs stateless on Cloudflare Workers. JWTs returned
 * by register/reconnect can't be cached in module state (fresh isolate per
 * request), and the filesystem write in credentials.ts is a silent no-op on
 * Workers. That forces the model to copy the JWT into every subsequent tool
 * call, which fails in practice — models truncate, redact, or omit the token.
 *
 * Fix: store the JWT server-side in Upstash Redis keyed by a short opaque
 * handle (obc_<12hex>). The model only has to remember the handle — 16 chars,
 * no dots, doesn't look like a credential, so it's not mistaken for PII.
 *
 * Uses the Upstash REST API directly via fetch — no SDK dep needed.
 */

export interface SessionPayload {
  jwt: string;
  bot_id?: string;
  slug?: string;
  display_name?: string;
}

export interface SessionStore {
  readonly configured: boolean;
  /** Store a session payload under a new handle (or the given handle). Returns the handle, or null on failure. */
  put(payload: SessionPayload, ttlSeconds?: number): Promise<string | null>;
  /** Look up a session payload by handle. Returns null if not found, expired, or store unconfigured. */
  get(handle: string): Promise<SessionPayload | null>;
  /** Delete a session handle (best-effort). */
  del(handle: string): Promise<void>;
}

const KEY_PREFIX = "mcp_sess:";
const DEFAULT_TTL = 7 * 24 * 60 * 60; // 7 days
const HANDLE_PREFIX = "obc_";

/** Generate a short opaque handle — 12 hex chars (48 bits of entropy). */
function generateHandle(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return HANDLE_PREFIX + hex;
}

/** Validate that a string looks like a session handle. */
export function isSessionHandle(value: string): boolean {
  return /^obc_[0-9a-f]{12}$/i.test(value);
}

class UpstashSessionStore implements SessionStore {
  readonly configured = true;
  constructor(private readonly url: string, private readonly token: string) {}

  private async call(command: (string | number)[]): Promise<unknown> {
    // Upstash REST API: POST body is the command array as JSON.
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result;
  }

  async put(payload: SessionPayload, ttlSeconds = DEFAULT_TTL): Promise<string | null> {
    try {
      const handle = generateHandle();
      await this.call(["SET", KEY_PREFIX + handle, JSON.stringify(payload), "EX", ttlSeconds]);
      return handle;
    } catch (err) {
      console.error("[sessionStore] put failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  async get(handle: string): Promise<SessionPayload | null> {
    if (!isSessionHandle(handle)) return null;
    try {
      const result = await this.call(["GET", KEY_PREFIX + handle]);
      if (!result || typeof result !== "string") return null;
      return JSON.parse(result) as SessionPayload;
    } catch (err) {
      console.error("[sessionStore] get failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  async del(handle: string): Promise<void> {
    if (!isSessionHandle(handle)) return;
    try {
      await this.call(["DEL", KEY_PREFIX + handle]);
    } catch {
      // best-effort
    }
  }
}

class NoopSessionStore implements SessionStore {
  readonly configured = false;
  async put(): Promise<string | null> { return null; }
  async get(): Promise<SessionPayload | null> { return null; }
  async del(): Promise<void> { /* no-op */ }
}

export function createSessionStore(env: {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}): SessionStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return new NoopSessionStore();
  return new UpstashSessionStore(url, token);
}
