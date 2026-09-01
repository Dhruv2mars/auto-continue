import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let prompts;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ac-oc-"));
  process.env.AUTO_CONTINUE_HOME = home;
  process.env.AUTO_CONTINUE_MIN_DELAY = "1";
  prompts = [];
  const mod = await import(`../adapters/opencode/index.js?t=${Date.now()}`);
  globalThis.__ac = mod;
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  delete process.env.AUTO_CONTINUE_MIN_DELAY;
  rmSync(home, { recursive: true, force: true });
});

function makePlugin() {
  const client = {
    session: {
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, text: body.parts[0].text });
      },
    },
  };
  return globalThis.__ac.AutoContinue({ client });
}

const quotaError = {
  type: "session.error",
  properties: {
    sessionID: "oc-sess-1",
    error: { name: "APIError", data: { message: "rate limit exceeded", statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "1" } } },
  },
};

describe("opencode adapter", () => {
  test("session.error with 429 arms a pending resume and logs", async () => {
    const plugin = await makePlugin();
    await plugin.event({ event: quotaError });
    const { readdirSync, readFileSync } = await import("node:fs");
    const log = readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.at(-1).harness).toBe("opencode");
    expect(log.at(-1).kind).toBe("rate_limit");
    expect(log.at(-1).action).toBe("resume_later");
  });

  test("session.idle after armed error re-prompts the session", async () => {
    const plugin = await makePlugin();
    await plugin.event({ event: quotaError });
    await new Promise((r) => setTimeout(r, 30));
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "oc-sess-1" } } });
    await new Promise((r) => setTimeout(r, 1300));
    expect(prompts.length).toBe(1);
    expect(prompts[0].id).toBe("oc-sess-1");
    expect(prompts[0].text).toMatch(/Continue/);
  });

  test("idle without pending error does nothing", async () => {
    const plugin = await makePlugin();
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "oc-sess-2" } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(0);
  });

  test("auth errors never schedule a resume", async () => {
    const plugin = await makePlugin();
    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "oc-sess-3", error: { name: "ProviderAuthError", message: "invalid api key" } },
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "oc-sess-3" } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(0);
  });

  test("cap reached stops resuming", async () => {
    const plugin = await makePlugin();
    for (let i = 0; i < 4; i++) {
      await plugin.event({ event: quotaError });
    }
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = log.filter((r) => r.event === "session_error").at(-1);
    expect(last.action).toBe("give_up");
  });
});
