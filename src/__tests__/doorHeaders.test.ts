import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../remote.js";
import { getDoorHeaders, runInRequestScope } from "../services/credentials.js";

/**
 * The hosted server forwards the address it saw (CF-Connecting-IP) to the API
 * under the shared door secret, so the API can key its per-IP rules on the real
 * caller instead of this worker's egress. No secret configured = nothing sent.
 */

const REGISTER_RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "openbotcity_register", arguments: { display_name: "Door Citizen" } },
};

function mcpRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mcp.openbotcity.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(REGISTER_RPC),
  });
}

function captureApiCalls() {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, headers: { ...(init?.headers ?? {}) } });
    if (url.endsWith("/agents/register")) {
      return new Response(JSON.stringify({ success: true, data: { bot_id: "b1", slug: "door-citizen", display_name: "Door Citizen", jwt: "x.y.z", verification_code: "OBC-1", claim_url: "https://x/verify" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("door headers on API calls", () => {
  it("forwards the secret and the caller address when DOOR_API_KEY is set", async () => {
    const seen = captureApiCalls();
    const res = await worker.fetch(mcpRequest("/muse/mcp", { "CF-Connecting-IP": "203.0.113.9" }), { DOOR_API_KEY: "door-secret" });
    expect(res.status).toBe(200);
    await res.text(); // the tool runs while the streamed body is consumed
    const register = seen.find((c) => c.url.endsWith("/agents/register"));
    expect(register, "register call reached the API").toBeDefined();
    expect(register!.headers["X-Door-Key"]).toBe("door-secret");
    expect(register!.headers["X-Door-Client-IP"]).toBe("203.0.113.9");
  });

  it("sends neither header when no secret is configured", async () => {
    const seen = captureApiCalls();
    const res = await worker.fetch(mcpRequest("/plugin/mcp", { "CF-Connecting-IP": "203.0.113.9" }), {});
    expect(res.status).toBe(200);
    await res.text();
    const register = seen.find((c) => c.url.endsWith("/agents/register"))!;
    expect(register.headers["X-Door-Key"]).toBeUndefined();
    expect(register.headers["X-Door-Client-IP"]).toBeUndefined();
  });

  it("omits the address header when the edge gave none, and is empty outside a keyed scope", async () => {
    expect(getDoorHeaders()).toEqual({});
    await runInRequestScope(undefined, async () => {
      expect(getDoorHeaders()).toEqual({});
    });
    await runInRequestScope(undefined, async () => {
      expect(getDoorHeaders()).toEqual({ "X-Door-Key": "k" });
    }, { key: "k", clientIp: null });
  });
});
