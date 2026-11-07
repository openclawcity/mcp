import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import type { SessionStore } from "../services/sessionStore.js";
import { SseParser, EventBuffer, startEventStream, toFrame, describeFrame, type EventStreamController } from "../services/eventStream.js";

const fakeStore: SessionStore = {
  async get() { return null; },
  async put() { return "obc_test"; },
  async touch() { return; },
} as unknown as SessionStore;

async function connectedClient(eventStream?: EventStreamController) {
  const server = createServer(undefined, fakeStore, "full", { eventStream });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const frame = (id: number, type: string, text: string, from = { id: "b2", name: "Hiro" }) =>
  `id: ${id}\nevent: city_event\ndata: ${JSON.stringify({ type, from, text, metadata: {}, reply_with: type === "channel_chat" ? 'openbotcity_action(endpoint="/channels/chat/reply", body={"message":"..."})' : undefined })}\n\n`;

describe("SseParser", () => {
  it("assembles messages across chunk boundaries, drops comments, joins data lines", () => {
    const p = new SseParser();
    const a = p.feed("event: welcome\ndata: {\"a\":1}\n\n: keepalive\n\nid: 41\nevent: city_ev");
    expect(a).toEqual([{ id: null, event: "welcome", data: "{\"a\":1}" }]);
    const b = p.feed("ent\ndata: line1\ndata: line2\n\n");
    expect(b).toEqual([{ id: "41", event: "city_event", data: "line1\nline2" }]);
    expect(p.feed("retry: 5000\n\n")).toEqual([]);
  });
  it("tolerates CRLF and a field with no value", () => {
    const p = new SseParser();
    expect(p.feed("id: 7\r\nevent\r\ndata: x\r\n\r\n")).toEqual([{ id: "7", event: "message", data: "x" }]);
  });
});

describe("toFrame / describeFrame", () => {
  it("reads the city frame fields and keeps the raw object", () => {
    const f = toFrame(1, "12", JSON.stringify({ type: "channel_chat", from: { id: "u1", name: "hiro" }, text: "hello?", metadata: { messageId: "m1" } }));
    expect(f).toMatchObject({ seq: 1, id: 12, type: "channel_chat", from: { id: "u1", name: "hiro" }, text: "hello?", metadata: { messageId: "m1" } });
    expect(describeFrame(f!)).toBe("- [channel_chat] hiro: hello?");
  });
  it("refuses junk", () => {
    expect(toFrame(1, "1", "not json")).toBeNull();
    expect(toFrame(1, "1", "[1,2]")).toBeNull();
  });
});

describe("EventBuffer", () => {
  it("hands out each frame once, in order, and remembers the last stream id", async () => {
    const b = new EventBuffer(3);
    b.push("10", JSON.stringify({ type: "dm_message", text: "a" }));
    b.push("11", JSON.stringify({ type: "dm_message", text: "b" }));
    expect(b.unreadCount()).toBe(2);
    expect(b.takeUnread().map((f) => f.text)).toEqual(["a", "b"]);
    expect(b.takeUnread()).toEqual([]);
    b.push("12", JSON.stringify({ type: "x", text: "c" }));
    b.push("13", JSON.stringify({ type: "x", text: "d" }));
    b.push("14", JSON.stringify({ type: "x", text: "e" }));
    // capped at 3: the oldest unread ("c") is gone, the newest three remain
    expect(b.takeUnread().map((f) => f.text)).toEqual(["c", "d", "e"].slice(-3));
    expect(b.lastId()).toBe(14);
  });
  it("waitForNext resolves on the next push and times out otherwise", async () => {
    const b = new EventBuffer();
    const late = b.waitForNext(10_000);
    b.push("1", JSON.stringify({ type: "x", text: "now" }));
    expect(await late).toBe(true);
    b.takeUnread();
    expect(await b.waitForNext(5)).toBe(false);
  });
});

function streamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) { controller.enqueue(enc.encode(c)); await new Promise((r) => setTimeout(r, 1)); }
      controller.close();
    },
  });
}

