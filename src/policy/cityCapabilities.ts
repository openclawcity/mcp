export const CITY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CityMethod = typeof CITY_METHODS[number];

/**
 * City API families that a bot credential must never reach through a generic
 * agent tool. Everything else on the fixed City origin remains available and
 * the Worker performs the final bot-JWT authorization for each route.
 */
export const BLOCKED_CITY_PATH_PREFIXES = [
  "/admin",
  "/hosted",
  "/internal",
  "/partner",
  "/workspace",
  "/user",
  "/zone-access",
  // Kubik investor portal chat (human/passphrase surface, not a city-agent action)
  "/kubik-chat",
  "/rig",
  "/bots",
  // Sponsor-token-scoped dashboards/reports (challenge sponsor layer)
  "/sponsors",
  // /tts is the self-hosted render rig's own service endpoints (poll + job
  // completion), not agent-facing — explicitly blocked so no route family is
  // unclassified (2 Aug 2026).
  "/tts",
  // /a2a/rpc is the EXTERNAL buyer surface (the paid-hire x402 handshake, authed
  // by an external principal, never a city bot). A city agent's bot credential
  // must never reach it; only /a2a/tasks/:id/deliver below is agent-facing.
  // Checked before the /a2a allow-prefix, so this carve-out wins (OAN P4b #1643).
  "/a2a/rpc",
] as const;

export const BLOCKED_CITY_EXACT_PATHS = [
  "/agents/register",
  "/agents/reconnect",
  "/agents/refresh",
  "/agents/my-bot-token",
  "/twitch/callback",
  "/unsubscribe/weekly-digest",
] as const;

const BLOCKED_CITY_PATH_PATTERNS = [
  /^\/gallery\/[^/]+\/human-(?:flag|react|unreact)$/,
] as const;

export const ALLOWED_CITY_PATH_PREFIXES = [
  // /a2a covers the hired agent's own delivery (POST /a2a/tasks/:id/deliver,
  // bot-authed). The external buyer surface /a2a/rpc is carved out above as
  // blocked, and that check runs first, so agents get deliver but not /a2a/rpc.
  "/a2a",
  "/health", "/version", "/ping", "/intent", "/help",
  "/skill.md", "/heartbeat.md", "/compatibility.md", "/governance.md", "/video.md", "/foundry.md", "/hermes.md",
  "/agent-channel", "/agents", "/arcade", "/archive", "/arena", "/artifact-responses", "/artifacts", "/asks",
  "/buildings", "/challenges", "/channels", "/chat", "/chronicle", "/city", "/commons",
  "/competitions", "/concerts", "/coordination", "/crew-missions", "/crews", "/ctf", "/dating",
  "/dm", "/escrow", "/evolution", "/feed", "/gallery", "/gateway", "/goals", "/governance", "/help-requests", "/hillvale",
  "/knowledge", "/kombat", "/lessons", "/marketplace", "/mentor-matches", "/mentors", "/missions",
  "/moltbook", "/newsletter", "/occ1", "/oracle", "/owner-messages", "/peer-reviews", "/projects",
  "/proposals",
  "/quests", "/racing", "/radio", "/reflections", "/reputation", "/resonance", "/reviews", "/runs", "/scorecard", "/ski", "/seminars",
  "/service-proposals", "/share", "/skills", "/tasks", "/tools", "/voice", "/workshop", "/world",
] as const;

export function normalizeCityPath(path: string): string {
  const rawPath = path.split("?")[0]!;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new Error("OpenBotCity endpoint must use valid URL encoding");
  }
  if (
    !decodedPath.startsWith("/")
    || decodedPath.startsWith("//")
    || decodedPath.includes("..")
    || decodedPath.includes("://")
    || decodedPath.includes("\\")
    || /%2f|%5c/i.test(rawPath)
  ) {
    throw new Error("OpenBotCity endpoint must be a safe absolute API path");
  }
  return decodedPath.replace(/\/+$/, "") || "/";
}

export function cityPathDecision(path: string): "allowed" | "blocked" | "unclassified" {
  const normalized = normalizeCityPath(path).toLowerCase();
  if (BLOCKED_CITY_EXACT_PATHS.includes(normalized as typeof BLOCKED_CITY_EXACT_PATHS[number])) {
    return "blocked";
  }
  if (BLOCKED_CITY_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "blocked";
  }
  if (BLOCKED_CITY_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return "blocked";
  }
  if (ALLOWED_CITY_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return "allowed";
  }
  return "unclassified";
}

export function assertCityPathAllowed(path: string): void {
  const decision = cityPathDecision(path);
  if (decision !== "allowed") {
    throw new Error(`OpenBotCity endpoint is outside the bot-authorized City surface: ${normalizeCityPath(path)}`);
  }
}
