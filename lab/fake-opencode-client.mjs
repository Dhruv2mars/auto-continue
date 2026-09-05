#!/usr/bin/env node
/**
 * lab/fake-opencode-client.mjs — minimal { session: { promptAsync } } stub.
 *
 * Usage in a node REPL / script:
 *   import { client, calls } from "./fake-opencode-client.mjs";
 *   import { AutoContinue } from "../adapters/opencode/index.js";
 *   const plugin = await AutoContinue({ client });
 *   await plugin.event({ event: { type: "session.error", properties: {...} } });
 *   await plugin.event({ event: { type: "session.idle", properties: {...} } });
 *
 * Behavior: promptAsync records one JSON line per call to lab/runs.log
 * (sessionId + prompt text) and resolves { ok: true }. Never hits a provider.
 *
 * Isolation: forces AUTO_CONTINUE_HOME to lab/home unless caller already set
 * it to an explicit temp/lab dir. Never falls through to ~/.auto-continue.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_HOME = join(LAB_DIR, "home");
const RUNS_LOG = join(LAB_DIR, "runs.log");

function ensureIsolatedHome() {
  const realHome = process.env.HOME || "/tmp";
  const cur = process.env.AUTO_CONTINUE_HOME;
  const isolated =
    cur && (cur.includes(LAB_DIR) || cur.includes(process.env.TMPDIR || "/tmp") || cur.includes("/tmp/"));
  if (!isolated || cur === join(realHome, ".auto-continue") || cur === "~/.auto-continue") {
    process.env.AUTO_CONTINUE_HOME = LAB_HOME;
  }
}

ensureIsolatedHome();
mkdirSync(LAB_DIR, { recursive: true });

export const calls = [];

function promptTextOf(args) {
  try {
    const parts = args?.body?.parts ?? [];
    return parts.map((p) => p?.text ?? "").join("\n");
  } catch {
    return "";
  }
}

function sessionIdOf(args) {
  return args?.path?.id ?? args?.sessionID ?? args?.sessionId ?? "default";
}

export const client = {
  session: {
    async promptAsync(args) {
      const entry = {
        ts: new Date().toISOString(),
        script: "fake-opencode-client",
        sessionId: sessionIdOf(args),
        prompt: promptTextOf(args),
        args,
        home: process.env.AUTO_CONTINUE_HOME,
      };
      calls.push(entry);
      appendFileSync(RUNS_LOG, JSON.stringify(entry) + "\n");
      return { ok: true };
    },
  },
};

export default client;

// Manual smoke: node lab/fake-opencode-client.mjs <sessionId> [prompt...]
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [sessionId = "test-session", ...rest] = process.argv.slice(2);
  await client.session.promptAsync({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: rest.join(" ") || "Continue." }] },
  });
  process.exit(0);
}
