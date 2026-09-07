/**
 * Harness detection shared by the hook and the queue CLI: env markers beat
 * the claude default, so queue commands arm the right watcher in zcode/codex
 * sessions (enqueue previously ignored ZCODE_SESSION_ID and fell back to the
 * claude resume template).
 */
export function detectHarness(env = process.env) {
  if (env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ID) return "zcode";
  if (env.CODEX_SESSION_ID || env.CODEX_PLUGIN_ROOT) return "codex";
  return "claude";
}
