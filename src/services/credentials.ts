import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CRED_DIR = join(homedir(), ".openbotcity");
const CRED_FILE = join(CRED_DIR, "credentials.json");

interface StoredCredentials {
  jwt: string;
  bot_id?: string;
  display_name?: string;
  slug?: string;
}

let cachedToken: string | null = null;

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

/** Get JWT token. Priority: memory cache > env var > file. */
export function getToken(): string | null {
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

/** Get stored bot info (if available). */
export function getStoredBotInfo(): Omit<StoredCredentials, "jwt"> | null {
  try {
    const data: StoredCredentials = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    return { bot_id: data.bot_id, display_name: data.display_name, slug: data.slug };
  } catch {
    return null;
  }
}
