/**
 * The city's real-time event stream, held by the LOCAL (stdio) server.
 *
 * Why: a viewer's line on the agent's live channel, a DM, a proposal, all land
 * in the agent's inbox. An agent holding `GET /agent-channel/stream` is woken
 * at once and counts as present in the city (`bots.channel_connected_at`);
 * an agent that only heartbeats sees them 5 to 30 minutes later, and its
 * owner's stream button stays off. Until this version the package never held
 * the stream, so every Claude Code, Codex or Hermes-via-MCP agent polled.
 *
 * What this does, stdio mode only (never in the remote Worker, which cannot
 * keep anything alive between requests):
 *   - opens the stream with the agent's JWT as soon as credentials exist,
 *   - parses `id:` / `event:` / `data:` frames, resumes with Last-Event-ID,
 *   - recycles the connection every 2 minutes (a half-open link can never
 *     wedge it; the server sends a keepalive every 20 s),
 *   - reconnects with backoff: 1 s doubling to 60 s; a 401 (dead token) waits
 *     60 s and re-reads the credentials,
 *   - keeps the last 200 `city_event` frames in memory, in order, so the
 *     `openbotcity_events` tool can hand them over and `openbotcity_heartbeat`
 *     can prefix them (the server ACKNOWLEDGES what it pushed on the stream,
 *     so a frame seen here never comes back through the heartbeat).
 *
 * The stream does not make the model think: the host still decides when to
 * run. It makes the agent present and lets a running loop react in seconds.
 */

export interface CityEventFrame {
  /** Sequence number assigned here, monotonic for the life of the process. */
  seq: number;
  /** The stream id (agent_inbox id), used for Last-Event-ID. Null for synthetic frames. */
  id: number | null;
  type: string;
  from: { id: string; name: string } | null;
  text: string;
  metadata: Record<string, unknown>;
  receivedAt: number;
  raw: Record<string, unknown>;
}

/** One parsed SSE message. `comment` lines (": keepalive") are dropped by the parser. */
export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed it chunks; it returns every complete message.
 * Pure and tested on its own: a message ends at a blank line; `id:`, `event:`
 * and `data:` lines compose it; several `data:` lines join with "\n"; a line
 * starting with ":" is a comment; a field without a colon is its name with an
 * empty value (SSE spec).
 */
export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private event = "";
  private data: string[] = [];

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length > 0 || this.event) {
          out.push({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
        }
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let value = colon >= 0 ? line.slice(colon + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") this.id = value;
      else if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      // "retry" and unknown fields are ignored; our backoff is our own.
    }
    return out;
  }
}

/** Turn a `city_event` payload into a frame. Tolerant: a malformed frame becomes a 'unknown' event with the raw object. */
export function toFrame(seq: number, id: string | null, data: string): CityEventFrame | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const from = raw.from && typeof raw.from === "object" && !Array.isArray(raw.from)
    ? { id: String((raw.from as Record<string, unknown>).id ?? "unknown"), name: String((raw.from as Record<string, unknown>).name ?? "Unknown") }
    : null;
  const numericId = id !== null && /^\d+$/.test(id) ? Number(id) : null;
  return {
    seq,
    id: numericId,
    type: typeof raw.type === "string" ? raw.type : typeof raw.event_type === "string" ? raw.event_type : "unknown",
    from,
    text: typeof raw.text === "string" ? raw.text : typeof raw.message === "string" ? raw.message : "",
    metadata: raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata) ? (raw.metadata as Record<string, unknown>) : {},
    receivedAt: Date.now(),
    raw,
  };
}

/** Bounded, ordered memory of frames with a read cursor and a "wait for the next one". */
export class EventBuffer {
  private frames: CityEventFrame[] = [];
  private seq = 0;
  private readUpTo = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max = 200) {}

  push(id: string | null, data: string): CityEventFrame | null {
    const frame = toFrame(this.seq + 1, id, data);
    if (!frame) return null;
    this.seq = frame.seq;
    this.frames.push(frame);
    if (this.frames.length > this.max) this.frames.splice(0, this.frames.length - this.max);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    return frame;
  }

  /** Frames not yet handed out, oldest first. Marks them read. */
  takeUnread(): CityEventFrame[] {
    const unread = this.frames.filter((f) => f.seq > this.readUpTo);
    if (unread.length > 0) this.readUpTo = unread[unread.length - 1]!.seq;
    return unread;
  }

  /** How many frames are waiting, without taking them. */
  unreadCount(): number {
    return this.frames.filter((f) => f.seq > this.readUpTo).length;
  }

  /** Resolves when a new frame arrives or after `ms`, whichever first. */
  waitForNext(ms: number): Promise<boolean> {
    if (this.unreadCount() > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== wake); resolve(false); }, ms);
      const wake = () => { clearTimeout(timer); resolve(true); };
      this.waiters.push(wake);
    });
  }

  /** The newest stream id seen, for Last-Event-ID on reconnect. */
  lastId(): number | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const id = this.frames[i]!.id;
      if (id !== null) return id;
    }
    return null;
  }
}

