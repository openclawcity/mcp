import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../server.js";
import type { SessionStore } from "../services/sessionStore.js";
import { SseParser, EventBuffer, startEventStream, toFrame, describeFrame, IDLE_MS, type EventStreamController } from "../services/eventStream.js";

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

/** EXACTLY what workers/src/lib/cityEventFrame.ts sends: the envelope type is 'city_event', the kind is eventType. */
const serverFrame = (id: number, eventType: string, text: string, from = { id: "b2", name: "Hiro" }, metadata: Record<string, unknown> = {}) =>
  ({ type: "city_event", seq: id, eventType, from, text, timestamp: 1, metadata });
const frame = (id: number, eventType: string, text: string, from = { id: "b2", name: "Hiro" }, metadata: Record<string, unknown> = {}) =>
  `id: ${id}\nevent: city_event\ndata: ${JSON.stringify(serverFrame(id, eventType, text, from, metadata))}\n\n`;

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
  it("reads the SERVER frame: the kind from eventType, never the 'city_event' envelope (audit 8 Nov)", () => {
    const f = toFrame(1, "12", JSON.stringify(serverFrame(12, "channel_chat", "hello?", { id: "viewer", name: "hiro (Twitch)" }, { message_id: "m1", reply_command: 'POST /channels/chat/reply {"message":"<your reply>"}' })));
    expect(f).toMatchObject({ seq: 1, id: 12, type: "channel_chat", from: { id: "viewer", name: "hiro (Twitch)" }, text: "hello?" });
    expect(describeFrame(f!)).toBe('- [channel_chat] hiro (Twitch): hello? (message_id=m1)\n    reply: POST /channels/chat/reply {"message":"<your reply>"}');
    const dm = toFrame(2, "13", JSON.stringify(serverFrame(13, "dm_message", "hi", { id: "b9", name: "Sable" }, { conversation_id: "c1", reply_command: "x" })));
    expect(dm!.type).toBe("dm_message");
    expect(describeFrame(dm!)).toContain("conversation_id=c1");
    // a frame with only the envelope type is 'unknown', not 'city_event'
    expect(toFrame(3, "14", JSON.stringify({ type: "city_event", text: "?" }))!.type).toBe("unknown");
  });
  it("refuses junk", () => {
    expect(toFrame(1, "1", "not json")).toBeNull();
    expect(toFrame(1, "1", "[1,2]")).toBeNull();
  });
});

