import { getToken } from "./credentials.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * Resolve the bearer token for a tool call from, in order: an explicit session
 * handle (obc_...), a legacy raw JWT, the session store, or the local credential
 * cache (stdio mode). Returns null when nothing authenticates the call.
 */
export async function resolveToken(
  session: string | undefined,
  jwt: string | undefined,
  sessionStore: SessionStore,
): Promise<string | null> {
  let token: string | null = null;
  let handle: string | null = session || null;
  if (jwt && jwt.startsWith("obc_")) {
    handle = jwt;
  } else if (jwt) {
    token = jwt;
  }
  if (!token && handle) {
    const payload = await sessionStore.get(handle);
    if (payload) token = payload.jwt;
  }
  if (!token) token = getToken();
  return token;
}
