import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const AC = new URL("../bin/ac.mjs", import.meta.url).pathname;
let home, sent;

const run = (args, env = {}) =>
  execFileSync(process.execPath, [AC, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, AUTO_CONTINUE_HOME: home, AC_PAD_SEC: "0", AC_BLIND_SEC: "1", AC_RETRIES: "3",
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
  run(["add", "at", "+1s", prompt]);
  await sleep(2500);
  expect(readFileSync(sent, "utf8").trim()).toBe(prompt);
});

test("a plugin can pass the schedule and prompt as one argument", () => {
  run(["add", "at +5m keep this prompt intact"]);
  const [entry] = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  expect(entry.prompt).toBe("keep this prompt intact");
  expect(entry.sendAt - entry.createdAt).toBeGreaterThan(299_000);
  run(["cancel", "all"]);
});

test("a resumed delivery cannot recursively queue itself", () => {
  run(["add", "do not queue"], { AUTO_CONTINUE_DELIVERY: "1" });
  expect(existsSync(join(home, "queue.json"))).toBe(false);
});

test("duplicate plugin expansion queues an exact prompt only once", () => {
  run(["add", "at +5m same prompt"]);
  expect(run(["add", "at +5m same prompt"])).toContain("already queued");
  const queue = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  expect(queue).toHaveLength(1);
  run(["cancel", "all"]);
});

test("concurrent additions cannot overwrite each other", async () => {
  const env = {
    ...process.env,
    AUTO_CONTINUE_HOME: home,
    AC_PAD_SEC: "0",
    AC_HARNESS: "claude",
    AC_SESSION: "S1",
    AC_SEND_CLAUDE: `printf '%s\\n' "$(cat "$2")" >> ${sent}`,
  };
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AC, "add", "at", "+5m", `prompt-${i}`], {
      env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ac exited ${code}`)));
  })));
  const queue = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"));
  expect(queue).toHaveLength(12);
  expect(new Set(queue.map((entry) => entry.prompt)).size).toBe(12);
  run(["cancel", "all"]);
});

test("a malformed queue is reported instead of overwritten", () => {
  writeFileSync(join(home, "queue.json"), "not json");
  expect(() => run(["add", "at", "+5m", "work"])).toThrow(/cannot read queue|Command failed/);
  expect(readFileSync(join(home, "queue.json"), "utf8")).toBe("not json");
});

test("list reports pending then sent", async () => {
  run(["add", "at", "+1s", "work"]);
  expect(run(["list"])).toContain("pending");
  await sleep(2500);
  expect(run(["list"])).toContain("sent");
});

test("cancel kills the sleeper and nothing is sent", async () => {
  run(["add", "at", "+2s", "work"]);
  run(["cancel", "all"]);
  await sleep(3500);
  expect(existsSync(sent)).toBe(false);
  expect(run(["list"])).toContain("nothing queued");
});

test("a dead sleeper is re-forked on the next invocation", async () => {
  run(["add", "at", "+30s", "work"]);
  const before = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"))[0];
  process.kill(before.pid);
  await sleep(300);
  run(["list"]);
  const after = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"))[0];
  expect(after.pid).not.toBe(before.pid);
});

test("login recovery installs and removes a launch agent", async () => {
  const agents = join(home, "LaunchAgents");
  run(["enable-recovery"], { AUTO_CONTINUE_LAUNCH_AGENTS: agents });
  const plist = join(agents, "com.auto-continue.recover.plist");
  const contents = readFileSync(plist, "utf8");
  expect(contents).toContain("<string>_recover</string>");
  expect(contents).toContain("<key>RunAtLoad</key><true/>");
  run(["disable-recovery"], { AUTO_CONTINUE_LAUNCH_AGENTS: agents });
  expect(existsSync(plist)).toBe(false);
});

test("root reports the installed plugin directory", () => {
  expect(run(["root"]).trim()).toBe(new URL("..", import.meta.url).pathname.replace(/\/$/, ""));
});

test("two prompts for one session do not overlap", { timeout: 20000 }, async () => {
  const script = `echo "START $(cat "$2")" >> ${sent}; sleep 2; echo "END $(cat "$2")" >> ${sent}`;
  run(["add", "at", "+1s", "one"], { AC_SEND_CLAUDE: script });
  run(["add", "at", "+1s", "two"], { AC_SEND_CLAUDE: script });
  await sleep(12000);
  expect(readFileSync(sent, "utf8").trim().split("\n")).toEqual([
    "START one", "END one", "START two", "END two",
  ]);
});

test("an unconfigured harness refuses instead of running claude", () => {
  expect(() => run(["add", "at", "+1s", "work"], { AC_HARNESS: "unknown", AC_SEND_UNKNOWN: "" }))
    .toThrow(/AC_SEND_UNKNOWN|Command failed/);
  expect(existsSync(sent)).toBe(false);
});

test("built-in adapters target the selected harness and session", async () => {
  const fakeBin = join(home, "bin");
  const calls = join(home, "calls.txt");
  execFileSync("mkdir", ["-p", fakeBin]);
  for (const name of ["claude", "opencode", "cursor-agent"]) {
    const path = join(fakeBin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}:'\"$*:delivery=$AUTO_CONTINUE_DELIVERY\" >> '${calls}'\nprintf '%s\\n' \"$*\" | grep -q 'adapter prompt'\n`);
    chmodSync(path, 0o755);
  }
  const codex = join(fakeBin, "codex");
  writeFileSync(codex, `#!/bin/sh\np=$(cat)\nprintf '%s\\n' 'codex:'\"$*:$p:delivery=$AUTO_CONTINUE_DELIVERY\" >> '${calls}'\n[ \"$p\" = 'adapter prompt' ]\n`);
  chmodSync(codex, 0o755);

  for (const harness of ["claude", "codex", "opencode", "cursor"]) {
    run(["add", "adapter prompt"], {
      AC_HARNESS: harness,
      AC_SESSION: `${harness}-session-123`,
      AC_SEND_CLAUDE: "",
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
  }
  await sleep(2500);
  const text = readFileSync(calls, "utf8");
  expect(text).toContain("claude:--resume claude-session-123");
  expect(text).toContain("codex:exec resume codex-session-123 -:adapter prompt");
  expect(text).toContain("opencode:run --session opencode-session-123 adapter prompt");
  expect(text).toContain("cursor-agent:--resume cursor-session-123 --print --output-format json adapter prompt");
  expect(text.match(/delivery=1/g)).toHaveLength(4);
});