describe("EventBuffer", () => {
  it("hands out each frame once, in order, and remembers the last stream id", async () => {
    const b = new EventBuffer(3);
    b.push("10", JSON.stringify(serverFrame(10, "dm_message", "a")));
    b.push("11", JSON.stringify(serverFrame(11, "dm_message", "b")));
    expect(b.unreadCount()).toBe(2);
    expect(b.takeUnread().map((f) => f.text)).toEqual(["a", "b"]);
    expect(b.takeUnread()).toEqual([]);
    b.push("12", JSON.stringify(serverFrame(12, "x", "c")));
    b.push("13", JSON.stringify(serverFrame(13, "x", "d")));
    b.push("14", JSON.stringify(serverFrame(14, "x", "e")));
    // capped at 3: the oldest unread ("c") is gone, the newest three remain
    expect(b.takeUnread().map((f) => f.text)).toEqual(["c", "d", "e"].slice(-3));
    expect(b.lastId()).toBe(14);
  });
  it("waitForNext resolves on the next push and times out otherwise", async () => {
    const b = new EventBuffer();
    const late = b.waitForNext(10_000);
    b.push("1", JSON.stringify(serverFrame(1, "x", "now")));
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
  it("is absent without a held stream (remote), present with one (stdio), and NOT read-only (it consumes)", async () => {
    const without = await connectedClient();
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("openbotcity_events");
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: true, connectedSince: 1, lastEventAt: null, lastError: null, reconnects: 0, unread: buffer.unreadCount() }), stop() {} };
    const withStream = await connectedClient(ctl);
    const tools = (await withStream.listTools()).tools;
    const t = tools.find((x) => x.name === "openbotcity_events");
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect((t?.inputSchema as { properties: { wait_seconds: { maximum: number } } }).properties.wait_seconds.maximum).toBe(55);
  });

  it("returns new events once, tells the agent how to answer viewers, and waits when asked", async () => {
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: true, connectedSince: 1, lastEventAt: Date.now(), lastError: null, reconnects: 0, unread: buffer.unreadCount() }), stop() {} };
    const client = await connectedClient(ctl);
    buffer.push("5", JSON.stringify(serverFrame(5, "channel_chat", "hello pinion", { id: "u", name: "hiro" })));
    const first = await client.callTool({ name: "openbotcity_events", arguments: {} });
    const text = (first.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("1 new event");
    expect(text).toContain("[channel_chat] hiro: hello pinion");
    expect(text).toContain('/channels/chat/reply');
    const second = await client.callTool({ name: "openbotcity_events", arguments: { wait_seconds: 0 } });
    expect((second.content as Array<{ text: string }>)[0]!.text).toContain("No new events");
    const waiting = client.callTool({ name: "openbotcity_events", arguments: { wait_seconds: 5 } });
    await new Promise((r) => setTimeout(r, 10));
    buffer.push("6", JSON.stringify(serverFrame(6, "dm_message", "ping", { id: "b", name: "Sable" })));
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

describe("SseParser caps what it will hold (audit 8 Nov)", () => {
  it("drops an endless line instead of growing, and keeps parsing after the next newline", async () => {
    const { SSE_MAX_PENDING_BYTES } = await import("../services/eventStream.js");
    const p = new SseParser();
    expect(p.feed("x".repeat(SSE_MAX_PENDING_BYTES + 10))).toEqual([]);
    expect(p.dropped).toBe(1);
    expect(p.feed("yyy\nid: 5\nevent: city_event\ndata: {\"type\":\"dm_message\",\"text\":\"ok\"}\n\n")).toEqual([
      { id: "5", event: "city_event", data: "{\"type\":\"dm_message\",\"text\":\"ok\"}" },
    ]);
  });
});

describe("audit 8 Nov: the stream only while the agent is active, survives a restart, re-reads a dead token", () => {
  it("does not connect while the agent is idle, and lets go when it goes idle", async () => {
    const fetchImpl = vi.fn(async () => new Response(streamBody([]), { status: 200 })) as unknown as typeof fetch;
    let idle = IDLE_MS + 1;
    const sleeps: number[] = [];
    const ctl = startEventStream({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl, idleMs: () => idle, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); }, log: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ctl.status().connected).toBe(false);
    idle = 0;
    await new Promise((r) => setTimeout(r, 40));
    ctl.stop();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("calls onDeadToken after a 401 so the credentials are read again", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const onDeadToken = vi.fn();
    const ctl = startEventStream({ baseUrl: "https://api.test", getToken: () => "dead", fetchImpl, onDeadToken, sleep: async () => { await new Promise((r) => setTimeout(r, 1)); }, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    ctl.stop();
    expect(onDeadToken).toHaveBeenCalled();
  });

  it("persists unread frames to a file and loads them back; read frames are dropped from it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obc-ev-")), "events.jsonl");
    const a = new EventBuffer(200, file);
    a.push("41", JSON.stringify(serverFrame(41, "channel_chat", "first")));
    a.push("42", JSON.stringify(serverFrame(42, "dm_message", "second", { id: "b", name: "Sable" }, { conversation_id: "c1" })));
    expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    const b = new EventBuffer(200, file);
    expect(b.takeUnread().map((f) => [f.id, f.type, f.text])).toEqual([[41, "channel_chat", "first"], [42, "dm_message", "second"]]);
    expect(b.lastId()).toBe(42);
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(new EventBuffer(200, file).unreadCount()).toBe(0);
  });

  it("a cancelled openbotcity_events call consumes nothing", async () => {
    const buffer = new EventBuffer();
    const ctl: EventStreamController = { buffer, status: () => ({ enabled: true, connected: true, connectedSince: 1, lastEventAt: null, lastError: null, reconnects: 0, unread: buffer.unreadCount() }), stop() {} };
    const client = await connectedClient(ctl);
    const ac = new AbortController();
    const call = client.callTool({ name: "openbotcity_events", arguments: { wait_seconds: 5 } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    buffer.push("7", JSON.stringify(serverFrame(7, "dm_message", "late")));
    ac.abort();
    await call.catch(() => undefined);
    // whatever the host saw, the event is still waiting for the next real call
    expect(buffer.unreadCount()).toBe(1);
  });
});
