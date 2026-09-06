/**
 * Round-2 hostile e2e repro: a wake with a pending .draining item (previous
 * watcher crashed mid-send) must restore it and drain FIFO, not fall back to
 * the canned prompt while real prompts sit queued. All state stays in a temp
 * AUTO_CONTINUE_HOME; never touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, drainHead, listQueue, readDraining } from "../core/lib/queue.mjs";

let home;
let origEnv;

function drainCli(sessionId) {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain.mjs"), sessionId], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
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
    // A second prompt is enqueued and a new watcher arms + wakes.
    await enqueue(sid, "second-prompt");

    // Wake 1: the interrupted head must come out first (not canned fallback).
    const d1 = drainCli(sid);
    expect(d1.status).toBe(0);
    expect(d1.stdout.toString()).toBe("interrupted-prompt-xyz");
    expect(await readDraining(sid)).not.toBeNull();

    // The resume exits 0 -> settle acks; wake 2 delivers the second prompt.
    const { ackDraining } = await import("../core/lib/queue.mjs");
    await ackDraining(sid);
    const d2 = drainCli(sid);
    expect(d2.stdout.toString()).toBe("second-prompt");
    await ackDraining(sid);

    // Genuinely empty queue: empty output is the canned fallback signal.
    const d3 = drainCli(sid);
    expect(d3.status).toBe(0);
    expect(d3.stdout.toString()).toBe("");
    expect((await listQueue(sid)).length).toBe(0);
    expect(await readDraining(sid)).toBeNull();
  });
});
