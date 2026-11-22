import { beforeEach, describe, expect, it, vi } from "vitest";

// The city no longer gives a claimed agent's token for slug + owner email alone
// (takeover fix): it emails the owner a one-time code and needs it back as
// email_code. The tool must pass that code through and explain the first step.

vi.mock("../services/api.js", () => ({ apiCall: vi.fn() }));
vi.mock("../services/credentials.js", () => ({ storeCredentials: vi.fn() }));

import { apiCall } from "../services/api.js";
import { reconnectTool } from "../tools/reconnect.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function getHandler(): { handler: Handler; schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } {
  let handler: Handler | null = null;
  let schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {};
  const fakeServer = {
    tool: (...args: unknown[]) => {
      schema = args[2] as typeof schema;
      handler = args[args.length - 1] as Handler;
    },
  };
  reconnectTool(fakeServer as never, { configured: false } as never);
  return { handler: handler!, schema };
}

beforeEach(() => vi.mocked(apiCall).mockReset());

describe("openbotcity_reconnect with the owner's email", () => {
  it("first call: tells the agent a code was emailed and how to finish", async () => {
    vi.mocked(apiCall).mockResolvedValue({ success: false, code_sent: true, error: "Check the owner's email." });
    const { handler } = getHandler();
    const out = await handler({ slug: "VeeBot", email: "Owner@Example.com" });
    expect(vi.mocked(apiCall).mock.calls[0][1]).toEqual({ method: "POST", body: { slug: "veebot", email: "owner@example.com" } });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("email_code");
    expect(text).not.toContain("Reconnected");
    expect(text).toContain("Do NOT fall back to openbotcity_register");
  });

  it("second call: sends email_code (digits only) and reconnects", async () => {
    vi.mocked(apiCall).mockResolvedValue({ jwt: "fresh-jwt", bot_id: "b1", slug: "veebot", display_name: "VeeBot" });
    const { handler } = getHandler();
    const out = await handler({ slug: "veebot", email: "owner@example.com", email_code: "1234-5678" });
    expect(vi.mocked(apiCall).mock.calls[0][1]).toEqual({
      method: "POST",
      body: { slug: "veebot", email: "owner@example.com", email_code: "12345678" },
    });
    expect(out.content[0].text).toContain('Reconnected as "VeeBot"');
  });

  it("the email_code argument only accepts 8 digits", () => {
    const { schema } = getHandler();
    expect(schema.email_code.safeParse("1234-5678").success).toBe(true);
    expect(schema.email_code.safeParse("12345678").success).toBe(true);
    expect(schema.email_code.safeParse("abcd").success).toBe(false);
  });
});
