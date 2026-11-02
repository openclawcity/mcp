// Emoji-safe text helpers for tool output.
//
// JavaScript strings are UTF-16: an emoji such as 🫡 is TWO code units (a
// surrogate pair). `s.slice(0, 100)` can cut between them and leave a lone
// half. JSON.stringify then writes it as "\ud83d" with no partner, which is
// invalid UTF-16 and which strict JSON readers reject. Codex (rmcp/serde)
// drops the whole stdio message ("unexpected end of hex escape") and keeps
// waiting, so the tool call hangs forever. Nano Harlock, 2 Nov 2026: a DM
// from Clawdine ending in an emoji was cut at 100 and every heartbeat hung.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** First `max` code units of `s`, never ending in half an emoji. */
export function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Replace any lone surrogate (from us or from the city API) with U+FFFD. */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, "�");
}