describe("startEventStream", () => {
  it("connects with the token, buffers city events, resumes with Last-Event-ID, and backs off on 401", async () => {
    const calls: Array<Record<string, string>> = [];
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ ...(init?.headers as Record<string, string>) });
      n++;
      if (n === 1) return new Response(streamBody([
        "event: welcome\ndata: {}\n\n",
        frame(100, "channel_chat", "are you here?"),
        ": keepalive\n\n",
        frame(101, "dm_message", "hi"),
      ]), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      if (n === 2) return new Response("nope", { status: 401 });
      return new Response(streamBody([]), { status: 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const ctl = startEventStream({ baseUrl: "https://api.test", getToken: () => "jwt-1", fetchImpl, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); }, log: () => {} });
    await new Promise((r) => setTimeout(r, 60));
    ctl.stop();
    await new Promise((r) => setTimeout(r, 5));

    expect(calls[0]!.Authorization).toBe("Bearer jwt-1");
    expect(calls[0]!["Last-Event-ID"]).toBeUndefined();
    expect(calls[1]!["Last-Event-ID"]).toBe("101");
    expect(ctl.buffer.takeUnread().map((f) => [f.id, f.type, f.text])).toEqual([[100, "channel_chat", "are you here?"], [101, "dm_message", "hi"]]);
    // the first stream ended at once (paced like an error), then the 401 waited the dead-token pause
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps).toContain(60_000);
    expect(ctl.status().lastError === null || /refused|answered/.test(ctl.status().lastError!)).toBe(true);
  });

  it("waits for credentials instead of hammering when there is no token", async () => {
    const fetchImpl = vi.fn(async () => new Response(streamBody([]), { status: 200 })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const ctl = startEventStream({ baseUrl: "https://api.test", getToken: () => null, fetchImpl, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); }, log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    ctl.stop();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleeps[0]).toBe(15_000);
  });
});

describe("openbotcity_events tool and the heartbeat prefix", () => {
  it("is absent without a held stream (remote), present with one (stdio)", async () => {
    const without = await connectedClient();
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("openbotcity_events");
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: true, connectedSince: 1, lastEventAt: null, lastError: null, reconnects: 0, unread: buffer.unreadCount() }), stop() {} };
    const withStream = await connectedClient(ctl);
    const tools = (await withStream.listTools()).tools;
    const t = tools.find((x) => x.name === "openbotcity_events");
    expect(t?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("returns new events once, tells the agent how to answer viewers, and waits when asked", async () => {
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: true, connectedSince: 1, lastEventAt: Date.now(), lastError: null, reconnects: 0, unread: buffer.unreadCount() }), stop() {} };
    const client = await connectedClient(ctl);
    buffer.push("5", JSON.stringify({ type: "channel_chat", from: { id: "u", name: "hiro" }, text: "hello pinion" }));
    const first = await client.callTool({ name: "openbotcity_events", arguments: {} });
    const text = (first.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("1 new event");
    expect(text).toContain("[channel_chat] hiro: hello pinion");
    expect(text).toContain('/channels/chat/reply');
    const second = await client.callTool({ name: "openbotcity_events", arguments: { wait_seconds: 0 } });
    expect((second.content as Array<{ text: string }>)[0]!.text).toContain("No new events");
    const waiting = client.callTool({ name: "openbotcity_events", arguments: { wait_seconds: 5 } });
    await new Promise((r) => setTimeout(r, 10));
    buffer.push("6", JSON.stringify({ type: "dm_message", from: { id: "b", name: "Sable" }, text: "ping" }));
    const third = await waiting;
    expect((third.content as Array<{ text: string }>)[0]!.text).toContain("[dm_message] Sable: ping");
  });

  it("says when the stream is down instead of pretending", async () => {
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: false, connectedSince: null, lastEventAt: null, lastError: "stream answered 503", reconnects: 3, unread: 0 }), stop() {} };
    const client = await connectedClient(ctl);
    const r = await client.callTool({ name: "openbotcity_events", arguments: {} });
    expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/NOT connected .*503.*reconnecting/);
  });
});
