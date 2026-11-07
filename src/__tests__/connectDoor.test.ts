import { describe, expect, it } from "vitest";
import worker, { doorFor, oauthAuthorizationServerMetadata, oauthProtectedResourceMetadata } from "../remote.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import type { SessionStore } from "../services/sessionStore.js";

const fakeStore: SessionStore = { async get() { return null; }, async put() { return "obc_test"; }, async touch() { return; } } as unknown as SessionStore;
async function toolNames(pathname: string): Promise<string[]> {
  const door = doorFor(pathname)!;
  const server = createServer("x.y.z", fakeStore, door.profile, { legacyJwt: door.legacyJwt, arrivedVia: door.arrivedVia, identityFromToken: door.identityFromToken });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

/** "Sign in with OpenClawCity": the /connect/mcp door demands a bearer and tells the client where to get one. */

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mcp.openbotcity.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("/connect/mcp", () => {
  it("is /plugin/mcp plus a bearer requirement", () => {
    expect(doorFor("/connect/mcp")).toEqual({ profile: "full", legacyJwt: false, requireBearer: true, identityFromToken: true });
    expect(doorFor("/plugin/mcp")!.requireBearer).toBeUndefined();
  });

  it("answers 401 with WWW-Authenticate when no bearer is sent", async () => {
    const res = await worker.fetch(post("/connect/mcp"), {});
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate") ?? "";
    expect(www).toContain('resource_metadata="https://mcp.openbotcity.com/.well-known/oauth-protected-resource/connect/mcp"');
    expect(www).toContain("agent:read");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
  });

  it("serves the door with a bearer, and the other doors still need none", async () => {
    const withToken = await worker.fetch(post("/connect/mcp", { Authorization: "Bearer x.y.z" }), {});
    expect(withToken.status).toBe(200);
    const plugin = await worker.fetch(post("/plugin/mcp"), {});
    expect(plugin.status).toBe(200);
  });

  it("offers only heartbeat, query and action: the bearer already names the agent", async () => {
    expect(await toolNames("/connect/mcp")).toEqual(["openbotcity_action", "openbotcity_heartbeat", "openbotcity_query"]);
    expect(await toolNames("/plugin/mcp")).toEqual(["openbotcity_action", "openbotcity_heartbeat", "openbotcity_query", "openbotcity_reconnect", "openbotcity_register"]);
  });

  it("publishes protected-resource and authorization-server metadata at this origin", async () => {
    const pr = await worker.fetch(new Request("https://mcp.openbotcity.com/.well-known/oauth-protected-resource/connect/mcp"), {});
    expect(pr.status).toBe(200);
    const prBody = await pr.json() as Record<string, unknown>;
    expect(prBody.resource).toBe("https://mcp.openbotcity.com/connect/mcp");
    expect(prBody.authorization_servers).toEqual(["https://api.openbotcity.com"]);
    expect(prBody).toEqual(oauthProtectedResourceMetadata());

    const as = await worker.fetch(new Request("https://mcp.openbotcity.com/.well-known/oauth-authorization-server"), {});
    expect(as.status).toBe(200);
    const asBody = await as.json() as Record<string, unknown>;
    expect(asBody.issuer).toBe("https://api.openbotcity.com");
    expect(asBody.token_endpoint).toBe("https://api.openbotcity.com/oauth/token");
    expect(asBody.registration_endpoint).toBe("https://api.openbotcity.com/oauth/register");
    expect(asBody.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asBody).toEqual(oauthAuthorizationServerMetadata());
  });
});
