import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;

const CLI = join(import.meta.dir, "..", "core", "cli.mjs");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-qcli-"));
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  delete process.env.AUTO_CONTINUE_MIN_DELAY;
  delete process.env.AUTO_CONTINUE_RESUME;
  delete process.env.AUTO_CONTINUE_RESUME_CMD_CLAUDE;
  rmSync(home, { recursive: true, force: true });
});

function runCli(args, extraEnv = {}) {
  return Bun.spawnSync(["node", CLI, ...args], {
    env: { ...process.env, ...extraEnv },
    cwd: import.meta.dir,
  });
}

function out(proc) {
  return JSON.parse(proc.stdout.toString());
}

function waitFor(path, ms = 5000) {
  const start = Date.now();
  return (async () => {
    while (!existsSync(path)) {
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
}

describe("queue cli", () => {
  test("enqueue stores + arms, list shows, clear drops", () => {
    const e = runCli(["enqueue", "q1", "hello", "world"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" });
    expect(e.exitCode).toBe(0);
    const body = out(e);
    expect(body.armed).toBe(true);
    expect(body.session).toBe("q1");
    expect(body.queued).toBe(1);

    const l = runCli(["list", "q1"]);
    expect(l.exitCode).toBe(0);
    const items = out(l);
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe("hello world");

    const c = runCli(["clear", "q1"]);
    expect(c.exitCode).toBe(0);
    expect(out(c)).toEqual({ session: "q1", cleared: 1 });
    expect(out(runCli(["list", "q1"]))).toEqual([]);
  });

  test("enqueue empty prompt prints armed false + reason", () => {
    const e = runCli(["enqueue", "q-empty", "   "]);
    expect(e.exitCode).toBe(0);
    const body = out(e);
    expect(body.armed).toBe(false);
    expect(body.reason).toMatch(/empty/);
  });

  test("dedupe window blocks second arm with ETA", () => {
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    expect(out(runCli(["enqueue", "q2", "first"], env)).armed).toBe(true);
    const second = out(runCli(["enqueue", "q2", "second"], env));
    expect(second.armed).toBe(false);
    expect(second.reason).toMatch(/already armed/);
    expect(second.reason).toMatch(/retry in \d+s/);
    expect(second.queued).toBe(2);
  });

  test("ceiling reached prints honest blocked reason", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      join(home, "state", "_global.json"),
      JSON.stringify({ day: new Date().toISOString().slice(0, 10), resumes: 999 }),
    );
    const e = out(runCli(["enqueue", "q3", "hi"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" }));
    expect(e.armed).toBe(false);
    expect(e.reason).toMatch(/ceiling/);
  });

  test("RESUME=0 prints honest blocked reason", () => {
    const e = out(runCli(["enqueue", "q4", "hi"], { AUTO_CONTINUE_RESUME: "0" }));
    expect(e.armed).toBe(false);
    expect(e.reason).toMatch(/AUTO_CONTINUE_RESUME=0/);
  });

  test("flags still work: --max-continues 0 blocks, --dry queues without arming", () => {
    const capped = out(
      runCli(["enqueue", "q5", "hi", "--max-continues", "0"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" }),
    );
    expect(capped.armed).toBe(false);
    expect(capped.reason).toMatch(/cap/);
    const dry = out(runCli(["enqueue", "q6", "hi", "--dry"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" }));
    expect(dry.armed).toBe(false);
    expect(dry.reason).toMatch(/dry run/);
    expect(out(runCli(["list", "q6"]))).toHaveLength(1);
  });

  test("drain sends queued text to fake resume cmd", async () => {
    const got = join(home, "got.txt");
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: `cat >> ${got}` };
    const e = out(runCli(["enqueue", "q7", "queued hello"], env));
    expect(e.armed).toBe(true);
    await waitFor(got);
    // Prompt reaches the resume command via stdin, never interpolated into the shell.
    expect(readFileSync(got, "utf8")).toContain("queued hello");
    expect(out(runCli(["list", "q7"]))).toEqual([]);
  });

  test("empty queue falls back to canned prompt", async () => {
    const got = join(home, "got2.txt");
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: `cat >> ${got}` };
    const e = out(runCli(["enqueue", "q8", "only one"], env));
    expect(e.armed).toBe(true);
    await waitFor(got);
    // Manually re-arm with an empty queue: hook path is covered by resume tests,
    // so exercise the drain helper directly for the fallback branch.
    const d = Bun.spawnSync(["node", join(import.meta.dir, "..", "core", "drain.mjs"), "q8"], {
      env: { ...process.env },
      cwd: import.meta.dir,
    });
    expect(d.exitCode).toBe(0);
    expect(d.stdout.toString()).toBe("");
  });
});
