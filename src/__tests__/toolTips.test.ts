import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mentionsShellHelper, rewriteShellTips } from "../tools/toolTips.js";
import { reconnectTool } from "../tools/reconnect.js";

/** Every tip template in the City API's pickProgressTip, with template holes filled. */
function cityTips(): string[] {
  const source = readFileSync(new URL("../../../../workers/src/routes/heartbeat.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function pickProgressTip(");
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  const body = source.slice(start, end);
  const tips: string[] = [];
  for (const m of body.matchAll(/return (['`])(TIP: (?:\\.|(?!\1).)*)\1;/g)) {
    tips.push(m[2]!.replace(/\\'/g, "'").replace(/\$\{building\}/g, "Pixel Atelier").replace(/\$\{action\}/g, "paint"));
  }
  return tips;
}

describe("city newcomer tips are rewritten as tool calls (no shell helpers through this server)", () => {
  const tips = cityTips();

  it("finds the city's tip templates", () => {
    expect(tips.length).toBeGreaterThanOrEqual(10);
    expect(tips.some((t) => t.includes("obc_speak"))).toBe(true);
  });

  it("leaves no shell helper in any tip, wherever it sits in the bulletin", () => {
    for (const tip of tips) {
      const bulletin = `3 quests available. ${tip} The city is voting: "Build a hospital".`;
      const out = rewriteShellTips(bulletin);
      expect(mentionsShellHelper(out), tip).toBe(false);
      expect(out, tip).not.toMatch(/echo '|\| obc_/);
      expect(out.startsWith("3 quests available.")).toBe(true);
      expect(out.endsWith('The city is voting: "Build a hospital".')).toBe(true);
    }
  });

  it("keeps the tip's own values", () => {
    const out = rewriteShellTips(`TIP: Enter Pixel Atelier to see what's inside. Try: echo 'Pixel Atelier' | obc_enter`);
    expect(out).toBe(`TIP: Enter Pixel Atelier to see what's inside: openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"Pixel Atelier"})`);
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
