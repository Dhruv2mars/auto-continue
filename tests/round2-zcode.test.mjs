/**
 * Round-2 hostile e2e repros: zcode flow. Zcode env markers must select the
 * zcode watcher path (never the claude template), give_up must be
 * observer-visible, and arming without a zcode resume cmd must refuse
 * honestly. All state stays in a temp AUTO_CONTINUE_HOME; never touches
 * ~/.auto-continue.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let origEnv;

function cliPath() {
  return new URL("../core/cli.mjs", import.meta.url).pathname;
}

function hookPath() {
  return new URL("../hooks/auto-continue.mjs", import.meta.url).pathname;
}

function runCli(argLine, extraEnv = {}) {
  return spawnSync("node", [cliPath(), ...argLine], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home, ...extraEnv },
    cwd: import.meta.dir,
    encoding: "utf8",
  });
}

function runHook(argLine, extraEnv = {}, input = "") {
  return spawnSync("node", [hookPath(), ...argLine], {
    env: { ...process.env, AUTO_CONTINUE_HOME: home, ...extraEnv },
    cwd: import.meta.dir,
    encoding: "utf8",
    input,
  });
}

function stubClaude(logfile) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "CLAUDE-TEMPLATE $@" >> ${logfile}\nexit 0\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-zc-"));
  origEnv = { ...process.env };
  process.env.AUTO_CONTINUE_HOME = home;
  for (const k of Object.keys(process.env)) {
    if (/^AUTO_CONTINUE_(PROBE|RESUME_CMD)/.test(k) || /^ZCODE/.test(k) || /^CODEX/.test(k)) delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AUTO_CONTINUE_") || /^ZCODE/.test(k) || /^CODEX/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, origEnv);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("round-2: zcode flow honesty", () => {
  test("zcode env enqueue uses the zcode resume cmd, never the claude template", async () => {
    const zstub = join(home, "zstub.log");
    const rclog = join(home, "rc.log");
    const env = {
      ...stubClaude(rclog),
      ZCODE_SESSION_ID: "z-1",
      AUTO_CONTINUE_MIN_DELAY: "1",
      AUTO_CONTINUE_MAX_WAIT: "3",
      AUTO_CONTINUE_RESUME_CMD_ZCODE: `cat >> ${zstub}`,
    };
    const e = JSON.parse(runCli(["enqueue", "z-1", "which template runs"], env).stdout.toString());
    expect(e.armed).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(zstub)).toBe(true);
    expect(existsSync(rclog)).toBe(false);
  }, 15000);

  test("zcode enqueue with no resume cmd refuses honestly (claude stub untouched)", async () => {
    const rclog = join(home, "rc.log");
    const env = {
      ...stubClaude(rclog),
      ZCODE_SESSION_ID: "z-2",
      AUTO_CONTINUE_MIN_DELAY: "1",
      AUTO_CONTINUE_MAX_WAIT: "3",
    };
    const e = JSON.parse(runCli(["enqueue", "z-2", "no template"], env).stdout.toString());
    expect(e.armed).toBe(false);
    expect(e.reason).toMatch(/AUTO_CONTINUE_RESUME_CMD_ZCODE/);
    // Prompt stays queued for a later arm (documented, drainable state).
    expect(e.queued).toBe(1);
    await new Promise((r) => setTimeout(r, 2200));
    expect(existsSync(rclog)).toBe(false);
  }, 15000);

  test("zcode hook at cap: give_up writes the reason to stderr (never silent)", () => {
    const sid = "zcl";
    // Drive the session to the zcode cap (continues=2).
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", `${sid}.json`), JSON.stringify({ continues: 2, watcherArmedAt: 0, updatedAt: 0 }));
    const fixture = join(home, "limit3.json");
    writeFileSync(
      fixture,
      JSON.stringify({ session_id: sid, hook_event_name: "Stop", last_assistant_message: "usage limit reached; try again later" }),
    );
    const r = runCli(["zcode", "stop", "--fixture", fixture], { AUTO_CONTINUE_RESUME_CMD_ZCODE: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("");
    expect(r.stderr.toString()).toMatch(/\[auto-continue\] .*cap of 2/);
  });

  test("zcode limit below cap arms via the zcode template path (no claude stub)", async () => {
    const rclog = join(home, "rc.log");
    const fixture = join(home, "limit1.json");
    writeFileSync(
      fixture,
      JSON.stringify({ session_id: "z-3", hook_event_name: "Stop", last_assistant_message: "usage limit reached; try again later" }),
    );
    const env = {
      ...stubClaude(rclog),
      ZCODE_SESSION_ID: "z-3",
      AUTO_CONTINUE_MIN_DELAY: "1",
      AUTO_CONTINUE_MAX_WAIT: "3",
      AUTO_CONTINUE_RESUME_CMD_ZCODE: "true",
    };
    const r = runHook(["stop"], env, JSON.stringify({ session_id: "z-3", hook_event_name: "Stop", last_assistant_message: "usage limit reached; try again later" }));
    expect(r.status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(existsSync(rclog)).toBe(false);
    // resume cmd "true" produces no log file output; the resumes dir exists.
    expect(existsSync(join(home, "resumes"))).toBe(true);
  }, 15000);
});
