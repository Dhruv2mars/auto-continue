import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, classifyText, parseRetryAfterSec } from "../core/lib/classify.mjs";
import { decide, HARNESS_CAPS, blockDecision } from "../core/lib/policy.mjs";
import { loadState, saveState } from "../core/lib/state.mjs";

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-test-"));
  process.env.AUTO_CONTINUE_HOME = home;
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("classify", () => {
  test("claude quota message with reset clock", () => {
    const c = classifyText("Claude's usage limit has been reached. Your limit will reset at 5:00pm.");
    expect(c.kind).toBe("rate_limit");
    expect(c.retryAfterSec).toBeGreaterThan(0);
    expect(c.retryAfterSec).toBeLessThanOrEqual(86400);
  });

  test("relative retry wording", () => {
    expect(parseRetryAfterSec("Rate limit reached. Try again in 12 minutes.")).toBe(720);
    expect(parseRetryAfterSec("try again in 90 seconds")).toBe(90);
    expect(parseRetryAfterSec("try again in 2 hours")).toBe(7200);
  });

  const cases = [
    ["API Error: 429 too many requests", "rate_limit"],
    ["Overloaded: the server is currently over capacity", "overloaded"],
    ["invalid api key (401 unauthorized)", "auth"],
    ["billing error: insufficient credit (402)", "billing"],
    ["Request was aborted by user", "abort"],
    ["the file src/index.ts was edited", "other"],
    ["", "other"],
  ];
  for (const [text, kind] of cases) {
    test(`text: ${text.slice(0, 40)} -> ${kind}`, () => {
      expect(classifyText(text).kind).toBe(kind);
    });
  }

  test("structured opencode ApiError with 429 and retry-after header", () => {
    const c = classify({
      error: { name: "APIError", data: { statusCode: 429, responseHeaders: { "retry-after": "30" } } },
    });
    expect(c.kind).toBe("rate_limit");
    expect(c.retryAfterSec).toBe(30);
  });

  test("structured statusCode 401 beats message text", () => {
    const c = classify({ error: { statusCode: 401, message: "quota exhausted" } });
    expect(c.kind).toBe("auth");
  });

  test("StopFailure matcher forces rate_limit", () => {
    const c = classify({ matcher: "rate_limit", text: "something odd happened" });
    expect(c.kind).toBe("rate_limit");
  });

  test("matcher + 401 text stays auth", () => {
    const c = classify({ matcher: "rate_limit", text: "invalid api key (401 unauthorized)" });
    expect(c.kind).toBe("auth");
  });

  test("matcher + abort text stays abort", () => {
    const c = classify({ matcher: "rate_limit", text: "Request was aborted by user" });
    expect(c.kind).toBe("abort");
  });

  test("structured 429 with retry text merges retryAfterSec", () => {
    const c = classify({
      error: { statusCode: 429, message: "Rate limit reached. Try again in 12 minutes." },
    });
    expect(c.kind).toBe("rate_limit");
    expect(c.retryAfterSec).toBe(720);
    expect(c.source).toBe("structured");
  });

  test("full payload stringify baseline still classifies undocumented shapes", () => {
    const c = classify({ payload: { weird: { nested: "Error: usage limit exceeded for your plan" } } });
    expect(c.kind).toBe("rate_limit");
  });
});

