import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let prompts;
let pluginMod;

async function freshPlugin(client) {
  pluginMod = await import(`../adapters/opencode/index.js?t=${Date.now()}-${Math.random()}`);
  return pluginMod.AutoContinue({ client });
}

function makeClient({ delayMs = 0 } = {}) {
  return {
    session: {
      promptAsync: async ({ path, body }) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        prompts.push({ id: path.id, text: body.parts[0].text });
        return { ok: true };
      },
    },
  };
}

async function queueApi() {
  return import(`../adapters/opencode/core/queue.mjs?t=${Date.now()}-${Math.random()}`);
}

function quotaError(sessionID, retryAfter = "1") {
  return {
    type: "session.error",
    properties: {
      sessionID,
      error: {
        name: "APIError",
        data: {
          message: "rate limit exceeded",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": retryAfter },
        },
      },
    },
  };
}

function idle(sessionID, extraProps = {}) {
  return { type: "session.idle", properties: { sessionID, ...extraProps } };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ac-ocq-"));
  process.env.AUTO_CONTINUE_HOME = home;
  prompts = [];
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  delete process.env.AUTO_CONTINUE_MIN_DELAY;
  delete process.env.AUTO_CONTINUE_PROMPT;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("opencode queue resume", () => {
  test("armed+idle sends queued text (not canned)", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "1";
    const { enqueue } = await queueApi();
    await enqueue("q-text", "queued hello world");
    const plugin = await freshPlugin(makeClient());
    await plugin.event({ event: quotaError("q-text", "1") });
    await new Promise((r) => setTimeout(r, 30));
    await plugin.event({ event: idle("q-text") });
    await new Promise((r) => setTimeout(r, 1400));
    expect(prompts.length).toBe(1);
    expect(prompts[0].id).toBe("q-text");
    expect(prompts[0].text).toBe("queued hello world");
  });

  test("empty queue falls back to canned RETRY_PROMPT", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const plugin = await freshPlugin(makeClient());
    await plugin.event({ event: quotaError("q-empty", "0") });
    await new Promise((r) => setTimeout(r, 20));
    await plugin.event({ event: idle("q-empty") });
    expect(prompts.length).toBe(1);
    expect(prompts[0].text).toMatch(/Continue/);
  });

  test("delete-before-await prevents double prompt on concurrent idles", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const plugin = await freshPlugin(makeClient({ delayMs: 120 }));
    await plugin.event({ event: quotaError("q-race", "0") });
    await new Promise((r) => setTimeout(r, 20));
    // Both idles are due immediately; second must see the claim and stand down.
    await Promise.all([
      plugin.event({ event: idle("q-race") }),
      plugin.event({ event: idle("q-race") }),
    ]);
    // Let any stray second send land if the guard failed.
    await new Promise((r) => setTimeout(r, 300));
    expect(prompts.length).toBe(1);
  });

  test("restart restores armed state from disk", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const { enqueue } = await queueApi();
    await enqueue("q-restart", "persisted prompt");
    const client = makeClient();
    const plugin1 = await freshPlugin(client);
    await plugin1.event({ event: quotaError("q-restart", "0") });
    expect(prompts.length).toBe(0);
    // Simulate restart: fresh module = empty in-memory pending.
    const plugin2 = await freshPlugin(client);
    await plugin2.event({ event: idle("q-restart") });
    expect(prompts.length).toBe(1);
    expect(prompts[0].id).toBe("q-restart");
    expect(prompts[0].text).toBe("persisted prompt");
    // Disarmed: further idles do nothing.
    await plugin2.event({ event: idle("q-restart") });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(1);
  });

  test("user-typed-first guard clears pending (timestamp + count)", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const plugin = await freshPlugin(makeClient());
    await plugin.event({ event: quotaError("q-user", "0") });
    await new Promise((r) => setTimeout(r, 20));
    // Timestamp signal: user message landed after arming.
    await plugin.event({
      event: idle("q-user", { lastUserMessageAt: Date.now() + 1000 }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(0);
    // Still disarmed afterwards.
    await plugin.event({ event: idle("q-user") });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(0);
  });

  test("user-typed-first guard via user message count growth", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const plugin = await freshPlugin(makeClient());
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "q-count",
          userMessageCount: 5,
          error: { status: 429, message: "rate limit" },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    await plugin.event({ event: idle("q-count", { userMessageCount: 7 }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(0);
  });

  test("generic count growth does not stand down (assistant messages)", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "0";
    const plugin = await freshPlugin(makeClient());
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "q-generic",
          messageCount: 5,
          error: { name: "APIError", data: { message: "rate limit", statusCode: 429, responseHeaders: { "retry-after": "0" } } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    await plugin.event({ event: idle("q-generic", { messageCount: 7 }) });
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts.length).toBe(1);
  });
});

describe("opencode parked-timer races (round-2)", () => {
  test("late idle during timer in-flight send does not double-send", async () => {
    process.env.AUTO_CONTINUE_MIN_DELAY = "1";
    const client = makeClient({ delayMs: 250 });
    const plugin = await freshPlugin(client);
    await plugin.event({ event: quotaError("q-timer", "1") });
    await new Promise((r) => setTimeout(r, 30));
    await plugin.event({ event: idle("q-timer") });
    // Timer fires ~1s after arm; its sendResume blocks 250ms in promptAsync.
    // A late idle arriving inside that window must see the claim and park,
    // not re-drain the (now-empty) queue / re-send.
    await new Promise((r) => setTimeout(r, 1050));
    const midSend = plugin.event({ event: idle("q-timer") });
    await midSend;
    await new Promise((r) => setTimeout(r, 400));
    expect(prompts.length).toBe(1);
    expect(prompts[0].id).toBe("q-timer");
  }, 10000);
});
