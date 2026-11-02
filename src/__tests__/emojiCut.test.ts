import { afterEach, describe, expect, it, vi } from "vitest";

import { clip, wellFormed } from "../tools/text.js";
import { heartbeatTool } from "../tools/heartbeat.js";
import type { SessionStore } from "../services/sessionStore.js";

// The DM that hung every heartbeat of Nano Harlock (Codex, 2 Nov 2026): the
// emoji starts at code unit 99, so a plain slice(0, 100) kept half of it.
const CLAWDINE_DM = "You're very welcome. Clean record, clean break — that's how it should be. Take care, Nano Harlock. 🫡";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("clip", () => {
  it("never ends in half an emoji", () => {
    expect(CLAWDINE_DM.slice(0, 100)).toMatch(LONE); // the old behaviour
    const out = clip(CLAWDINE_DM, 100);
    expect(out).not.toMatch(LONE);
    expect(out).toBe(CLAWDINE_DM.slice(0, 99));
  });

  it("keeps a whole emoji that fits, and short or empty text as is", () => {
    expect(clip(CLAWDINE_DM, 101)).toBe(CLAWDINE_DM);
    expect(clip("hi", 100)).toBe("hi");
    expect(clip(undefined, 100)).toBe("");
  });
});

describe("wellFormed", () => {
  it("replaces lone halves and leaves whole emoji alone", () => {
    expect(wellFormed("a\uD83Db")).toBe("a�b");
    expect(wellFormed("a\uDC4Bb")).toBe("a�b");
    expect(wellFormed("ok 🫡")).toBe("ok 🫡");
  });
});

describe("openbotcity_heartbeat output", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is valid UTF-16 when a DM preview is cut at an emoji", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      context: "zone",
      dm: { unread_count: 1, unread_messages: [{ from_display_name: "Clawdine", conversation_id: "c1", message: CLAWDINE_DM }] },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    let handler: ((args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined;
    const server = { tool: (...a: unknown[]) => { handler = a[a.length - 1] as typeof handler; } };
    const store = { get: async () => null } as unknown as SessionStore;
    heartbeatTool(server as never, store, true);

    const result = await handler!({ jwt: "eyJ.test.jwt" });
    const text = result.content[0].text;
    expect(text).toContain("[dm] Clawdine");
    expect(text).not.toMatch(LONE);
    // What a strict reader (Codex / serde) sees on the wire: no unpaired \ud83d.
    expect(JSON.stringify(result)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });
});
