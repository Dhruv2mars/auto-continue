/**
 * Round-2 hostile e2e repro: probe give-up must release the arm and refund
 * the arm-time budget. All state stays in a temp AUTO_CONTINUE_HOME; never
 * touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let origEnv;

function cliPath() {
  return new URL("../core/cli.mjs", import.meta.url).pathname;
}

function runCli(argLine, extraEnv = {}) {
  return spawnSync("node", [cliPath(), ...argLine], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home, ...extraEnv },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

function out(p) {
  try {
    return JSON.parse(p.stdout.toString().trim().split("\n").pop());
  } catch {
    return {};
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-gv-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  for (const k of Object.keys(process.env)) {
    if (/^AUTO_CONTINUE_(PROBE|RESUME_CMD)/.test(k)) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AUTO_CONTINUE_")) delete process.env[k];
  }
  Object.assign(process.env, origEnv);
  if (home) rmSync(home, { recursive: true, force: true });
});

async function until(fn, tries, everyMs) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

describe("round-2: probe give-up releases the arm and refunds budget", () => {
  test("limit event after give-up re-arms immediately; state refunded", async () => {
    const sid = "gv1";
    // Probe always fails, backoff 1s x3 -> give up in ~3-4s. Queue must stay
    // intact, and once the watcher exits, the next limit event re-arms at once.
    const env = {
      AUTO_CONTINUE_MIN_DELAY: "1",
      AUTO_CONTINUE_MAX_WAIT: "60",
      AUTO_CONTINUE_PROBE_BACKOFF: "1 1 1",
      AUTO_CONTINUE_PROBE_CMD_CLAUDE: "exit 1",
      AUTO_CONTINUE_RESUME_CMD_CLAUDE: `cat > ${home}/delivered.log`,
    };
    const e = out(runCli(["enqueue", sid, "doomed"], env));
    expect(e.armed).toBe(true);
    // Wait for give-up in the resume log.
    let logFile = "";
    const gaveUp = await until(async () => {
      const dir = join(home, "resumes");
      if (!existsSync(dir)) return false;
      for (const f of readdirSync(dir)) {
        const txt = readFileSync(join(dir, f), "utf8");
        if (txt.includes("giving up")) {
          logFile = join(dir, f);
          return true;
        }
      }
      return false;
    }, 100, 100);
    expect(gaveUp).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("queue left intact");

    // Give-up released the arm: status shows watcher not armed, budget refunded.
    const st = out(runCli(["status", sid], env));
    expect(st.watcherArmed).toBe(false);
    expect(st.continues).toBe(0);
    expect(st.dailyResumes).toBe(0);

    // Queue intact: the prompt is still at the head.
    const listed = out(runCli(["list", sid], env));
    expect(Array.isArray(listed) && listed[0]?.prompt === "doomed").toBe(true);

    // A real limit event now re-arms immediately (previously blocked 120s by
    // the stale watcherArmedAt). The limit hook takes the resume_later path;
    // with the probe still failing it cannot spawn a *delivering* watcher, but
    // the key assertion is that the dedupe guard no longer reports
    // "watcher already armed".
    const fixture = join(home, "limit.json");
    writeFileSync(
      fixture,
      JSON.stringify({ session_id: sid, hook_event_name: "Stop", last_assistant_message: "usage limit reached; try again later" }),
    );
    const hookProc = runCli(["claude", "stop", "--fixture", fixture], env);
    expect(hookProc.status).toBe(0);
    const stderr = hookProc.stderr.toString();
    expect(stderr).not.toContain("watcher already armed");
  }, 20000);
});
