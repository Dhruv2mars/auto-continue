/**
 * Round-2 hostile e2e repro: healthy-stop ack cannot orphan an in-flight
 * delivery. All state stays in a temp AUTO_CONTINUE_HOME; never touches
 * ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, listQueue, readDraining } from "../core/lib/queue.mjs";

let home;
let origEnv;

function cliPath() {
  return new URL("../core/cli.mjs", import.meta.url).pathname;
}

// Bun test does not reliably forward process.env mutations made after start
// to spawnSync children — pass the env explicitly (a missing AUTO_CONTINUE_HOME
// here once leaked a watcher onto the real ~/.auto-continue). node's
// spawnSync is used because Bun's killable process-group semantics can reap
// the hook's detached watcher grandchild before it fires.
function runCli(fixturePath) {
  return spawnSync("node", [cliPath(), "claude", "stop", "--fixture", fixturePath], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

async function until(fn, { tries, everyMs }) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-r2-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
  process.env.AUTO_CONTINUE_MAX_WAIT = "3";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AUTO_CONTINUE_")) delete process.env[k];
  }
  Object.assign(process.env, origEnv);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("round-2: healthy-stop ack cannot orphan an in-flight delivery", () => {
  test("mid-flight healthy stop does not ack the head; failed resume restores it", async () => {
    const sid = "sw-race";
    const queueDir = join(home, "queue");
    await enqueue(sid, "doomed-prompt");
    // Arm the watcher via the hook resume_later path (limit payload); the
    // resume is slow and failing so the healthy stop below deterministically
    // lands mid-delivery.
    process.env.AUTO_CONTINUE_RESUME_CMD_CLAUDE = `sleep 2; exit 7`;
    const limitPayload = JSON.stringify({
      session_id: sid,
      hook_event_name: "Stop",
      last_assistant_message: "usage limit reached; try again later",
    });
    await Bun.write(join(home, "limit.json"), limitPayload);
    const proc1 = runCli(join(home, "limit.json"));
    expect(proc1.status).toBe(0);

    // Watcher woke, drained the head to .draining, resume now sleeping.
    const drained = await until(async () => !!(await readDraining(sid)), { tries: 40, everyMs: 100 });
    expect(drained).toBe(true);
    // Settling marker up (delivery in flight) and head off the queue.
    const settling = await until(() => existsSync(join(queueDir, `sw-race.settling`)), { tries: 60, everyMs: 50 });
    expect(settling).toBe(true);
    expect((await listQueue(sid)).length).toBe(0);

    // Healthy stop lands while the resume is still in flight.
    const healthyPayload = JSON.stringify({
      session_id: sid,
      hook_event_name: "Stop",
      last_assistant_message: "done.",
    });
    await Bun.write(join(home, "healthy.json"), healthyPayload);
    const proc2 = runCli(join(home, "healthy.json"));
    expect(proc2.status).toBe(0);

    // Mid-flight: the head must NOT be acked by the hook (settling marker up),
    // and once the resume exits 7, the settle helper must restore it.
    const restored = await until(async () => {
      const q = await listQueue(sid);
      return q.length === 1 && q[0].prompt === "doomed-prompt" && !(await readDraining(sid));
    }, { tries: 60, everyMs: 100 });
    expect(restored).toBe(true);
  }, 15000);
});