describe("policy", () => {
  const rate = { kind: "rate_limit", retryAfterSec: null };

  test("first hit resumes after backoff floor", () => {
    const d = decide(rate, { continues: 0 }, { harness: "claude" });
    expect(d.action).toBe("resume_later");
    expect(d.delaySec).toBe(45);
    expect(d.continueIndex).toBe(1);
  });

  test("retryAfterSec wins when present, clamped to [10, maxWait]", () => {
    expect(decide({ kind: "rate_limit", retryAfterSec: 30 }, { continues: 0 }, { harness: "claude" }).delaySec).toBe(30);
    expect(decide({ kind: "rate_limit", retryAfterSec: 2 }, { continues: 0 }, { harness: "claude" }).delaySec).toBe(10);
    expect(decide({ kind: "rate_limit", retryAfterSec: 999999 }, { continues: 0 }, { harness: "claude", maxWaitSec: 3600 }).delaySec).toBe(3600);
  });

  test("per-harness caps: zcode stays under its 3-limit", () => {
    expect(HARNESS_CAPS.zcode).toBeLessThan(3);
    const d = decide(rate, { continues: 2 }, { harness: "zcode" });
    expect(d.action).toBe("give_up");
  });

  test("explicit maxContinues overrides", () => {
    expect(decide(rate, { continues: 1 }, { harness: "claude", maxContinues: 1 }).action).toBe("give_up");
  });

  test("overloaded continues now with short delay", () => {
    const d = decide({ kind: "overloaded", retryAfterSec: null }, { continues: 0 }, { harness: "claude" });
    expect(d.action).toBe("continue_now");
    expect(d.delaySec).toBe(30);
  });

  test("auth and billing never auto-retry", () => {
    expect(decide({ kind: "auth" }, { continues: 0 }, { harness: "claude" }).action).toBe("notify_only");
    expect(decide({ kind: "billing" }, { continues: 0 }, { harness: "claude" }).action).toBe("notify_only");
  });

  test("ignore other kinds", () => {
    expect(decide({ kind: "other" }, { continues: 0 }, { harness: "claude" }).action).toBe("ignore");
  });

  test("blockDecision shape", () => {
    expect(blockDecision("why")).toEqual({ decision: "block", reason: "why" });
  });
});

