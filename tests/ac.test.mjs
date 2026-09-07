import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const AC = new URL("../bin/ac.mjs", import.meta.url).pathname;
let home, sent;

const run = (args, env = {}) =>
  execFileSync(process.execPath, [AC, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, AUTO_CONTINUE_HOME: home, AC_PAD_SEC: "0", AC_RETRY_SEC: "1",
      AC_HARNESS: "claude", AC_SESSION: "S1",
      AC_SEND_CLAUDE: `printf '%s\\n' "$(cat "$2")" >> ${sent}`,
      ...env,
    },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-"));
  sent = join(home, "sent.txt");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// --- time parsing: the only parser left, over input the user typed ---

test("parseWhen: relative and absolute", async () => {
  const { parseWhen } = await import("../bin/ac.mjs");
  const now = new Date("2026-01-01T10:00:00");
  expect(parseWhen("+5h", now).getTime() - now.getTime()).toBe(5 * 3600 * 1000);
  expect(parseWhen("90m", now).getTime() - now.getTime()).toBe(90 * 60 * 1000);
  expect(parseWhen("3pm", now).getHours()).toBe(15);
  expect(parseWhen("15:30", now).getMinutes()).toBe(30);
});

test("parseWhen: a past clock time means tomorrow", async () => {
  const { parseWhen } = await import("../bin/ac.mjs");
  const now = new Date("2026-01-01T16:00:00");
  expect(parseWhen("3pm", now).getDate()).toBe(2);
});

test("parseWhen: garbage throws instead of guessing", async () => {
  const { parseWhen } = await import("../bin/ac.mjs");
  for (const bad of ["", "later", "when the limit resets", "99:99"]) {
    expect(() => parseWhen(bad)).toThrow();
  }
});

// --- lifecycle ---

test("a queued prompt is delivered verbatim at its time", async () => {
  const prompt = 'fix $PATH and `whoami` and "quotes"';
  run(["add", "+1s", prompt]);
  await sleep(2500);
  expect(readFileSync(sent, "utf8").trim()).toBe(prompt);
});

test("list reports pending then sent", async () => {
  run(["add", "+1s", "work"]);
  expect(run(["list"])).toContain("pending");
  await sleep(2500);
  expect(run(["list"])).toContain("sent");
});

test("cancel kills the sleeper and nothing is sent", async () => {
  run(["add", "+2s", "work"]);
  run(["cancel", "all"]);
  await sleep(3500);
  expect(existsSync(sent)).toBe(false);
  expect(run(["list"])).toContain("nothing queued");
});

test("a dead sleeper is re-forked on the next invocation", async () => {
  run(["add", "+30s", "work"]);
  const before = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"))[0];
  process.kill(before.pid);
  await sleep(300);
  run(["list"]);
  const after = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"))[0];
  expect(after.pid).not.toBe(before.pid);
});

test("two prompts for one session do not overlap", { timeout: 20000 }, async () => {
  const script = `echo "START $(cat "$2")" >> ${sent}; sleep 2; echo "END $(cat "$2")" >> ${sent}`;
  run(["add", "+1s", "one"], { AC_SEND_CLAUDE: script });
  run(["add", "+1s", "two"], { AC_SEND_CLAUDE: script });
  await sleep(12000);
  expect(readFileSync(sent, "utf8").trim().split("\n")).toEqual([
    "START one", "END one", "START two", "END two",
  ]);
});

test("an unconfigured harness refuses instead of running claude", () => {
  expect(() => run(["add", "+1s", "work"], { AC_HARNESS: "codex", AC_SEND_CODEX: "" }))
    .toThrow(/AC_SEND_CODEX|Command failed/);
  expect(existsSync(sent)).toBe(false);
});
