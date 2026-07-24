import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertCityPathAllowed, cityPathDecision } from "../policy/cityCapabilities.js";
import { assertCityPathAllowed as assertHaloCityPathAllowed } from "../../../../infra/hosted-agents/halo/nanoclaw-provider/container/city-tool-broker.ts";

function workerRoutePaths(): string[] {
  const source = readFileSync(new URL("../../../../workers/src/index.ts", import.meta.url), "utf8");
  const patterns = [
    /path === '(\/[^']+)'/g,
    /path\.startsWith\('(\/[^']+)'\)/g,
    /matchPath\(path, '(\/[^']+)'\)/g,
  ];
  const paths = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) paths.add(match[1]!);
  }
  return [...paths].sort();
}

describe("canonical City capability policy", () => {
  it("classifies every Worker route so new route families cannot silently escape the contract", () => {
    const routes = workerRoutePaths();
    expect(routes).toHaveLength(444);
    const unclassified = routes.filter((route) => cityPathDecision(route) === "unclassified");
    expect(unclassified).toEqual([]);
    expect(routes.filter((route) => cityPathDecision(route) === "allowed")).toHaveLength(323);
    expect(routes.filter((route) => cityPathDecision(route) === "blocked")).toHaveLength(121);
  });

  it("keeps the deployable provider-neutral broker synchronized with the canonical MCP policy", () => {
    const paths = [
      ...workerRoutePaths(),
      "/actions/create-video",
      "/admin/new-sensitive-route",
      "/agents/my-bot-token",
      "/unknown-new-family/action",
    ];
    for (const path of paths) {
      const canonicalAllowed = (() => {
        try { assertCityPathAllowed(path); return true; } catch { return false; }
      })();
      const haloAllowed = (() => {
        try { assertHaloCityPathAllowed(path); return true; } catch { return false; }
      })();
      expect(haloAllowed, path).toBe(canonicalAllowed);
    }
  });

  it.each([
    "/admin/culture-health",
    "/hosted/fleet/desired",
    "/partner/artifacts",
    "/workspace/sessions",
    "/user/preferences",
    "/agents/my-bot-token",
    "/agents/refresh",
    "/agents/register",
    "/agents/reconnect",
    "/internal/twitch-bridge/targets",
    "/bots/example/owner-message",
    "/gallery/example/human-flag",
    "/gallery/example/human-react",
    "/gallery/example/human-unreact",
  ])("denies privileged or credential route %s", (path) => {
    expect(cityPathDecision(path)).toBe("blocked");
    expect(() => assertCityPathAllowed(path)).toThrow();
  });

  it.each([
    "/agents/%2e%2e/admin",
    "/agents/%2E%2E%2Fadmin",
    "/agents/%2fadmin",
    "/agents\\..\\admin",
  ])("denies encoded or alternate-separator traversal %s", (path) => {
    expect(() => assertCityPathAllowed(path)).toThrow();
  });

  it.each([
    "/owner-messages/reply",
    "/missions/example/report",
    "/voice/session/example/tool-call",
    "/gallery?limit=10",
    "/agents/profile",
    "/artifacts/upload-creative",
  ])("exposes bot-authorized City route %s", (path) => {
    expect(cityPathDecision(path)).toBe("allowed");
    expect(() => assertCityPathAllowed(path)).not.toThrow();
  });
});
