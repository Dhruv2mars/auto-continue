import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;

const CLI = join(import.meta.dir, "..", "core", "cli.mjs");
const DRAIN_ACK = join(import.meta.dir, "..", "core", "drain-ack.mjs");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-wdef-"));
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

function waitFor(path, ms = 8000) {
  const start = Date.now();
  return (async () => {
    while (!existsSync(path)) {
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("watcher defects", () => {
  test("default template consumes the drained file (no custom RESUME_CMD)", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const got = join(home, "claude-args.txt");
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${got}\nexit 0\n`);
    chmodSync(fake, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    delete env.AUTO_CONTINUE_RESUME_CMD_CLAUDE;
    const e = out(runCli(["enqueue", "wdef1", "default-tpl-prompt-xyz"], env));
    expect(e.armed).toBe(true);
    await waitFor(got);
    expect(readFileSync(got, "utf8")).toContain("default-tpl-prompt-xyz");
  });

  test("default template is injection-safe (command substitution stays literal)", async () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const got = join(home, "claude-args2.txt");
    const pwned = join(home, "PWNED_WDEF");
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${got}\nexit 0\n`);
    chmodSync(fake, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const e = out(runCli(["enqueue", "wdef2", `hello"; $(touch ${pwned}) "`], env));
    expect(e.armed).toBe(true);
    await waitFor(got);
    expect(existsSync(pwned)).toBe(false);
    expect(readFileSync(got, "utf8")).toContain(`$(touch ${pwned})`);
  });

  test("watcher acks .draining only when resume exits 0", async () => {
    const { readDraining, list } = await import("../core/lib/queue.mjs");
    // Failing resume (exit nonzero): the settle helper restores the head to
    // the queue (.draining gone, prompt back at position 0) — never orphaned.
    const f = out(runCli(["enqueue", "wdef3", "must-restore"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "false" }));
    expect(f.armed).toBe(true);
    await sleep(3000);
    expect(await readDraining("wdef3")).toBeNull();
    const q = await list("wdef3");
    expect(q.length).toBe(1);
    expect(q[0].prompt).toBe("must-restore");
  }, 20000);

  test("drain-ack helper drops a pending head; true-resume watcher acks", async () => {
    const { enqueue, drainHead, readDraining, list } = await import("../core/lib/queue.mjs");
    await enqueue("wdef4", "ack-me");
    await drainHead("wdef4");
    const ack = Bun.spawnSync(["node", DRAIN_ACK, "wdef4"], { env: { ...process.env }, cwd: import.meta.dir });
    expect(ack.exitCode).toBe(0);
    expect(await readDraining("wdef4")).toBeNull();
    expect((await list("wdef4")).length).toBe(0);
    const s = out(runCli(["enqueue", "wdef5", "delivered"], { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" }));
    expect(s.armed).toBe(true);
    await sleep(3000);
    expect(await readDraining("wdef5")).toBeNull();
  }, 20000);

  test("overloaded continue_now never acks .draining; healthy stop does", async () => {
    const { enqueue, drainHead, readDraining } = await import("../core/lib/queue.mjs");
    const { saveState, loadState } = await import("../core/lib/state.mjs");
    await enqueue("test-session-overload", "inflight");
    await drainHead("test-session-overload");
    await saveState("test-session-overload", { continues: 1, watcherArmedAt: Date.now() });
    const ov = join(import.meta.dir, "fixtures", "stop-overloaded.json");
    const r = runCli(["claude", "stop", "--fixture", ov, "--dry"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).decision).toBe("block");
    expect((await readDraining("test-session-overload"))?.prompt).toBe("inflight");
    const healthy = join(home, "healthy.json");
    writeFileSync(healthy, JSON.stringify({
      session_id: "test-session-overload",
      hook_event_name: "Stop",
      last_assistant_message: "Done, all tests pass.",
    }));
    const h = runCli(["claude", "stop", "--fixture", healthy, "--dry"]);
    expect(h.exitCode).toBe(0);
    expect(await readDraining("test-session-overload")).toBeNull();
    expect((await loadState("test-session-overload")).continues).toBe(0);
  });

  test("second enqueue outside 120s but inside maxWait does not arm a second sleeper", async () => {
    const { enqueue } = await import("../core/lib/queue.mjs");
    const { saveState, loadState } = await import("../core/lib/state.mjs");
    const armedAt = Date.now() - 10 * 60 * 1000;
    await saveState("wdef6", { continues: 0, watcherArmedAt: armedAt });
    await enqueue("wdef6", "first");
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    const second = out(runCli(["enqueue", "wdef6", "second"], env));
    expect(second.armed).toBe(false);
    expect(second.reason).toMatch(/already queued/);
    expect(second.queued).toBe(2);
    expect((await loadState("wdef6")).watcherArmedAt).toBe(armedAt);
  });

  test("stale arm past maxWait with a single fresh prompt still arms", async () => {
    const { saveState } = await import("../core/lib/state.mjs");
    await saveState("wdef7", { continues: 0, watcherArmedAt: Date.now() - 10 * 60 * 1000 });
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    const e = out(runCli(["enqueue", "wdef7", "fresh"], env));
    expect(e.armed).toBe(true);
  });
});

describe("probe-before-send (round-2)", () => {
  test("dead probe re-arms, delivers once probe turns alive", async () => {
    const got = join(home, "got-flip.txt");
    const deadFlag = join(home, "dead-flag");
    writeFileSync(deadFlag, "1");
    const probeCmd = join(home, "flip-probe.sh");
    writeFileSync(probeCmd, `#!/bin/sh\n[ -f ${deadFlag} ] && exit 1\nexit 0\n`);
    chmodSync(probeCmd, 0o755);
    const env = {
      AUTO_CONTINUE_RESUME_CMD_CLAUDE: `cat >> ${got}`,
      AUTO_CONTINUE_PROBE_CMD_CLAUDE: probeCmd,
      AUTO_CONTINUE_PROBE_BACKOFF: "1 2 3",
    };
    const e = out(runCli(["enqueue", "pb-flip", "probe-flip-delivered"], env));
    expect(e.armed).toBe(true);
    await sleep(2000); // wake + dead probe #1 -> re-arm 1s
    rmSync(deadFlag);  // quota revives
    await waitFor(got, 10000);
    expect(readFileSync(got, "utf8")).toContain("probe-flip-delivered");
    expect(out(runCli(["list", "pb-flip"]))).toEqual([]);
  }, 20000);

  test("probe gives up after ladder; queue intact, nothing delivered", async () => {
    const got = join(home, "got-giveup.txt");
    const env = {
      AUTO_CONTINUE_RESUME_CMD_CLAUDE: `cat >> ${got}`,
      AUTO_CONTINUE_PROBE_CMD_CLAUDE: "exit 1",
      AUTO_CONTINUE_PROBE_BACKOFF: "1 1 1",
    };
    const e = out(runCli(["enqueue", "pb-giveup", "kept-safe"], env));
    expect(e.armed).toBe(true);
    await sleep(6000); // 3 x 1s backoff + probe runs
    expect(existsSync(got)).toBe(false);
    const items = out(runCli(["list", "pb-giveup"]));
    expect(items).toHaveLength(1);
    expect(items[0].prompt).toBe("kept-safe");
  }, 20000);
});