describe("state", () => {
  test("missing session loads as zero", async () => {
    expect(await loadState("nope")).toEqual({ continues: 0, updatedAt: 0 });
  });

  test("save then load round-trips with sanitized keys", async () => {
    await saveState("session/with:weird chars", { continues: 2 });
    const s = await loadState("session/with:weird chars");
    expect(s.continues).toBe(2);
    expect(existsSync(join(home, "state"))).toBe(true);
  });

  test("state file is written atomically (no tmp leftovers)", async () => {
    await saveState("s1", { continues: 1 });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(home, "state")).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

describe("cli end to end", () => {
  const runCli = (args, env = {}) => {
    const p = Bun.spawnSync(["node", join(import.meta.dir, "..", "core", "cli.mjs"), ...args], {
      env: { ...process.env, AUTO_CONTINUE_HOME: home, ...env },
      cwd: import.meta.dir,
    });
    return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode };
  };

  test("stop with quota text -> resume_later, no stdout, dry mode arms nothing", () => {
    const fixture = join(import.meta.dir, "fixtures", "claude-stop-quota.json");
    const r = runCli(["claude", "stop", "--fixture", fixture, "--dry"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("overloaded stop -> block decision on stdout", () => {
    const fixture = join(import.meta.dir, "fixtures", "stop-overloaded.json");
    const r = runCli(["claude", "stop", "--fixture", fixture, "--dry"]);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/overloaded.*30s/);
  });

  test("cursor overloaded stop -> followup_message on stdout", () => {
    const fixture = join(import.meta.dir, "fixtures", "stop-overloaded.json");
    const r = runCli(["cursor", "stop", "--fixture", fixture, "--dry"]);
    const out = JSON.parse(r.stdout);
    expect(out.followup_message).toBeDefined();
    expect(out.decision).toBeUndefined();
  });

  test("resume_later increments persisted state", async () => {
    const fixture = join(import.meta.dir, "fixtures", "claude-stop-quota.json");
    runCli(["claude", "stop", "--fixture", fixture, "--dry"]);
    const payload = JSON.parse(readFileSync(fixture, "utf8"));
    const s = await loadState(payload.session_id);
    expect(s.continues).toBe(1);
  });

  test("cap reached -> give_up, no output", () => {
    const fixture = join(import.meta.dir, "fixtures", "claude-stop-quota.json");
    const r = runCli(["claude", "stop", "--fixture", fixture, "--dry", "--max-continues", "0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("log.jsonl records the fire", () => {
    const fixture = join(import.meta.dir, "fixtures", "claude-stop-quota.json");
    runCli(["claude", "stop", "--fixture", fixture, "--dry"]);
    const log = readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const row = log.at(-1);
    expect(row.harness).toBe("claude");
    expect(row.kind).toBe("rate_limit");
    expect(row.action).toBe("resume_later");
  });

  test("broken json on stdin is ignored safely", () => {
    const p = Bun.spawnSync(["node", join(import.meta.dir, "..", "core", "cli.mjs"), "claude", "stop", "--dry"], {
      env: { ...process.env, AUTO_CONTINUE_HOME: home },
      stdin: new Blob(["{not json"]),
      cwd: import.meta.dir,
    });
    expect(p.exitCode).toBe(0);
  });
});

describe("classify round-2 fixes", () => {
  test("string statusCode '429' coerces to rate_limit", () => {
    const c = classify({ error: { statusCode: "429" } });
    expect(c.kind).toBe("rate_limit");
  });

  test("string statusCode '401' coerces to auth", () => {
    const c = classify({ error: { statusCode: "401" } });
    expect(c.kind).toBe("auth");
  });

  test("numeric-string status in data.status coerces", () => {
    const c = classify({ error: { data: { status: "529" } } });
    expect(c.kind).toBe("overloaded");
  });

  test("non-numeric status falls through to text baseline", () => {
    const c = classify({ error: { statusCode: "abc", message: "rate limit exceeded" } });
    expect(c.kind).toBe("rate_limit");
    expect(c.source).toBe("text");
  });

  test("isRetryable=true maps to overloaded, not rate_limit", () => {
    const c = classify({ error: { isRetryable: true, message: "connection timeout" } });
    expect(c.kind).toBe("overloaded");
    expect(c.source).toBe("structured");
  });

  test("matcher + isRetryable stays rate_limit (matcher wins advisory)", () => {
    const c = classify({ matcher: "rate_limit", error: { isRetryable: true } });
    expect(c.kind).toBe("rate_limit");
  });

  test("benign assistant prose mentioning quota words does not classify rate_limit", () => {
    const c = classify({
      text: "I raised the stream buffer's capacity to 4 so the quota of open files per process is not hit.",
    });
    expect(c.kind).toBe("other");
  });

  test("benign prose with 'limit ... reached' spread does not classify rate_limit", () => {
    // Regression: /limit.*reached|reached.*limit/ spanned arbitrary prose.
    const texts = [
      "Once the 100th row is reached, we apply a limit to keep memory bounded.",
      "The character limit for titles was reached, so the import stopped early.",
    ];
    for (const text of texts) expect(classify({ text }).kind).toBe("other");
  });

  test("real limit messages that name the limit explicitly still classify rate_limit", () => {
    expect(classifyText("You have reached your usage limit. Your limit will reset at 5:00pm.").kind).toBe("rate_limit");
    expect(classifyText("usage limit reached").kind).toBe("rate_limit");
    expect(classifyText("rate limit reached, retry later").kind).toBe("rate_limit");
    expect(classifyText("Claude's usage limit has been reached. Your limit will reset at 5:00pm.").kind).toBe("rate_limit");
    expect(classifyText("API Error: 429 too many requests").kind).toBe("rate_limit");
  });

  test("HTTP-date retry-after header does not produce NaN delaySec", () => {
    const c = classify({ error: { statusCode: 429, responseHeaders: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } } });
    expect(c.kind).toBe("rate_limit");
    expect(c.retryAfterSec).toBeNull();
    expect(Number.isFinite(c.retryAfterSec) || c.retryAfterSec === null).toBe(true);
  });
});
