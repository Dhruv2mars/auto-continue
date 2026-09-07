#!/usr/bin/env node
/**
 * Quota probe for the resume watcher. Usage: node core/probe.mjs <harness>
 * Exit 0 = quota alive, exit 1 = still limited (or probe failed / unavailable
 * -> watcher re-arms; conservative: never send into a dead quota).
 * Override for tests/isolation: AUTO_CONTINUE_PROBE_CMD_<HARNESS> (uppercased
 * harness). A failing/unset probe command counts as alive=false when the
 * command itself fails, dead when it exits 0.
 */
import { spawnSync } from "node:child_process";

const harness = String(process.argv[2] ?? "claude").toLowerCase();

/**
 * @returns {{alive: boolean, source: string, detail?: string}}
 */
function probe(h) {
  const custom = process.env[`AUTO_CONTINUE_PROBE_CMD_${h.toUpperCase()}`];
  if (custom) {
    const r = spawnSync("/bin/sh", ["-c", custom], { timeout: 30000, encoding: "utf8" });
    if (r.error || r.status !== 0) return { alive: false, source: "custom", detail: String(r.stderr || r.error || `exit ${r.status}`) };
    return { alive: true, source: "custom" };
  }
  // Built-in probe: a 1-token ping through the real CLI is the only honest
  // check that the model call itself succeeds. Conservative default.
  if (h === "claude") {
    const bin = process.env.AUTO_CONTINUE_CLAUDE_BIN || "claude";
    const r = spawnSync(bin, ["-p", "Reply with the single word: OK"], {
      timeout: 60000,
      encoding: "utf8",
    });
    if (r.error) return { alive: false, source: "builtin", detail: String(r.error) };
    // Dead quota: claude CLI exits nonzero on limit errors.
    if (r.status !== 0) return { alive: false, source: "builtin", detail: (r.stderr || "").slice(0, 200) };
    const out = (r.stdout || "").toLowerCase();
    // Limit wording in a successful exit still means limited (CLI quirk).
    if (/limit|429|overload/.test(out)) return { alive: false, source: "builtin", detail: out.slice(0, 200) };
    return { alive: true, source: "builtin" };
  }
  // No built-in probe for other harnesses yet: report unavailable.
  return { alive: false, source: "unavailable" };
}

const result = probe(harness);
if (result.alive) {
  process.stdout.write(`probe: alive (${result.source})\n`);
  process.exit(0);
}
process.stderr.write(`probe: limited or unavailable (${result.source})${result.detail ? `: ${result.detail}` : ""}\n`);
process.exit(1);