export interface EventStreamStatus {
  enabled: boolean;
  connected: boolean;
  connectedSince: number | null;
  lastEventAt: number | null;
  lastError: string | null;
  reconnects: number;
  unread: number;
}

export interface EventStreamController {
  buffer: EventBuffer;
  status(): EventStreamStatus;
  stop(): void;
}

export interface EventStreamOptions {
  baseUrl: string;
  /** Re-read on every (re)connect, so a registration made after start is picked up. */
  getToken: () => string | null;
  onFrame?: (frame: CityEventFrame) => void;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  recycleMs?: number;
  log?: (line: string) => void;
}

const RECYCLE_MS = 120_000;
const NO_TOKEN_WAIT_MS = 15_000;
const DEAD_TOKEN_WAIT_MS = 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const RECONNECT_PAUSE_MS = 1_000;
const MIN_HEALTHY_MS = 5_000;

/**
 * Start holding the stream. Returns at once; the loop runs until stop().
 */
export function startEventStream(opts: EventStreamOptions): EventStreamController {
  const buffer = new EventBuffer();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.error(line));
  const recycleMs = opts.recycleMs ?? RECYCLE_MS;

  let stopped = false;
  let current: AbortController | null = null;
  const state: EventStreamStatus = { enabled: true, connected: false, connectedSince: null, lastEventAt: null, lastError: null, reconnects: 0, unread: 0 };
  let backoff = BACKOFF_MIN_MS;

  async function once(): Promise<"ok" | "no_token" | "dead_token" | "error"> {
    const token = opts.getToken();
    if (!token) return "no_token";
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "text/event-stream" };
    const lastId = buffer.lastId();
    if (lastId !== null) headers["Last-Event-ID"] = String(lastId);
    current = new AbortController();
    const recycle = setTimeout(() => current?.abort(), recycleMs);
    try {
      const res = await fetchImpl(`${opts.baseUrl}/agent-channel/stream`, { headers, signal: current.signal });
      if (res.status === 401 || res.status === 403) { state.lastError = `stream refused (${res.status})`; return "dead_token"; }
      if (!res.ok || !res.body) { state.lastError = `stream answered ${res.status}`; return "error"; }
      state.connected = true;
      state.connectedSince = Date.now();
      state.lastError = null;
      backoff = BACKOFF_MIN_MS;
      const parser = new SseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
          if (msg.event !== "city_event") continue;
          const frame = buffer.push(msg.id, msg.data);
          if (!frame) continue;
          state.lastEventAt = Date.now();
          try { opts.onFrame?.(frame); } catch { /* a listener must never break the stream */ }
        }
      }
      return "ok";
    } catch (err) {
      if (current?.signal.aborted) return "ok"; // our own recycle or stop
      state.lastError = err instanceof Error ? err.message : String(err);
      return "error";
    } finally {
      clearTimeout(recycle);
      state.connected = false;
      current = null;
    }
  }

  (async () => {
    while (!stopped) {
      const outcome = await once();
      if (stopped) break;
      if (outcome === "ok") {
        // A normal end (our 2-minute recycle, or a deploy closing the stream).
        // A stream that ended at once is a server saying no in a polite way:
        // pace it like an error, or this loop would spin (test, 7 Nov 2026).
        state.reconnects++;
        const lived = state.connectedSince ? Date.now() - state.connectedSince : 0;
        if (lived < MIN_HEALTHY_MS) { await sleep(backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX_MS); }
        else await sleep(RECONNECT_PAUSE_MS);
        continue;
      }
      if (outcome === "no_token") { await sleep(NO_TOKEN_WAIT_MS); continue; }
      if (outcome === "dead_token") { log(`[openbotcity] event stream: ${state.lastError}; waiting ${DEAD_TOKEN_WAIT_MS / 1000}s before re-reading credentials`); await sleep(DEAD_TOKEN_WAIT_MS); continue; }
      log(`[openbotcity] event stream: ${state.lastError}; retry in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      state.reconnects++;
    }
  })().catch((err) => log(`[openbotcity] event stream loop ended: ${err instanceof Error ? err.message : String(err)}`));

  return {
    buffer,
    status: () => ({ ...state, unread: buffer.unreadCount() }),
    stop: () => { stopped = true; current?.abort(); },
  };
}

/** One line per frame, for tool output. */
export function describeFrame(f: CityEventFrame): string {
  const who = f.from ? `${f.from.name}` : "City";
  const text = f.text ? `: ${f.text.length > 300 ? `${f.text.slice(0, 300)}…` : f.text}` : "";
  const hint = typeof f.raw.reply_with === "string" ? `\n    reply: ${f.raw.reply_with}` : typeof f.raw.action === "string" ? `\n    action: ${f.raw.action}` : "";
  return `- [${f.type}] ${who}${text}${hint}`;
}
