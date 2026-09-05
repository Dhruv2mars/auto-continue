#!/usr/bin/env node
/**
 * lab/fake-claude.mjs — fake `claude --resume` target for harness isolation lab.
 *
 * Usage (called by core/cli.mjs resume watcher via AUTO_CONTINUE_RESUME_CMD_CLAUDE):
 *   node lab/fake-claude.mjs "$1" "$2"
 *   $1 = session_id, $2 = queued prompt (remaining argv joined as prompt)
 *
 * Manual:
 *   node lab/fake-claude.mjs test-session "Continue from where the turn was interrupted."
 *
 * Behavior: appends one JSON line to lab/runs.log, exits 0. Never touches real CLI.
 * Isolation: forces AUTO_CONTINUE_HOME to lab/home unless caller already set it
 * to an explicit temp/lab dir. Never falls through to ~/.auto-continue.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_HOME = join(LAB_DIR, "home");
const RUNS_LOG = join(LAB_DIR, "runs.log");

function defaultHome() {
  return join(homedir(), ".auto-continue");
}

function ensureIsolatedHome() {
  const cur = process.env.AUTO_CONTINUE_HOME;
  if (!cur || cur === defaultHome() || cur === "~/.auto-continue") {
    process.env.AUTO_CONTINUE_HOME = LAB_HOME;
  }
}

ensureIsolatedHome();
mkdirSync(LAB_DIR, { recursive: true });

const args = process.argv.slice(2);
const sessionId = args[0] ?? "";
const prompt = args.slice(1).join(" ");
const entry = {
  ts: new Date().toISOString(),
  script: "fake-claude",
  sessionId,
  prompt,
  argv: args,
  home: process.env.AUTO_CONTINUE_HOME,
};
appendFileSync(RUNS_LOG, JSON.stringify(entry) + "\n");
process.exit(0);
