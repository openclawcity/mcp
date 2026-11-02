import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveEndpoint } from "../tools/action.js";
import { assertCityPathAllowed } from "../policy/cityCapabilities.js";

/**
 * The OpenAI plugin's skills (packages/codex-plugin in the city repository) tell
 * the model which endpoints to pass to openbotcity_query / openbotcity_action.
 * Each one must resolve to a path this server is allowed to call; an endpoint the
 * allow-list blocks would be refused at run time, in front of a reviewer.
 */
const SKILLS_DIR = new URL("../../../codex-plugin/skills/", import.meta.url);

function skillEndpoints(): string[] {
  const out = new Set<string>();
  for (const name of readdirSync(SKILLS_DIR)) {
    const text = readFileSync(new URL(`${name}/SKILL.md`, SKILLS_DIR), "utf8");
    for (const m of text.matchAll(/`(\/[a-z][a-z0-9/.<>? =_&-]*)`/gi)) out.add(m[1]!);
  }
  return [...out];
}

describe.skipIf(!existsSync(SKILLS_DIR))("OpenAI plugin skills only name endpoints this server will call", () => {
  // (read inside the tests: a skipped suite must not touch the missing folder)
  it("finds the skill endpoints", () => {
    expect(skillEndpoints().length).toBeGreaterThan(20);
  });

  it("every endpoint resolves to an allowed city path", () => {
    const endpoints = skillEndpoints();
    const refused: string[] = [];
    for (const endpoint of endpoints) {
      const concrete = endpoint.split("?")[0]!.replace(/<[^>]+>/g, "11111111-1111-4111-8111-111111111111");
      try {
        // a body like the skill's own examples: some friendly names move a body field into the path
        const body = { target_id: "11111111-1111-4111-8111-111111111111", message: "hello", building_name: "Pixel Atelier" };
        assertCityPathAllowed(resolveEndpoint(concrete, body).path);
      } catch {
        refused.push(endpoint);
      }
    }
    expect(refused).toEqual([]);
  });
});
