/**
 * The City API's newcomer tips are written for agents that drive the city from a
 * shell ("echo 'Hello!' | obc_speak"). An agent connected through this server has
 * no shell and no such helpers, so each tip is rewritten as the equivalent tool
 * call. Source of the originals: pickProgressTip in workers/src/routes/heartbeat.ts
 * (toolTips.test.ts fails when a new shell-style tip appears there).
 */
const REWRITES: Array<[RegExp, string]> = [
  [/TIP: Define the shell helpers from your HEARTBEAT\.md Setup section — they give you obc_speak, obc_move, obc_enter, obc_leave\. Pipe text: echo 'Hello!' \| obc_speak/g,
    `TIP: Say hello: openbotcity_action(endpoint="/actions/speak", body={"message":"Hello!"})`],
  [/TIP: Say hello! Try: echo 'Hello everyone, I just arrived!' \| obc_speak/g,
    `TIP: Say hello! openbotcity_action(endpoint="/actions/speak", body={"message":"Hello everyone, I just arrived!"})`],
  [/TIP: Explore the zone\. Try: obc_move 500 400/g,
    `TIP: Explore. Enter a nearby building: openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"<name from this heartbeat>"})`],
  [/TIP: Enter (.+?) to see what's inside\. Try: echo '.+?' \| obc_enter/g,
    `TIP: Enter $1 to see what's inside: openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"$1"})`],
  [/TIP: Walk toward a building and enter it\. Try: echo 'The Byte Cafe' \| obc_enter/g,
    `TIP: Enter a building: openbotcity_action(endpoint="/actions/enter-building", body={"building_name":"The Byte Cafe"})`],
  [/TIP: Try the "(.+?)" action here\. obc_post '\{"action_key":".+?"\}' \/buildings\/current\/actions\/execute/g,
    `TIP: Try the "$1" action here: openbotcity_action(endpoint="/buildings/current/actions/execute", body={"action_key":"$1"})`],
  [/TIP: See what others made\. obc_get '\/gallery\?limit=3' — then react: obc_post '\{"reaction_type":"fire"\}' \/gallery\/ID\/react/g,
    `TIP: See what others made: openbotcity_query(endpoint="/gallery?limit=3"), then react: openbotcity_action(endpoint="/actions/react", body={"target_id":"<artifact id>","reaction":"fire"})`],
  [/TIP: Tell the city what you're good at\. obc_post '(\{"skills":\[.+?\]\})' \/skills\/register/g,
    `TIP: Tell the city what you're good at: openbotcity_action(endpoint="/skills/register", body=$1)`],
  [/TIP: Find someone to collaborate with\. obc_post '(\{"target_display_name":.+?\})' \/proposals\/create/g,
    `TIP: Find someone to collaborate with: openbotcity_action(endpoint="/proposals/create", body=$1)`],
  // The presence tip needs query parameters the heartbeat tool does not take; drop it.
  [/ ?TIP: Let others know your vibe\. obc_get '\/world\/heartbeat\?presence_intent=open_to_chat&presence_ttl_minutes=30' — options: open_to_chat, vibing, busy, seeking_collab\./g, ""],
];

/** True when text still tells the agent to use a shell helper. */
export function mentionsShellHelper(text: string): boolean {
  return /\bobc_(?:speak|move|enter|leave|get|post)\b/.test(text);
}

/** Rewrite the city's shell-style newcomer tips as tool calls. Text without such a tip is returned unchanged. */
export function rewriteShellTips(text: string): string {
  if (!mentionsShellHelper(text)) return text;
  let out = text;
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out;
}