// --- the two cases: limited, and not limited ---

test("not limited: the prompt is sent immediately", async () => {
  run(["add", "continue the work"], { AC_SEND_CLAUDE: `echo ok; exit 0` });
  await sleep(1500);
  expect(run(["list"])).toContain("sent");
});

test("limited: it reads the reset time from the failure and retries then", async () => {
  const flag = join(home, "unlocked");
  const reset = Math.floor(Date.now() / 1000) + 3;
  run(["add", "continue the work"], {
    AC_SEND_CLAUDE: `if [ -f ${flag} ]; then echo DELIVERED >> ${sent}; exit 0; else echo 'Claude AI usage limit reached|${reset}'; exit 1; fi`,
    AC_BLIND_SEC: "1",
  });
  await sleep(800);
  expect(run(["list"])).toContain("pending");   // held, not lost
  execFileSync("touch", [flag]);
  await sleep(70000);                            // clamped floor is 60s
  expect(readFileSync(sent, "utf8")).toContain("DELIVERED");
}, 90000);

test("a non-limit failure is not retried and is reported as failed", async () => {
  run(["add", "work"], { AC_SEND_CLAUDE: `echo "Invalid API key"; exit 1` });
  await sleep(1500);
  expect(run(["list"])).toContain("failed");
  expect(readFileSync(join(home, "logs", readdirSync(join(home, "logs"))[0]), "utf8"))
    .toContain("non-limit reason");
});

test("parseResetSec: reads real limit formats, refuses non-limit failures", async () => {
  const { parseResetSec } = await import("../bin/ac.mjs");
  const now = new Date("2026-09-07T12:00:00").getTime();
  expect(parseResetSec("Claude AI usage limit reached|" + (now / 1000 + 7200), now)).toBe(7200);
  expect(parseResetSec("5-hour limit reached \u2219 resets 3pm", now)).toBe(10800);
  expect(parseResetSec("429 rate limit; retry-after: 1800", now)).toBe(1800);
  expect(parseResetSec("usage limit reached", now)).toBeGreaterThan(0);  // blind wait
  expect(parseResetSec("Invalid API key", now)).toBeNull();
  expect(parseResetSec("Error: session not found", now)).toBeNull();
});
