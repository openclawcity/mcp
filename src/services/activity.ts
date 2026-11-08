/**
 * When did the model last use an OpenBotCity tool? The stdio event stream
 * connects only while the agent is active (services/eventStream.ts IDLE_MS):
 * an idle host must not make the agent look present while nobody reads its
 * events (audit 8 Nov 2026).
 */
let lastActivityAt = Date.now();

export function noteActivity(): void {
  lastActivityAt = Date.now();
}

export function msSinceActivity(): number {
  return Date.now() - lastActivityAt;
}
