#!/usr/bin/env node
/**
 * Shared hook entry for claude / zcode / codex / cursor.
 * Usage: node auto-continue.mjs <harness> <event> [--fixture FILE] [--dry] [--max-continues N] [--max-wait SEC]
 * Reads the hook payload JSON on stdin, classifies it, decides, acts.
 * Never exits nonzero from internal errors: a broken hook must not break the session.
 */
import { spawn } from "node:child_process";
import { classify } from "./lib/classify.mjs";
import { decide, blockDecision } from "./lib/policy.mjs";
import { loadState, saveState, appendLog, sessionKey } from "./lib/state.mjs";

const EVENT_ALIASES = {
  stop: "stop",
  stop_failure: "stop_failure",
  stopfailure: "stop_failure",
  subagentstop: "subagent_stop",
  subagent_stop: "subagent_stop",
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--dry") args.dry = true;
    else if (a === "--max-continues") args.maxContinues = parseInt(argv[++i], 10);
    else if (a === "--max-wait") args.maxWaitSec = parseInt(argv[++i], 10);
    else args._.push(a);
  }
  return args;
}

function intEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function readStdin(ms = 10000) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(safeParse(data)), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(safeParse(data)); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(safeParse(data)); });
  });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function sessionOf(payload) {
  return payload.session_id ?? payload.sessionId ?? payload.sessionID ?? payload.session?.sessionID ?? "default";
}

function emitFor(harness, event, decision, done) {
  if (event !== "stop") return done();
  const payload = harness === "cursor"
    ? { followup_message: decision.reason }
    : blockDecision(decision.reason);
  process.stdout.write(JSON.stringify(payload) + "\n", done);
}

const DAILY_RESUME_CEILING = 20;

async function globalResumeCountToday(home) {
  try {
    const { readFile } = await import("node:fs/promises");
    const meta = JSON.parse(await readFile(`${home}/state/_global.json`, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    return meta.day === today ? meta.resumes : 0;
  } catch {
    return 0;
  }
}

async function bumpGlobalResumeCount(home) {
  const today = new Date().toISOString().slice(0, 10);
  const count = (await globalResumeCountToday(home)) + 1;
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(`${home}/state`, { recursive: true });
  await writeFile(`${home}/state/_global.json`, JSON.stringify({ day: today, resumes: count }));
  return count;
}

function spawnWatcher(harness, sessionId, delaySec, opts) {
  let resumeCmdTpl = opts.resumeCmd || 'claude --resume "$1" -p "$2"';
  resumeCmdTpl = resumeCmdTpl.replaceAll("{session_id}", '"$1"').replaceAll("{prompt}", '"$2"');
  const prompt = process.env.AUTO_CONTINUE_PROMPT || "Continue from where the turn was interrupted by the usage limit.";
  const logFile = `${opts.home}/resumes/${new Date().toISOString().replace(/[:.]/g, "-")}-${sessionKey(sessionId)}.log`;
  const sh = `mkdir -p "${opts.home}/resumes" && sleep ${delaySec} && cd "${opts.cwd}" && { ${resumeCmdTpl}; } >> "$3" 2>&1`;
  const child = spawn("/bin/sh", ["-c", sh, "auto-continue", sessionId, prompt, logFile], { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const harness = args._[0] || "claude";
  const event = EVENT_ALIASES[(args._[1] || "stop").toLowerCase()] || "stop";
  const payload = args.fixture ? safeParse(await (await import("node:fs/promises")).readFile(args.fixture, "utf8")) : await readStdin();

  const home = process.env.AUTO_CONTINUE_HOME || `${process.env.HOME || "/tmp"}/.auto-continue`;
  const sessionId = sessionOf(payload);
  const state = await loadState(sessionId);
  const matcher = payload.matcher ?? (payload.hook_event_name === "StopFailure" ? (payload.error?.type ?? payload.reason) : undefined);
  const classification = classify({
    payload,
    matcher,
    error: payload.error ?? payload.last_error,
    text: payload.last_assistant_message ?? payload.lastAssistantMessage ?? payload.reason ?? payload.message,
  });

  const decision = decide(classification, state, {
    harness,
    maxContinues: args.maxContinues ?? intEnv("AUTO_CONTINUE_MAX_CONTINUES"),
    maxWaitSec: args.maxWaitSec ?? intEnv("AUTO_CONTINUE_MAX_WAIT"),
    minDelaySec: intEnv("AUTO_CONTINUE_MIN_DELAY"),
  });

  const pluginEnv = Object.keys(process.env).filter((k) => /ZCODE|CLAUDE|CODEX|CURSOR|PLUGIN|SESSION/i.test(k)).sort();
  await appendLog({ harness, event, session: sessionId, kind: classification.kind, source: classification.source, action: decision.action, delaySec: decision.delaySec, continues: state.continues, dry: !!args.dry, payloadKeys: Object.keys(payload).sort(), pluginEnv });

  if (decision.action === "continue_now" && event === "stop") {
    await saveState(sessionId, { ...state, continues: decision.continueIndex });
    await new Promise((resolve) => emitFor(harness, "stop", decision, resolve));
    return decision;
  }

  if (decision.action === "resume_later") {
    const canResume = !args.dry && process.env.AUTO_CONTINUE_RESUME !== "0";
    const recentlyArmed = state.watcherArmedAt && Date.now() - state.watcherArmedAt < 120000;
    const globalCount = await globalResumeCountToday(home);
    const overCeiling = globalCount >= DAILY_RESUME_CEILING;
    const spawned = canResume && !recentlyArmed && !overCeiling
      ? spawnWatcher(harness, sessionId, decision.delaySec, { home, cwd: process.cwd(), resumeCmd: process.env[`AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()}`] })
      : false;
    await saveState(sessionId, { ...state, continues: decision.continueIndex, watcherArmedAt: spawned ? Date.now() : state.watcherArmedAt });
    if (spawned) await bumpGlobalResumeCount(home);
    if (!spawned) {
      const why = recentlyArmed ? "watcher already armed" : overCeiling ? `daily resume ceiling (${DAILY_RESUME_CEILING}) reached` : "auto-resume disabled or unsupported harness";
      process.stderr.write(`[auto-continue] ${decision.reason} (${why})\n`);
    }
    return { ...decision, spawned };
  }

  if (decision.action === "notify_only") {
    process.stderr.write(`[auto-continue] ${decision.reason}\n`);
  }

  if (decision.action === "ignore" && event === "stop" && state.continues !== 0) {
    await saveState(sessionId, { ...state, continues: 0 });
  }
  return decision;
}

process.once("uncaughtException", (err) => {
  appendLog({ harness: "unknown", event: "crash", kind: "error", source: "uncaught", action: "ignore", detail: String(err?.message || err) }).finally(() => process.exit(0));
});

if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
