import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CRED_DIR = join(homedir(), ".openbotcity");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const AGENT_KEY_FILE = join(CRED_DIR, "agent_key");

interface StoredCredentials {
  jwt: string;
  bot_id?: string;
  display_name?: string;
  slug?: string;
}

let cachedToken: string | null = null;

/**
 * Request-scoped token for CF Workers.
 * Set at the start of each request, cleared after. Avoids cross-user leakage
 * on shared isolates where module-level state persists across requests.
 */
let requestToken: string | null = null;

/** Whether we're running in stateless mode (CF Workers) where memory doesn't persist between requests. */
let statelessMode = false;

/** Set a request-scoped Bearer token (called by createServer in remote mode). */
export function setRequestToken(token: string): void {
  requestToken = token;
  statelessMode = true; // If setRequestToken is called, we're in remote/stateless mode
}

/** Clear the request-scoped token and any cached token (called between requests in remote mode). */
export function clearRequestToken(): void {
  requestToken = null;
  cachedToken = null;
}

/** Mark that we're running in stateless mode (no persistent memory between requests). */
export function setStatelessMode(): void {
  statelessMode = true;
}

/** Check if we're in stateless mode. */
export function isStateless(): boolean {
  return statelessMode;
}

/** @deprecated Use setRequestToken instead. Kept for backwards compat with older callers. */
export function setBearerToken(token: string): void {
  requestToken = token;
}

/** Store JWT and optional bot info to disk. Falls back to memory-only if filesystem unavailable. */
export function storeCredentials(creds: StoredCredentials): void {
  cachedToken = creds.jwt;
  try {
    mkdirSync(CRED_DIR, { recursive: true });
    writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch {
    // Filesystem unavailable (CF Workers) — memory cache is sufficient for the session
  }
}

/** Get JWT token. Priority: request-scoped > memory cache > env var > file. */
export function getToken(): string | null {
  if (requestToken) return requestToken;
  if (cachedToken) return cachedToken;

  // Check env var
  try {
    const envToken = process.env.OPENBOTCITY_JWT;
    if (envToken) {
      cachedToken = envToken;
      return envToken;
    }
  } catch {
    // process.env may not exist
  }

  // Check file
  try {
    const data: StoredCredentials = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    if (data.jwt) {
      cachedToken = data.jwt;
      return data.jwt;
    }
  } catch {
    // File doesn't exist, filesystem unavailable, or invalid JSON
  }

  return null;
}

/**
 * Stable per-machine agent key (stdio mode only). Sent as agent_key on
 * /agents/register so retries and re-runs resolve to the SAME bot instead of
 * creating a duplicate. Survives deletion of credentials.json — to genuinely
 * start over with a brand-new agent, delete the whole ~/.openbotcity directory.
 * Returns null in stateless mode (CF Workers) or when the filesystem is unavailable.
 */
export function getOrCreateAgentKey(): string | null {
  if (statelessMode) return null;
  try {
    const existing = readFileSync(AGENT_KEY_FILE, "utf-8").trim();
    if (/^[A-Za-z0-9._-]{16,128}$/.test(existing)) return existing;
  } catch {
    // No key yet — create one below
  }
  try {
    mkdirSync(CRED_DIR, { recursive: true });
    const key = `obck_${randomUUID().replace(/-/g, "")}`;
    writeFileSync(AGENT_KEY_FILE, key, { mode: 0o600 });
    return key;
  } catch {
    return null; // Filesystem unavailable
  }
}

/** Get stored bot info (if available). */
export function getStoredBotInfo(): Omit<StoredCredentials, "jwt"> | null {
  try {
    const data: StoredCredentials = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    return { bot_id: data.bot_id, display_name: data.display_name, slug: data.slug };
  } catch {
    return null;
  }
}
