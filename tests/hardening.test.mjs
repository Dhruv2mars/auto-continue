import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../core/lib/policy.mjs";

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-hard-"));
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  delete process.env.AUTO_CONTINUE_MIN_DELAY;
  delete process.env.AUTO_CONTINUE_RESUME_CMD_CLAUDE;
  rmSync(home, { recursive: true, force: true });
});

function runCli(fixturePath, extraEnv = {}) {
  return Bun.spawnSync(
    ["node", join(import.meta.dir, "..", "core", "cli.mjs"), "claude", "stop", "--fixture", fixturePath],
    { env: { ...process.env, ...extraEnv }, cwd: import.meta.dir },
  );
}

const retryFixture = join(import.meta.dir, "fixtures", "stop-retry-after.json");

describe("hardening", () => {
  test("hostile session id cannot inject through the resume watcher", async () => {
    const pwned = join(home, "pwned");
    const template = `echo resumed-"$1" >> ${join(home, "ok.txt")}`;
    const fixture = join(home, "hostile.json");
    writeFileSync(fixture, JSON.stringify({
      session_id: `x"; echo hacked >> ${pwned}; #`,
      hook_event_name: "Stop",
      last_assistant_message: "rate limit exceeded. Please try again in 1 seconds.",
    }));
    const r = runCli(fixture, { AUTO_CONTINUE_RESUME_CMD_CLAUDE: template });
    expect(r.exitCode).toBe(0);
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(pwned)).toBe(false);
    const okTxt = join(home, "ok.txt");
    expect(existsSync(okTxt)).toBe(true);
    expect(readFileSync(okTxt, "utf8")).toContain(`resumed-x"; echo hacked >> ${pwned}; #`);
    expect(readdirSync(join(home, "state")).some((f) => f.includes('"'))).toBe(false);
  });

  test("second resume within the dedupe window does not spawn another watcher", () => {
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    const first = runCli(retryFixture, env);
    const second = runCli(retryFixture, env);
    expect(first.stderr.toString()).not.toContain("already armed");
    expect(second.stderr.toString()).toContain("already armed");
  });

  test("healthy stop resets the continuation counter", () => {
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    runCli(retryFixture, env);
    runCli(retryFixture, env);
    const healthy = join(home, "healthy.json");
    writeFileSync(healthy, JSON.stringify({
      session_id: "test-session-retry",
      hook_event_name: "Stop",
      last_assistant_message: "Done, all tests pass.",
    }));
    const r = Bun.spawnSync(
      ["node", join(import.meta.dir, "..", "core", "cli.mjs"), "claude", "stop", "--fixture", healthy],
      { env: { ...process.env }, cwd: import.meta.dir },
    );
    expect(r.exitCode).toBe(0);
    const stateFile = readdirSync(join(home, "state")).find((f) => f.startsWith("test-session-retry"));
    const state = JSON.parse(readFileSync(join(home, "state", stateFile), "utf8"));
    expect(state.continues).toBe(0);
  });

  test("non-numeric env values fall back to safe defaults instead of disabling caps", () => {
    const rate = { kind: "rate_limit", retryAfterSec: null };
    const d = decide(rate, { continues: 99 }, { harness: "claude", maxContinues: Number.parseInt("abc", 10) });
    expect(d.action).toBe("give_up");
  });

  test("global daily resume ceiling blocks further spawns", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "_global.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), resumes: 999 }));
    const r = runCli(retryFixture, { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" });
    expect(r.stderr.toString()).toContain("ceiling");
  });
});
