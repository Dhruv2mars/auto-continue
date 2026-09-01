import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-resume-"));
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  delete process.env.AUTO_CONTINUE_MIN_DELAY;
  rmSync(home, { recursive: true, force: true });
});

const fixture = join(import.meta.dir, "fixtures", "stop-retry-after.json");

function runCli(extraEnv = {}) {
  return Bun.spawnSync(
    ["node", join(import.meta.dir, "..", "core", "cli.mjs"), "claude", "stop", "--fixture", fixture],
    { env: { ...process.env, ...extraEnv }, cwd: import.meta.dir },
  );
}

describe("detached resume watcher", () => {
  test("spawns a resume command that runs after the delay", async () => {
    const stamp = join(home, "resumed.txt");
    const r = runCli({
      AUTO_CONTINUE_RESUME_CMD_CLAUDE: `echo resumed-{session_id} >> ${stamp}`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    for (let i = 0; i < 40 && !existsSync(stamp); i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(existsSync(stamp)).toBe(true);
    expect(readFileSync(stamp, "utf8")).toContain(`resumed-test-session-retry`);
    const log = readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.at(-1).action).toBe("resume_later");
  });

  test("AUTO_CONTINUE_RESUME=0 disables spawning", async () => {
    const stamp = join(home, "resumed.txt");
    const r = runCli({ AUTO_CONTINUE_RESUME: "0", AUTO_CONTINUE_RESUME_CMD_CLAUDE: `echo x >> ${stamp}` });
    expect(r.exitCode).toBe(0);
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(stamp)).toBe(false);
  });

  test("state records the continuation after spawn", () => {
    runCli({ AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" });
    const dir = join(home, "state");
    expect(readdirSync(dir).filter((f) => !f.endsWith(".tmp")).length).toBe(1);
  });
});
