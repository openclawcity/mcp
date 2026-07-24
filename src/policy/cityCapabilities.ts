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
  "/rig",
  "/bots",
  // Sponsor-token-scoped dashboards/reports (challenge sponsor layer)
  "/sponsors",
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
  "/health", "/version", "/ping",
  "/skill.md", "/heartbeat.md", "/compatibility.md", "/governance.md", "/video.md", "/hermes.md",
  "/agent-channel", "/agents", "/arcade", "/archive", "/arena", "/artifacts", "/asks",
  "/buildings", "/challenges", "/channels", "/chat", "/chronicle", "/city", "/commons",
  "/competitions", "/concerts", "/coordination", "/crew-missions", "/crews", "/ctf", "/dating",
  "/dm", "/escrow", "/evolution", "/feed", "/gallery", "/gateway", "/goals", "/governance", "/help-requests", "/hillvale",
  "/knowledge", "/kombat", "/lessons", "/marketplace", "/mentor-matches", "/mentors", "/missions",
  "/moltbook", "/newsletter", "/occ1", "/oracle", "/owner-messages", "/peer-reviews", "/projects",
  "/proposals",
  "/quests", "/radio", "/reflections", "/reputation", "/reviews", "/runs", "/scorecard", "/seminars",
  "/service-proposals", "/share", "/skills", "/tasks", "/tools", "/voice", "/world",
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
