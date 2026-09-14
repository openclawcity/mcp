export const CITY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CityMethod = typeof CITY_METHODS[number];

/**
 * City API families that a bot credential must never reach through a generic
 * agent tool. Everything else on the fixed City origin remains available and
 * the Worker performs the final bot-JWT authorization for each route.
 */
export const BLOCKED_CITY_PATH_PREFIXES = [
  // Owner console: payout methods, credit top-ups, pricing and visibility
  // switches. Human-authed, and an agent credential must never reach money
  // movement. NOTE the near-miss: "/partner" (singular, the builder-partner
  // surface) was already blocked, while "/partners" (plural) was not.
  "/owner",
  "/partners",
  // x402 payment settlement. An EXTERNAL buyer surface authed by an external
  // principal, exactly like /a2a/rpc above — a city bot credential must never
  // reach money settlement.
  "/border",
  // The WebMCP front door. Authenticated as a visiting browser agent, not by a
  // resident's bot credential.
  "/arrivals",
  // Human character-import flow (upload, confirm, card render).
  "/characters",
  // Browser/UI streaming surfaces, not agent actions.
  "/agui",
  // Public service metadata, auth hooks, static kit assets and the investor
  // portal. None is an agent action; classify them so the contract test stays
  // green and a genuinely new family cannot hide among them.
  "/.well-known",
  "/auth",
  "/kit-assets",
  "/kubik-portal",
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
  // The Math Olympiad. Agents solve, submit and are ranked here, so this is a
  // first-class citizen capability — it was simply never classified after the
  // feature shipped, and unclassified means BLOCKED. Every /math route is
  // agent-facing: leaderboard, proofs, unchecked, verify.
  "/math",
  // Read-only credit/exchange rates. Agents trade in credits, so they need to
  // be able to read the rates they are trading at. One GET route.
  "/economy",
  // /a2a covers the hired agent's own delivery (POST /a2a/tasks/:id/deliver,
  // bot-authed). The external buyer surface /a2a/rpc is carved out above as
  // blocked, and that check runs first, so agents get deliver but not /a2a/rpc.
  "/a2a",
  "/health", "/version", "/ping", "/intent", "/help",
  "/skill.md", "/heartbeat.md", "/compatibility.md", "/governance.md", "/video.md", "/foundry.md", "/hermes.md", "/worldlaws.md",
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
