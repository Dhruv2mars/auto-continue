/**
 * Round-4 hostile e2e repros: queue conservation and drain ownership.
 * - Concurrent enqueues must ALL be stored (locked read-modify-write).
 * - drain.mjs must refuse while a fresh .settling marker proves another
 *   watcher's delivery is in flight (two live wakes may not both send).
 * - A stale-marker restore of a delivery that then succeeds must converge:
 *   settle drops the fingerprint-matched head, no re-delivery.
 * All state stays in a temp AUTO_CONTINUE_HOME; never touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, listQueue, readDraining } from "../core/lib/queue.mjs";

let home;
let origEnv;

function cliPath() {
  return new URL("../core/cli.mjs", import.meta.url).pathname;
}

function drainCli(sessionId) {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain.mjs"), sessionId], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

function settleCli(sessionId, mode = "", fp = "") {
  return spawnSync("node", [join(import.meta.dir, "..", "core", "drain-settle.mjs"), sessionId, mode, fp], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-r4-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_RESUME = "0"; // keep CLI enqueues gate-clear, no watchers
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

describe("round-4: queue conservation under concurrency", () => {
  test("12 concurrent enqueues all land in the queue file", async () => {
    const sid = "race";
    const procs = [];
    for (let i = 0; i < 12; i++) {
      procs.push(spawnSync("node", [cliPath(), "enqueue", sid, `RACE-${i}`], {
        env: { ...process.env, AUTO_CONTINUE_HOME: home },
        cwd: import.meta.dir,
        encoding: "utf8",
      }));
    }
    for (const p of procs) expect(p.status).toBe(0);
    const q = await listQueue(sid);
    const prompts = q.map((x) => x.prompt).sort();
    expect(q.length).toBe(12);
    for (let i = 0; i < 12; i++) expect(prompts).toContain(`RACE-${i}`);
  });
});

describe("round-4: drain ownership", () => {
  test("drain.mjs refuses while a fresh marker proves a delivery in flight", async () => {
    const sid = "own1";
    await enqueue(sid, "owned-head");
    // Another watcher's delivery in flight: it drained the head and began
    // a fresh marker (the watcher chain's send-time state).
    const { drainHead } = await import("../core/lib/queue.mjs");
    const head = await drainHead(sid);
    expect(head.prompt).toBe("owned-head");
    settleCli(sid, "begin", "owned-head");
    const d = drainCli(sid);
    expect(d.status).toBe(3);
    expect(d.stdout.toString()).toBe("");
    // Head untouched, still owned by the in-flight delivery.
    expect(await readDraining(sid)).not.toBeNull();
    // Stale marker (dead watcher): the wake takes over and delivers.
    const t = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(join(home, "queue", `${sid}.settling`), t, t);
    const d2 = drainCli(sid);
    expect(d2.status).toBe(0);
    expect(d2.stdout.toString()).toBe("owned-head");
  });

  test("stale-marker restore + successful delivery converges: settle drops the matched head", async () => {
    const sid = "own2";
    const { drainHead, restoreDraining, markRestored, promptFingerprint } = await import("../core/lib/queue.mjs");
    await enqueue(sid, "DUP-MARKER-xyz");
    // Watcher drains and begins (fresh marker).
    const head = await drainHead(sid);
    expect(head.prompt).toBe("DUP-MARKER-xyz");
    settleCli(sid, "begin", promptFingerprint("DUP-MARKER-xyz"));
    // Hook sees a stale marker and restores the head, leaving its receipt
    // (what cli.mjs does on both restore sites); the resume then SUCCEEDS
    // and settle acks.
    await restoreDraining(sid);
    await markRestored(sid, promptFingerprint("DUP-MARKER-xyz"));
    expect((await listQueue(sid)).length).toBe(1);
    // Settle success with the receipt matching the marker fingerprint:
    // drops .draining AND the restored queue head — no re-delivery.
    settleCli(sid);
    expect(await readDraining(sid)).toBeNull();
    expect((await listQueue(sid)).length).toBe(0);
    // A later wake finds nothing to send (empty output, no restore loop).
    const d = drainCli(sid);
    expect(d.status).toBe(0);
    expect(d.stdout.toString()).toBe("");
  });

  test("settle does NOT drop an unrelated head (receipt mismatch keeps queue)", async () => {
    const sid = "own3";
    const { drainHead, markRestored, promptFingerprint } = await import("../core/lib/queue.mjs");
    await enqueue(sid, "in-flight-prompt");
    const head = await drainHead(sid);
    settleCli(sid, "begin", head.prompt);
    // User enqueues a DIFFERENT prompt mid-flight; the hook's stale restore
    // leaves a receipt for THAT new prompt, but settle only drops a head
    // matching the DELIVERED fingerprint — the new prompt survives.
    await enqueue(sid, "user-second-prompt");
    await markRestored(sid, promptFingerprint("user-second-prompt"));
    settleCli(sid);
    const q = await listQueue(sid);
    expect(q.length).toBe(1);
    expect(q[0].prompt).toBe("user-second-prompt");
  });
});
