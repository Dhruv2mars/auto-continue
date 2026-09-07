/**
 * Round-3 hostile e2e repros: settling-marker ownership. A fresh .settling
 * marker proves a delivery in flight — no second arm may re-drain that
 * head, and a stale marker must degrade to restore, never drop. All state
 * stays in a temp AUTO_CONTINUE_HOME; never touches ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listQueue, readDraining } from "../core/lib/queue.mjs";

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

function fixture(sid, message) {
  const path = join(home, `${sid}-${message.replace(/\W+/g, "-").slice(0, 20)}.json`);
  writeFileSync(path, JSON.stringify({ session_id: sid, hook_event_name: "Stop", last_assistant_message: message }));
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-r3m-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
  process.env.AUTO_CONTINUE_MAX_WAIT = "3";
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

function markerPath(sid) {
  return join(home, "queue", `${sid}.settling`);
}

function ageMarker(sid, minusMin) {
  const t = new Date(Date.now() - minusMin * 60 * 1000);
  utimesSync(markerPath(sid), t, t);
}

describe("round-3: settling marker owns the .draining head", () => {
  test("resume_later during in-flight delivery neither restores nor re-arms", async () => {
    const sid = "m1";
    // Slow successful resume keeps the delivery in flight for the whole test.
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "sleep 6" };
    const e = JSON.parse(runCli(["enqueue", sid, "ONE-dup-xyz"], env).stdout.toString());
    expect(e.armed).toBe(true);
    // Wait for begin marker (delivery in flight).
    expect(await until(() => existsSync(markerPath(sid)), 50, 100)).toBe(true);
    // Age the arm past the dedupe window (the finding's surgery) so the
    // recentlyArmed gate would otherwise pass.
    const stateFile = join(home, "state", `${sid}.json`);
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    st.watcherArmedAt = Date.now() - 130000;
    writeFileSync(stateFile, JSON.stringify(st));

    // A limit stop while the delivery is in flight.
    const hook = runCli(["claude", "stop", "--fixture", fixture(sid, "usage limit reached; try again later")], env);
    expect(hook.status).toBe(0);
    expect(hook.stderr.toString()).toContain("delivery in flight");
    // Head NOT restored (still owned by the in-flight delivery).
    expect(await readDraining(sid)).not.toBeNull();
    expect((await listQueue(sid)).length).toBe(0);
  }, 20000);

  test("enqueue during in-flight delivery queues honestly without arming", async () => {
    const sid = "m2";
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "sleep 6" };
    const e1 = JSON.parse(runCli(["enqueue", sid, "inflight-head"], env).stdout.toString());
    expect(e1.armed).toBe(true);
    // Wake at ~1s + drain: marker up well inside the 6s resume; poll 120x100ms
    // so machine load cannot exhaust the window.
    expect(await until(() => existsSync(markerPath(sid)), 120, 100)).toBe(true);
    // Age the arm past the dedupe window.
    const stateFile = join(home, "state", `${sid}.json`);
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    st.watcherArmedAt = Date.now() - 130000;
    writeFileSync(stateFile, JSON.stringify(st));

    const e2 = JSON.parse(runCli(["enqueue", sid, "second-during-flight"], env).stdout.toString());
    expect(e2.armed).toBe(false);
    expect(e2.reason).toContain("delivery in flight");
    // Prompt IS stored (drains FIFO after the in-flight settle).
    const q = await listQueue(sid);
    expect(q.length).toBe(1);
    expect(q[0].prompt).toBe("second-during-flight");
  }, 20000);

  test("stale marker + healthy stop restores the head; a failing resume finds it back", async () => {
    const sid = "m3";
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "sleep 4; exit 7" };
    const e = JSON.parse(runCli(["enqueue", sid, "LOST-xyz"], env).stdout.toString());
    expect(e.armed).toBe(true);
    expect(await until(() => existsSync(markerPath(sid)), 50, 100)).toBe(true);
    // Resume still sleeping (4s), but the marker reads as stale (11 min).
    ageMarker(sid, 11);
    // Healthy stop: stale marker must RESTORE, never drop.
    const healthy = runCli(["claude", "stop", "--fixture", fixture(sid, "done")], env);
    expect(healthy.status).toBe(0);
    expect(await readDraining(sid)).not.toBeNull();
    // Resume then exits 7: settle-fail restore no-ops (already home), the
    // prompt exists in exactly one place: the queue file.
    await new Promise((r) => setTimeout(r, 5000));
    const q = await listQueue(sid);
    expect(q.length).toBe(1);
    expect(q[0].prompt).toBe("LOST-xyz");
    expect(await readDraining(sid)).toBeNull();
    // Marker cleaned up by settle.
    expect(existsSync(markerPath(sid))).toBe(false);
  }, 25000);

  test("no marker (idle queue): healthy stop still resets and restores cleanly", async () => {
    const sid = "m4";
    const env = { AUTO_CONTINUE_RESUME_CMD_CLAUDE: "true" };
    const e = JSON.parse(runCli(["enqueue", sid, "quick-head"], env).stdout.toString());
    expect(e.armed).toBe(true);
    // Watcher wakes, drains, resume "true" exits 0, settle acks — possibly
    // faster than any marker poll can observe. Wait on the settled OUTCOME
    // (head gone from queue and draining), never on marker visibility.
    expect(await until(async () =>
      (await listQueue(sid)).length === 0 && (await readDraining(sid)) === null, 100, 100)).toBe(true);
    expect(existsSync(markerPath(sid))).toBe(false);
  }, 20000);
});
