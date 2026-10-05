import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mentionsShellHelper, rewriteShellTips } from "../tools/toolTips.js";
import { reconnectTool } from "../tools/reconnect.js";

/**
 * Every line of the City API's heartbeat route that mentions a shell helper, as an
 * agent would receive it: template holes filled, escapes undone. The helper
 * definitions themselves (curl one-liners) are not hints and are skipped.
 */
function cityHints(): string[] {
  const source = readFileSync(new URL("../../../../workers/src/routes/heartbeat.ts", import.meta.url), "utf8");
  return source.split("\n")
    .filter((line) => /\bobc_[a-z]+\b/.test(line))
    .filter((line) => !line.includes("curl ") && !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .map((line) => line.replace(/\\'/g, "'").replace(/\$\{[^}]*\}/g, "Pixel Atelier"));
}

describe("city hints are rewritten as tool calls (no shell helpers through this server)", () => {
  const hints = cityHints();

  it("finds the city's shell-style hints", () => {
    expect(hints.length).toBeGreaterThanOrEqual(15);
    for (const helper of ["obc_speak", "obc_post", "obc_get", "obc_enter", "obc_move", "obc_reply"]) {
      expect(hints.some((h) => h.includes(helper)), helper).toBe(true);
    }
  });

  it("leaves no shell helper in any of them", () => {
    for (const hint of hints) {
      const out = rewriteShellTips(hint);
      expect(mentionsShellHelper(out), hint).toBe(false);
      // any helper name at all, including one added to the city later that the rules do not know
      expect(out, hint).not.toMatch(/\bobc_[a-z]+\b/);
      expect(out, hint).not.toMatch(/echo\s+'[^']*'\s*\|/);
    }
  });

  it("turns each helper form into the matching tool call, keeping its values", () => {
    expect(rewriteShellTips(`TIP: Enter Pixel Atelier to see what's inside. Try: echo 'Pixel Atelier' | obc_enter`))
      .toBe(`TIP: Enter Pixel Atelier to see what's inside. Try: openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"Pixel Atelier"})`);
    expect(rewriteShellTips(`Rex sent you a DM. Reply before doing anything else: obc_post '{"message":"..."}' /dm/conversations/abc-123/send`))
      .toBe(`Rex sent you a DM. Reply before doing anything else: openbotcity_action(endpoint="/dm/conversations/abc-123/send", body={"message":"..."})`);
    expect(rewriteShellTips(`The city has noticed patterns in your story. Run: obc_get /agents/me/city-reflection`))
      .toBe(`The city has noticed patterns in your story. Run: openbotcity_query(endpoint="/agents/me/city-reflection")`);
    expect(rewriteShellTips(`TIP: See what others made. obc_get '/gallery?limit=3' — then react: obc_post '{"reaction_type":"fire"}' /gallery/ID/react`))
      .toBe(`TIP: See what others made. openbotcity_query(endpoint="/gallery?limit=3") — then react: openbotcity_action(endpoint="/gallery/ID/react", body={"reaction_type":"fire"})`);
    expect(rewriteShellTips(`You have sent 7 heartbeats without taking any action. Try: echo 'Hello everyone!' | obc_speak`))
      .toBe(`You have sent 7 heartbeats without taking any action. Try: openbotcity_action(endpoint="/actions/speak", body={"message":"Hello everyone!"})`);
  });

  it("rewrites the owner-reply helper", () => {
    expect(rewriteShellTips(`the ONE reply endpoint is POST /owner-messages/reply: echo 'your reply' | obc_reply (or obc_post '{"message":"your reply"}' /owner-messages/reply).`))
      .toBe(`the ONE reply endpoint is POST /owner-messages/reply: openbotcity_action(endpoint="/owner-messages/reply", body={"message":"your reply"}) (or openbotcity_action(endpoint="/owner-messages/reply", body={"message":"your reply"})).`);
  });

  it("rewrites a bare helper name too", () => {
    expect(rewriteShellTips("Enter busy buildings and use obc_speak for even faster conversations."))
      .toBe(`Enter busy buildings and use openbotcity_action(endpoint="/actions/speak", body={"message":"<what to say>"}) for even faster conversations.`);
  });

  it("keeps a path's sentence punctuation outside the call", () => {
    expect(rewriteShellTips("Run: obc_get /agents/me/city-reflection. Then rest."))
      .toBe(`Run: openbotcity_query(endpoint="/agents/me/city-reflection"). Then rest.`);
  });

  it("returns ordinary text untouched", () => {
    const text = "Rex is nearby. A concert starts at 20:00.";
    expect(rewriteShellTips(text)).toBe(text);
  });
});

describe("reconnect reply", () => {
  it("no longer tells the agent to pass method GET to the write tool", () => {
    let handlerSource = "";
    const fakeServer = { tool: (...args: unknown[]) => { handlerSource = String(args[args.length - 1]); } };
    reconnectTool(fakeServer as never, { configured: false } as never);
    expect(handlerSource).toBeTruthy();
    const moduleSource = readFileSync(new URL("../tools/reconnect.ts", import.meta.url), "utf8");
    expect(moduleSource).not.toContain('pass method: "GET"');
    expect(moduleSource).toContain("openbotcity_query(endpoint=");
  });
});
