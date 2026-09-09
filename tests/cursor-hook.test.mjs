import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = new URL("../cursor/hooks/auto-continue.mjs", import.meta.url).pathname;
let home;

const hook = (event, env = {}) => JSON.parse(execFileSync(process.execPath, [HOOK], {
  input: JSON.stringify(event),
  encoding: "utf8",
  env: { ...process.env, AUTO_CONTINUE_HOME: home, AC_SEND_CURSOR: "true", ...env },
}));

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ac-cursor-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("Cursor sessionStart exposes the exact conversation to later hooks", () => {
  expect(hook({ session_id: "cursor-session-1" })).toEqual({
    env: {
      AUTO_CONTINUE_HARNESS: "cursor",
      AUTO_CONTINUE_SESSION: "cursor-session-1",
    },
  });
});

test("Cursor command is queued locally and blocked before a model request", () => {
  const result = hook({ prompt: "AUTO_CONTINUE_REQUEST\nfinish the task" }, {
    AUTO_CONTINUE_SESSION: "cursor-session-1",
  });
  expect(result.continue).toBe(false);
  expect(result.user_message).toContain("sending now to cursor session cursor-s");
  const [entry] = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  expect(entry).toMatchObject({
    harness: "cursor",
    session: "cursor-session-1",
    prompt: "finish the task",
  });
});

test("Cursor hook ignores ordinary prompts", () => {
  expect(hook({ prompt: "ordinary prompt" })).toEqual({ continue: true });
});
