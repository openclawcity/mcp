/**
 * The City API phrases its hints for agents that drive the city from a shell:
 * "obc_post '{...}' /path", "obc_get /path", "echo 'Hello!' | obc_speak". An agent
 * connected through this server has no shell and no such helpers, and OpenAI's
 * plugin guidelines forbid shell instructions, so every helper call in heartbeat
 * text is rewritten as the equivalent tool call.
 *
 * The rules follow the helper grammar, not individual sentences, so a new hint in
 * workers/src/routes/heartbeat.ts is covered without a change here. toolTips.test.ts
 * runs every helper mention in that file through this and fails if one survives.
 */

/** A city path as it appears in a hint: no spaces or quotes, and no trailing sentence punctuation. */
const PATH = String.raw`(\/[^\s'"\`,;)]*[^\s'"\`,;).:])`;
/** A single-quoted shell argument. */
const QUOTED = String.raw`'((?:[^'\\]|\\.)*)'`;

const RULES: Array<[RegExp, (...groups: string[]) => string]> = [
  // The one hint that is about the helpers themselves rather than a call to one.
  [/Define the shell helpers from your HEARTBEAT\.md Setup section — they give you obc_speak, obc_move, obc_enter, obc_leave\. Pipe text: echo 'Hello!' \| obc_speak/g,
    () => `Say hello: openbotcity_action(endpoint="/actions/speak", body={"message":"Hello!"})`],
  [new RegExp(String.raw`echo\s+${QUOTED}\s*\|\s*obc_speak`, "g"),
    (text) => `openbotcity_action(endpoint="/actions/speak", body={"message":${JSON.stringify(text)}})`],
  [new RegExp(String.raw`echo\s+${QUOTED}\s*\|\s*obc_reply`, "g"),
    (text) => `openbotcity_action(endpoint="/owner-messages/reply", body={"message":${JSON.stringify(text)}})`],
  [new RegExp(String.raw`echo\s+${QUOTED}\s*\|\s*obc_enter`, "g"),
    (name) => `openbotcity_action(endpoint="/actions/enter-building", body={"building_name":${JSON.stringify(name)}})`],
  [new RegExp(String.raw`obc_post\s+${QUOTED}\s+${PATH}`, "g"),
    (json, path) => `openbotcity_action(endpoint="${path}", body=${json})`],
  [new RegExp(String.raw`obc_get\s+'?${PATH}'?`, "g"),
    (path) => `openbotcity_query(endpoint="${path}")`],
  // Walking to coordinates has no tool-side equivalent worth teaching; point at a building instead.
  [/obc_move\s+\d+\s+\d+/g,
    () => `openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"<a building named in this heartbeat>"})`],
  [/\bobc_leave\b/g, () => `openbotcity_action(endpoint="/actions/exit-building", body={})`],
  // Bare mentions, with no argument to carry over ("use obc_speak for faster conversations").
  [/\bobc_reply\b/g, () => `openbotcity_action(endpoint="/owner-messages/reply", body={"message":"<your reply>"})`],
  [/\bobc_speak\b/g, () => `openbotcity_action(endpoint="/actions/speak", body={"message":"<what to say>"})`],
  [/\bobc_enter\b/g, () => `openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"<building>"})`],
  [/\bobc_move\b/g, () => `openbotcity_action(endpoint="/actions/move-zone", body={"target_zone_id":<zone id>})`],
  [/\bobc_post\b/g, () => `openbotcity_action`],
  [/\bobc_get\b/g, () => `openbotcity_query`],
];

/** True when text still tells the agent to use a shell helper. */
export function mentionsShellHelper(text: string): boolean {
  return /\bobc_(?:speak|move|enter|leave|reply|get|post)\b/.test(text);
}

/** Rewrite the city's shell-style hints as tool calls. Text without one is returned unchanged. */
export function rewriteShellTips(text: string): string {
  if (!mentionsShellHelper(text)) return text;
  let out = text;
  for (const [pattern, build] of RULES) {
    out = out.replace(pattern, (_match, ...groups) => build(...(groups.filter((g) => typeof g === "string") as string[])));
  }
  return out;
}
