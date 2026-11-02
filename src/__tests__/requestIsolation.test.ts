import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import {
  getToken, isRemoteRequest, oneTimeAgentKey, runInRequestScope, storeCredentials,
} from "../services/credentials.js";
import { createSessionStore, isSessionHandle, type SessionStore } from "../services/sessionStore.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** In-memory stand-in for the Redis session store. */
function memoryStore(): SessionStore {
  const data = new Map<string, unknown>();
  let n = 0;
  return {
    configured: true,
    async put(payload: unknown) { const h = `obc_${String(++n).padStart(24, "0")}`; data.set(h, payload); return h; },
    async get(handle: string) { return (data.get(handle) as never) ?? null; },
    async del(handle: string) { data.delete(handle); },
  } as unknown as SessionStore;
}

async function clientInScope(store: SessionStore, bearer?: string) {
  const server = createServer(bearer, store, "full", { legacyJwt: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content).map((c) => c.text ?? "").join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("credentials never cross between simultaneous remote requests", () => {
  it("a token stored by one request is invisible to another that is running at the same time", async () => {
    const a = runInRequestScope(undefined, async () => {
      storeCredentials({ jwt: "JWT_OF_A" });
      await tick(20);
      return getToken();
    });
    const b = runInRequestScope(undefined, async () => {
      await tick(5); // A has stored its token and is still awaiting
      return getToken();
    });
    expect(await b).toBeNull();
    expect(await a).toBe("JWT_OF_A");
  });

  it("a Bearer header belongs to its own request only", async () => {
    const a = runInRequestScope("BEARER_A", async () => { await tick(20); return getToken(); });
    const b = runInRequestScope(undefined, async () => { await tick(5); return getToken(); });
    expect(await b).toBeNull();
    expect(await a).toBe("BEARER_A");
  });

  it("a remote request never falls back to the machine's cached credentials or environment", async () => {
    const before = process.env.OPENBOTCITY_JWT;
    process.env.OPENBOTCITY_JWT = "ENV_JWT_MUST_NOT_BE_USED";
    try {
      expect(await runInRequestScope(undefined, async () => getToken())).toBeNull();
    } finally {
      if (before === undefined) delete process.env.OPENBOTCITY_JWT; else process.env.OPENBOTCITY_JWT = before;
    }
  });

  it("end to end: while A's registration is in flight, B's call with no session is not sent with A's token", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      calls.push({ url, auth: init?.headers?.Authorization ?? "" });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/agents/register")) {
        await tick(10);
        return json({ bot_id: "bot-a", jwt: "JWT_OF_A", slug: "agent-a", display_name: "Agent A", profile_url: "https://openclawcity.ai/agent-a", verification_code: "OBC-AAAA-BBBB" }, 201);
      }
      if (url.includes("/agents/enable-autopilot")) { await tick(40); return json({ success: true }); }
      return json({ success: true, data: {} });
    });
    const store = memoryStore();

    const a = runInRequestScope(undefined, async () => {
      const client = await clientInScope(store);
      return client.callTool({ name: "openbotcity_register", arguments: { display_name: "Agent A" } });
    });
    const b = runInRequestScope(undefined, async () => {
      const client = await clientInScope(store);
      await tick(25); // A holds its fresh token and is awaiting the autopilot call
      return client.callTool({ name: "openbotcity_heartbeat", arguments: {} });
    });

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(textOf(resultA)).toContain("Registered as");
    expect(textOf(resultB)).toContain("No credentials provided");
    const heartbeats = calls.filter((c) => c.url.includes("/world/heartbeat"));
    expect(heartbeats).toEqual([]); // B never reached the API, with anyone's token
  });
});

describe("remote registration can never adopt someone else's agent by name", () => {
  it("sends a fresh one-time agent_key on every remote registration", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }) => {
      if (String(input).includes("/agents/register")) keys.push(JSON.parse(init!.body!).agent_key);
      return new Response(JSON.stringify({ success: false, code: "NAME_TAKEN", error: "Display name is already taken by another agent." }), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    const store = memoryStore();
    for (let i = 0; i < 2; i++) {
      const result = await runInRequestScope(undefined, async () => {
        const client = await clientInScope(store);
        return client.callTool({ name: "openbotcity_register", arguments: { display_name: "Luna" } });
      });
      // the refusal steers to reconnect, never to a modified name
      expect(textOf(result)).toContain("openbotcity_reconnect");
    }
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^obck_once_[0-9a-f]{32}$/);
    expect(keys[0]).not.toBe(keys[1]);
    // the City API accepts this shape (AGENT_KEY_PATTERN in workers/src/routes/register.ts)
    expect(oneTimeAgentKey()).toMatch(/^[A-Za-z0-9._-]{16,128}$/);
  });

  it("knows it is remote only inside a request scope", async () => {
    expect(isRemoteRequest()).toBe(false);
    expect(await runInRequestScope(undefined, async () => isRemoteRequest())).toBe(true);
  });
});

describe("session handles", () => {
  it("are issued with 96 bits and never repeat", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ result: "OK" }), { status: 200 }));
    const store = createSessionStore({ UPSTASH_REDIS_REST_URL: "https://example.invalid", UPSTASH_REDIS_REST_TOKEN: "t" });
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const handle = await store.put({ jwt: "x" });
      expect(handle).toMatch(/^obc_[0-9a-f]{24}$/);
      seen.add(handle!);
    }
    expect(seen.size).toBe(50);
  });

  it("accepts new and not-yet-expired old handles, and nothing else", () => {
    expect(isSessionHandle("obc_" + "a".repeat(24))).toBe(true);
    expect(isSessionHandle("obc_" + "a".repeat(12))).toBe(true);
    for (const bad of ["obc_" + "a".repeat(13), "obc_" + "g".repeat(24), "obc_", "abc_" + "a".repeat(24), "obc_" + "a".repeat(24) + "/x"]) {
      expect(isSessionHandle(bad), bad).toBe(false);
    }
  });
});
