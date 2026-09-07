/**
 * Round-5 hostile e2e repros: lock liveness, clear serialization, and
 * giveup ownership. All state stays in a temp AUTO_CONTINUE_HOME; never
 * touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withQueueLock, enqueue, listQueue } from "../core/lib/queue.mjs";

let home;
let origEnv;

function cliPath() {
  return new URL("../core/cli.mjs", import.meta.url).pathname;
}

function settleCli(sessionId, mode = "", arg4 = "", arg5 = "") {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain-settle.mjs"), sessionId, mode, arg4, arg5].filter((x) => x !== ""), {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-r5-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_RESUME = "0";
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

describe("round-5: lock liveness", () => {
  test("a live holder keeps the lock; a dead holder's lock is stolen", async () => {
    const sid = "lock1";
    // Live holder runs 1.5s; a second contender must NOT steal mid-flight.
    let holderDone = false;
    const holder = withQueueLock(sid, async () => {
      await new Promise((r) => setTimeout(r, 1500));
      holderDone = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(holderDone).toBe(false);
    const contender = withQueueLock(sid, async () => "contended");
    const raceResult = await Promise.race([
      contender.then(() => "early"),
      new Promise((r) => setTimeout(() => r("late"), 700)),
    ]);
    expect(raceResult).toBe("late"); // did not steal from the live holder
    await holder;
    expect(await contender).toBe("contended"); // ran after release

    // Dead holder: write a lock file with a dead pid -> steal succeeds.
    const lockPath = join(home, "queue", "lock1.lock");
    writeFileSync(lockPath, "99999999"); // pid that does not exist
    const got = await withQueueLock(sid, async () => "stolen");
    expect(got).toBe("stolen");
  });

  test("contention timeout fails loudly instead of writing unlocked", async () => {
    const sid = "lock2";
    // Lock held by a live process that never releases within the window.
    const { spawn } = await import("node:child_process");
    const child = spawn("node", ["-e", `const {withQueueLock}=await import(${JSON.stringify(join(import.meta.dir, "..", "core", "lib", "queue.mjs"))});await withQueueLock("lock2",()=>new Promise(r=>setTimeout(r,15000)))`], {
      env: { ...process.env, AUTO_CONTINUE_HOME: home },
      stdio: "ignore",
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 600));
    try {
      await expect(withQueueLock(sid, async () => "never")).rejects.toThrow(/queue busy/);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }, 15000);
});

describe("round-5: clear serialization", () => {
  test("clear serializes with enqueue: final state is exactly one writer's", async () => {
    const sid = "clr1";
    await enqueue(sid, "one");
    await enqueue(sid, "two");
    // Concurrent clear + enqueue: both take the lock, so the loser's write
    // cannot land inside the winner's critical section — the final queue is
    // whatever the LAST serialized writer made, never a half-merge.
    const clearProc = spawn("node", [cliPath(), "clear", sid], {
      env: { ...process.env, AUTO_CONTINUE_HOME: home },
      cwd: import.meta.dir,
      stdio: "ignore",
    });
    await enqueue(sid, "three");
    await new Promise((r) => {
      clearProc.once("exit", r);
      setTimeout(r, 6000); // contention with our own process cannot deadlock here
    });
    const q = await listQueue(sid);
    // Either clear won (0) or the enqueue won (1 with "three") — never both
    // merged (2-3 items) and never "one"/"two" resurrected.
    expect(q.length === 0 || (q.length === 1 && q[0].prompt === "three")).toBe(true);
  });
});

describe("round-5: giveup ownership token", () => {
  test("giveup refunds only its own arm; a newer arm's state survives", async () => {
    const sid = "gv-tok";
    const stateDir = join(home, "state");
    const stateFile = join(stateDir, `${sid}.json`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    // Arm 1: armedAt=1000, continuesBefore=0 -> bump wrote continues=1.
    writeFileSync(stateFile, JSON.stringify({ continues: 1, watcherArmedAt: 1000, updatedAt: 0 }));
    // Arm 2 supersedes: armedAt=2000, continues=2 (its own bump).
    writeFileSync(stateFile, JSON.stringify({ continues: 2, watcherArmedAt: 2000, updatedAt: 0 }));
    // Arm 1's watcher gives up late: token says armedAt=1000, before=0.
    settleCli(sid, "giveup", "1000:0");
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    // Arm 2's bookkeeping untouched (stale giveup must not steal it).
    expect(st.watcherArmedAt).toBe(2000);
    expect(st.continues).toBe(2);
    // Arm 2's own giveup: refunds its bump, clears its arm.
    settleCli(sid, "giveup", "2000:1");
    const st2 = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(st2.watcherArmedAt).toBe(0);
    expect(st2.continues).toBe(1);
  });
});

describe("round-6: settle ownership", () => {
  test("foreign settle (stale token) no-ops; own settle-fail releases the arm", async () => {
    const sid = "own-settle";
    const { drainHead, readDraining, restoreDrainingUnlocked, listQueue } = await import("../core/lib/queue.mjs");
    const { saveState, loadState } = await import("../core/lib/state.mjs");
    const { promptFingerprint } = await import("../core/lib/queue.mjs");
    await enqueue(sid, "OWNED-HEAD");
    const head = await drainHead(sid);
    expect(head.prompt).toBe("OWNED-HEAD");
    // Arm 1 owns the delivery; marker stamped at wake (ts >= armedAt).
    const tok1 = await armToken(sid, 0);
    settleCli(sid, "begin", promptFingerprint("OWNED-HEAD"), tok1);
    // Arm 2 supersedes (real limit event re-armed): state now arm 2's, and
    // arm 2's own wake re-stamped the marker (newer stamp, its ownership).
    const armedAt2 = Date.now();
    await saveState(sid, { continues: 1, watcherArmedAt: armedAt2, updatedAt: 0 });
    settleCli(sid, "begin", promptFingerprint("OWNED-HEAD"), `${armedAt2}:1`);
    // Arm 1's late FAIL settle must NOT restore arm 2's head or release arm 2.
    settleCli(sid, "fail", "", tok1);
    expect(await readDraining(sid)).not.toBeNull();
    const st = await loadState(sid);
    expect(st.watcherArmedAt).toBe(armedAt2);
    // Arm 2's own fail settle: restores the head AND releases its own arm.
    settleCli(sid, "fail", "", `${armedAt2}:1`);
    expect(await readDraining(sid)).toBeNull();
    expect((await listQueue(sid)).length).toBe(1);
    const st2 = await loadState(sid);
    expect(st2.watcherArmedAt).toBe(0);
  });
});

async function armToken(sid, continues) {
  const { saveState } = await import("../core/lib/state.mjs");
  const armedAt = Date.now();
  await saveState(sid, { continues, watcherArmedAt: armedAt, updatedAt: 0 });
  return `${armedAt}:${continues}`;
}
