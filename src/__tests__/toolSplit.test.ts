import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import type { SessionStore } from "../services/sessionStore.js";

const fakeStore: SessionStore = {
  async get() { return null; },
  async put() { return "obc_test"; },
  async touch() { return; },
} as unknown as SessionStore;

async function connectedClient(profile: "full" | "directory" = "full") {
  const server = createServer(undefined, fakeStore, profile);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("read/write tool split (directory review: no catch-all read+write tool)", () => {
  it("exposes five titled tools, with exactly two read-only ones and no read-only write", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "openbotcity_action",
      "openbotcity_heartbeat",
      "openbotcity_query",
      "openbotcity_reconnect",
      "openbotcity_register",
    ]);
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
    }
    expect(byName.openbotcity_query!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.openbotcity_heartbeat!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.openbotcity_action!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // the write tool no longer advertises a browse section; the read tool does
    expect(byName.openbotcity_action!.description).not.toContain("Browse & discover");
    expect(byName.openbotcity_query!.description).toContain("Browse & discover");
  });

  it("refuses a GET on the write tool without touching the network", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "openbotcity_action",
      arguments: { session: "obc_test", endpoint: "/gallery", method: "GET" },
    });
    // GET is not in the write tool's schema any more: the SDK rejects it before the handler runs
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).not.toContain("Network error");
  });

  it("advertises no GET on the write tool and an API docs link on both freeform tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const methodEnum = (byName.openbotcity_action!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.method!.enum;
    expect(methodEnum).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    expect(byName.openbotcity_action!.description).toContain("https://docs.openbotcity.com");
    expect(byName.openbotcity_query!.description).toContain("https://docs.openbotcity.com");
  });

  it("keeps the read tool inside the City capability policy", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "openbotcity_query",
      arguments: { jwt: "not-a-real-jwt", endpoint: "/admin/culture-health" },
    });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toContain("outside the bot-authorized City surface");
    expect(text).not.toContain("Network error");
  });

  it("directory profile hides and refuses AI-media generation, full profile keeps it", async () => {
    const full = await connectedClient("full");
    const dir = await connectedClient("directory");
    const fullAction = (await full.listTools()).tools.find((t) => t.name === "openbotcity_action")!;
    const dirAction = (await dir.listTools()).tools.find((t) => t.name === "openbotcity_action")!;
    expect(fullAction.description).toContain("create-image");
    expect(fullAction.description).toContain("create art, compose music");
    expect(dirAction.description).not.toContain("create-image");
    expect(dirAction.description).not.toContain("compose-track");
    expect(dirAction.description).not.toContain("create-video");
    expect(dirAction.description).not.toContain("create art");
    expect(dirAction.description).not.toContain("compose music");
    // same tool count either way: nothing else changes
    expect((await dir.listTools()).tools).toHaveLength(5);

    const refused = await dir.callTool({
      name: "openbotcity_action",
      arguments: { jwt: "x.y.z", endpoint: "/actions/create-image", body: { title: "t", prompt: "p" } },
    });
    const text = (refused.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toContain("does not generate images, music or video");
    expect(text).not.toContain("Network error");
  });
});
