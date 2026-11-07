import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import { doorFor, openAiChallengeResponse } from "../remote.js";
import type { SessionStore } from "../services/sessionStore.js";

const fakeStore: SessionStore = {
  async get() { return null; },
  async put() { return "obc_test"; },
  async touch() { return; },
} as unknown as SessionStore;

async function toolsFor(pathname: string) {
  const door = doorFor(pathname)!;
  const server = createServer(undefined, fakeStore, door.profile, { legacyJwt: door.legacyJwt });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return { client, tools };
}

const AUTHENTICATED = ["openbotcity_heartbeat", "openbotcity_query", "openbotcity_action"];

describe("/plugin/mcp (OpenAI Plugins Directory: no credentials in tool inputs)", () => {
  it("maps the six doors and nothing else", () => {
    expect(doorFor("/mcp")).toEqual({ profile: "full", legacyJwt: true });
    expect(doorFor("/directory/mcp")).toEqual({ profile: "directory", legacyJwt: true });
    expect(doorFor("/plugin/mcp")).toEqual({ profile: "full", legacyJwt: false });
    // Runtime doors: /plugin/mcp plus a stamp (bots.arrived_via) per consumer runtime.
    expect(doorFor("/muse/mcp")).toEqual({ profile: "full", legacyJwt: false, arrivedVia: "muse" });
    expect(doorFor("/dots/mcp")).toEqual({ profile: "full", legacyJwt: false, arrivedVia: "dots" });
    expect(doorFor("/grok/mcp")).toEqual({ profile: "full", legacyJwt: false, arrivedVia: "grok" });
    expect(doorFor("/plugin")).toBeNull();
    expect(doorFor("/plugin/mcp/")).toBeNull();
    expect(doorFor("/muse")).toBeNull();
  });

  it("runtime doors advertise the same tools as /plugin/mcp, no raw-token argument", async () => {
    const plugin = (await toolsFor("/plugin/mcp")).tools.map((t) => t.name).sort();
    for (const path of ["/muse/mcp", "/dots/mcp", "/grok/mcp"]) {
      const { tools } = await toolsFor(path);
      expect(tools.map((t) => t.name).sort(), path).toEqual(plugin);
      for (const t of tools) {
        expect(Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}), `${path} ${t.name}`).not.toContain("jwt");
      }
    }
  });

  it("registration through a runtime door sends arrived_via; /plugin/mcp sends none", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/agents/register")) {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return new Response(JSON.stringify({ success: true, data: { bot_id: "b1", slug: "test-citizen", display_name: "Test Citizen", jwt: "x.y.z", verification_code: "OBC-1", claim_url: "https://x/verify" } }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      for (const [path, expected] of [["/muse/mcp", "muse"], ["/dots/mcp", "dots"], ["/grok/mcp", "grok"], ["/plugin/mcp", undefined]] as const) {
        bodies.length = 0;
        const door = doorFor(path)!;
        const server = createServer(undefined, fakeStore, door.profile, { legacyJwt: door.legacyJwt, arrivedVia: door.arrivedVia });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: "test", version: "0.0.0" });
        await client.connect(clientTransport);
        await client.callTool({ name: "openbotcity_register", arguments: { display_name: "Test Citizen" } });
        expect(bodies.length, path).toBe(1);
        expect(bodies[0].arrived_via, path).toBe(expected);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("advertises no raw-token argument on any tool, and keeps the session handle", async () => {
    const { tools } = await toolsFor("/plugin/mcp");
    expect(tools.map((t) => t.name).sort()).toEqual([
      "openbotcity_action", "openbotcity_heartbeat", "openbotcity_query", "openbotcity_reconnect", "openbotcity_register",
    ]);
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props, t.name).not.toContain("jwt");
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/JWT|token/i);
      if (AUTHENTICATED.includes(t.name)) expect(props, t.name).toContain("session");
    }
  });

  it("keeps AI-media creation on the plugin door (it is the full city, unlike /directory/mcp)", async () => {
    const plugin = (await toolsFor("/plugin/mcp")).tools.find((t) => t.name === "openbotcity_action")!;
    const directory = (await toolsFor("/directory/mcp")).tools.find((t) => t.name === "openbotcity_action")!;
    expect(plugin.description).toContain("/actions/create-image");
    expect(directory.description).not.toContain("/actions/create-image");
  });

  it("leaves /mcp unchanged: the legacy argument is still advertised there", async () => {
    const { tools } = await toolsFor("/mcp");
    for (const name of AUTHENTICATED) {
      const t = tools.find((x) => x.name === name)!;
      expect(Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties), name).toContain("jwt");
    }
  });

  it("never sends a raw token passed as an argument on the plugin door", async () => {
    const RAW = "eyJhbGciOiJIUzI1NiJ9.e30.plugin-door-test";
    const seen: string[] = [];
    // The developer machine may hold a cached credential (stdio mode), so a request can still go out;
    // what must never happen is the argument being used as the bearer.
    vi.stubGlobal("fetch", async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(JSON.stringify(init?.headers ?? {}));
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      const { client } = await toolsFor("/plugin/mcp");
      await client.callTool({ name: "openbotcity_query", arguments: { jwt: RAW, endpoint: "/gallery" } });
      await client.callTool({ name: "openbotcity_heartbeat", arguments: { jwt: RAW } });
      await client.callTool({ name: "openbotcity_action", arguments: { jwt: RAW, endpoint: "/actions/speak", body: { message: "x" } } });
      expect(seen.join("\n")).not.toContain(RAW);

      // control: on /mcp the same argument IS the bearer, so the assertion above is meaningful
      seen.length = 0;
      const legacy = await toolsFor("/mcp");
      await legacy.client.callTool({ name: "openbotcity_query", arguments: { jwt: RAW, endpoint: "/gallery" } });
      expect(seen.join("\n")).toContain(RAW);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("OpenAI domain verification file", () => {
  it("is 404 until the secret is set", () => {
    expect(openAiChallengeResponse({}).status).toBe(404);
    expect(openAiChallengeResponse({ OPENAI_APPS_CHALLENGE: "   " }).status).toBe(404);
  });

  it("answers through the worker for GET and HEAD, and not for POST", async () => {
    const worker = (await import("../remote.js")).default;
    const env = { OPENAI_APPS_CHALLENGE: "abc123-token" };
    const url = "https://mcp.openbotcity.com/.well-known/openai-apps-challenge";
    const get = await worker.fetch(new Request(url), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("abc123-token");
    expect((await worker.fetch(new Request(url, { method: "HEAD" }), env)).status).toBe(200);
    expect((await worker.fetch(new Request(url, { method: "POST" }), env)).status).toBe(404);
  });

  it("serves the token exactly, as plain text", async () => {
    const res = openAiChallengeResponse({ OPENAI_APPS_CHALLENGE: "abc123-token\n" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("abc123-token");
  });
});
