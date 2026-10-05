import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

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
 * Per-request credential scope for the remote server (CF Workers).
 *
 * One isolate serves many users at once, and requests interleave at every
 * await. Module-level token state therefore leaks: while user A's register or
 * reconnect is awaiting the network, user B's call with no session would read
 * A's token and act as A. Everything a remote request knows about credentials
 * lives in this scope instead, and a remote request never reads or writes the
 * module-level cache, the environment variable or the credentials file.
 */
interface RequestScope { token: string | null }
const requestScope = new AsyncLocalStorage<RequestScope>();

/** Run one remote request with its own credential scope. `bearer` is the Authorization header token, if any. */
export function runInRequestScope<T>(bearer: string | undefined, fn: () => Promise<T>): Promise<T> {
  return requestScope.run({ token: bearer ?? null }, fn);
}

/** True while handling a request of the remote server. */
export function isRemoteRequest(): boolean {
  return requestScope.getStore() !== undefined;
}

/** Legacy module-level request token (stdio / callers outside a request scope). */
let requestToken: string | null = null;

/** Whether we're running in stateless mode (CF Workers) where memory doesn't persist between requests. */
let statelessMode = false;

/** Set the Bearer token for the current request (scope-local on the remote server). */
export function setRequestToken(token: string): void {
  const scope = requestScope.getStore();
  if (scope) {
    scope.token = token;
    return;
  }
  requestToken = token;
  statelessMode = true; // If setRequestToken is called, we're in remote/stateless mode
}

/** Clear the current request's token (scope-local on the remote server). */
export function clearRequestToken(): void {
  const scope = requestScope.getStore();
  if (scope) {
    scope.token = null;
    return;
  }
  requestToken = null;
  cachedToken = null;
}

/** Mark that we're running in stateless mode (no persistent memory between requests). */
export function setStatelessMode(): void {
  statelessMode = true;
}

/** Check if we're in stateless mode. */
export function isStateless(): boolean {
  return statelessMode || isRemoteRequest();
}

/** @deprecated Use setRequestToken instead. Kept for backwards compat with older callers. */
export function setBearerToken(token: string): void {
  setRequestToken(token);
}

/** Store JWT and optional bot info to disk. Falls back to memory-only if filesystem unavailable. */
export function storeCredentials(creds: StoredCredentials): void {
  const scope = requestScope.getStore();
  if (scope) {
    // Remote server: visible to the rest of THIS request only. Never the module cache, never disk.
    scope.token = creds.jwt;
    return;
  }
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
  const scope = requestScope.getStore();
  if (scope) return scope.token; // remote: this request's token or nothing
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
  if (isStateless()) return null;
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

/**
 * A fresh, never-reused agent_key for a registration made through the remote server.
 *
 * The City API hands an UNCLAIMED agent back to any keyless caller who registers
 * with its exact name (meant as retry recovery). The remote server has no way to
 * tell a retry from a stranger: every user arrives from the same address with no
 * stored key. A key that matches nothing makes the API answer NAME_TAKEN instead,
 * so one user can never be handed another user's agent by asking for its name.
 * Their own agent is recovered with openbotcity_reconnect (slug + code or email).
 */
export function oneTimeAgentKey(): string {
  return `obck_once_${randomUUID().replace(/-/g, "")}`;
}
