import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = new URL("../hooks/auto-continue.mjs", import.meta.url).pathname;
let home;

const hook = (event) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify(event),
  encoding: "utf8",
  env: { ...process.env, AUTO_CONTINUE_HOME: home, AC_SEND_CODEX: "true" },
});

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ac-codex-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("Codex hook queues the prompt for its exact session and blocks submission", () => {
  const result = hook({
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-session-1",
    cwd: process.cwd(),
    prompt: "/auto-continue finish the task",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("sending now to codex session codex-se");
  const [entry] = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  expect(entry).toMatchObject({
    harness: "codex",
    session: "codex-session-1",
    prompt: "finish the task",
  });
});

test("Codex hook ignores ordinary prompts", () => {
  expect(hook({ prompt: "ordinary prompt" }).status).toBe(0);
});
