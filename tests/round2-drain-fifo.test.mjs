/**
 * Round-2 hostile e2e repro: a wake with a pending .draining item (previous
 * watcher crashed mid-send) must restore it and drain FIFO, not fall back to
 * the canned prompt while real prompts sit queued. Round-4 update: drain is
 * ownership-aware, so each wake must clear the previous wake's settling
 * marker first (a live marker = another watcher owns the delivery). All
 * state stays in a temp AUTO_CONTINUE_HOME; never touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, drainHead, listQueue, readDraining } from "../core/lib/queue.mjs";

let home;
let origEnv;

function drainCli(sessionId, armedAtTok = "") {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain.mjs"), sessionId, armedAtTok].filter((x) => x !== ""), {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

function settleCli(sessionId, mode = "", arg4 = "", arg5 = "") {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain-settle.mjs"), sessionId, mode, arg4, arg5].filter((x) => x !== ""), {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

// Arm state like cli.mjs does, then settle as the owning watcher would.
async function armForSettle(sid, continues = 0) {
  const { saveState } = await import("../core/lib/state.mjs");
  const armedAt = Date.now();
  await saveState(sid, { continues, watcherArmedAt: armedAt, updatedAt: 0 });
  return `${armedAt}:${continues}`;
}

function markerPath(sid) {
  return join(home, "queue", `${sid}.settling`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-dr-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AUTO_CONTINUE_")) delete process.env[k];
  }
  Object.assign(process.env, origEnv);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("round-2: wake with pending .draining restores FIFO", () => {
  test("drain.mjs restores a crashed head and drains in FIFO order", async () => {
    const sid = "dr1";
    await enqueue(sid, "interrupted-prompt-xyz");
    // Simulate watcher 1 crash mid-send: head moved to .draining, never acked.
    const head = await drainHead(sid);
    expect(head.prompt).toBe("interrupted-prompt-xyz");
    // A second prompt is enqueued and a new watcher arms + wakes. Arm state
    // like cli.mjs does (the ownership token must predate the wake's marker
    // stamp, as in the real chain).
    await enqueue(sid, "second-prompt");
    const tok = await armForSettle(sid);

    // Wake 1: the interrupted head must come out first (not canned fallback).
    const d1 = drainCli(sid, tok.split(":")[0]);
    expect(d1.status).toBe(0);
    expect(d1.stdout.toString()).toBe("interrupted-prompt-xyz");
    expect(await readDraining(sid)).not.toBeNull();

    // The resume exits 0 -> settle acks (and clears the marker); wake 2
    // delivers the second prompt. Settles carry the arm token (real-chain
    // ownership) via the persisted armedAt.
    await settleCli(sid, "success", "", tok);
    const d2 = drainCli(sid, tok.split(":")[0]);
    expect(d2.stdout.toString()).toBe("second-prompt");
    await settleCli(sid, "success", "", tok);

    // Genuinely empty queue: empty output is the canned fallback signal.
    // The canned path is NOT a queue delivery — no ownership marker (a
    // marker here would orphan fresh for 10 min and starve enqueues).
    const d3 = drainCli(sid, tok.split(":")[0]);
    expect(d3.status).toBe(0);
    expect(d3.stdout.toString()).toBe("");
    expect((await listQueue(sid)).length).toBe(0);
    expect(await readDraining(sid)).toBeNull();
    expect(existsSync(markerPath(sid))).toBe(false);
  });
});
