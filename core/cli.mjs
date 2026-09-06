#!/usr/bin/env node
/**
 * Shared hook entry for claude / zcode / codex / cursor, plus a prompt queue.
 * Hook usage: node cli.mjs <harness> <event> [--fixture FILE] [--dry] [--max-continues N] [--max-wait SEC]
 * Queue usage: node cli.mjs enqueue <sessionId> <prompt...> [--dry] [--max-continues N] [--max-wait SEC]
 *              node cli.mjs list <sessionId>
 *              node cli.mjs clear <sessionId>
 * The watcher that wakes after a quota window drains the queue head and sends
 * it as the resume prompt; an empty queue falls back to the canned prompt.
 * Reads the hook payload JSON on stdin, classifies it, decides, acts.
 * Never exits nonzero from internal errors: a broken hook must not break the session.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./lib/classify.mjs";
import { decide, blockDecision, HARNESS_CAPS, DEFAULTS } from "./lib/policy.mjs";
import { loadState, saveState, appendLog, sessionKey } from "./lib/state.mjs";
import { enqueue, listQueue, clearQueue, restoreDraining, readDraining } from "./lib/queue.mjs";
import { homeDir } from "./lib/state.mjs";
import { detectHarness } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAIN_MJS = join(HERE, "drain.mjs");
const DRAIN_ACK_MJS = join(HERE, "drain-ack.mjs");
const DRAIN_SETTLE_MJS = join(HERE, "drain-settle.mjs");
const PROBE_MJS = join(HERE, "probe.mjs");
const CANNED_PROMPT = "Continue from where the turn was interrupted by the usage limit.";
// Default resume consumes the drained queue file ($AC_PROMPT_FILE, exported
// by the watcher), falling back to the canned $2 when the file is empty.
// Double-quoted command substitution: file content is taken literally,
// never re-expanded, so hostile prompts cannot inject. $1/$2 positionals kept.
const DEFAULT_RESUME_CMD = 'claude --resume "$1" -p "$(if [ -s "$AC_PROMPT_FILE" ]; then cat "$AC_PROMPT_FILE"; else printf \'%s\' "$2"; fi)"';
const DEDUPE_WINDOW_MS = 120000;
const QUEUE_CMDS = new Set(["enqueue", "list", "clear", "status"]);

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
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    else if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--dry") args.dry = true;
    else if (a === "--max-continues") args.maxContinues = parseInt(argv[++i], 10);
    else if (a === "--max-wait") args.maxWaitSec = parseInt(argv[++i], 10);
    else if (a === "--harness") args.harness = argv[++i];
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

function normalizeHarness(h) {
  return String(h ?? "claude").toLowerCase() || "claude";
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

/** Single-quote a string for safe embedding in a shell command. */
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function spawnWatcher(harness, sessionId, delaySec, opts) {
  let resumeCmdTpl = opts.resumeCmd || (harness === "claude" ? DEFAULT_RESUME_CMD : undefined);
  resumeCmdTpl = resumeCmdTpl.replaceAll("{session_id}", '"$1"').replaceAll("{prompt}", '"$2"');
  const prompt = process.env.AUTO_CONTINUE_PROMPT || CANNED_PROMPT;
  const delay = Number.isFinite(delaySec) ? Math.max(0, delaySec) : DEFAULTS.minDelaySec;
  const logFile = `${opts.home}/resumes/${new Date().toISOString().replace(/[:.]/g, "-")}-${sessionKey(sessionId)}.log`;
  // On wake, drain the queue head into $AC_PROMPT_FILE (never via shell
  // expansion, so quotes/newlines in the prompt cannot inject). The default
  // template consumes the file via double-quoted $(cat ...) with a $2
  // fallback when empty; custom templates keep $1/$2 positionals and read
  // stdin. The drain-settle helper owns the final state: ack .draining when
  // the resume exits 0, restore it to the queue head when it exits nonzero.
  // The template runs in a subshell so a resume that calls `exit N` fails
  // only itself — an unwrapped `exit` would kill the watcher shell before
  // settle runs and orphan the .draining head. AUTO_CONTINUE_HOME inherited.
  //
  // Probe-before-send: when a probe is configured, the wake first checks
  // quota (core/probe.mjs, override per harness with
  // AUTO_CONTINUE_PROBE_CMD_<H>). Still limited -> re-arm with backoff
  // (AUTO_CONTINUE_PROBE_BACKOFF, default "45 300 1800") until attempts run
  // out, then give up with the queue untouched (next limit event re-arms).
  // Probe failures count as still-limited: never send into a dead quota.
  const probeEnabled = opts.probe === true || (opts.probe !== false && probeConfigured(harness));
  const backoff = probeBackoffSec();
  const sh = `mkdir -p ${sq(`${opts.home}/resumes`)} && sleep ${delay} && cd ${sq(opts.cwd)} && ` +
    (probeEnabled
      ? `backoff=${sq(backoff.join(" "))}; attempt=0; while [ "$attempt" -lt ${backoff.length} ]; do if ${sq(process.execPath)} ${sq(PROBE_MJS)} ${sq(harness)} >> "$3" 2>&1; then break; fi; wait_s=$(echo $backoff | cut -d' ' -f$((attempt + 1))); echo "probe: still limited; re-arming in ${"$"}{wait_s}s (attempt $((attempt + 1))/${backoff.length})" >> "$3"; sleep "$wait_s"; attempt=$((attempt + 1)); done; if [ "$attempt" -ge ${backoff.length} ]; then echo "probe: giving up (quota still limited); queue left intact" >> "$3"; ${sq(process.execPath)} ${sq(DRAIN_SETTLE_MJS)} "$1" giveup < /dev/null; exit 0; fi; `
      : ``) +
    `export AC_PROMPT_FILE="$(mktemp)" && ${sq(process.execPath)} ${sq(DRAIN_MJS)} "$1" > "$AC_PROMPT_FILE" < /dev/null; drain_rc=$?; if [ "$drain_rc" -eq 3 ]; then echo "drain: another watcher owns the delivery; standing down" >> "$3"; elif [ -s "$AC_PROMPT_FILE" ]; then ${sq(process.execPath)} ${sq(DRAIN_SETTLE_MJS)} "$1" begin "$(cat "$AC_PROMPT_FILE")" < /dev/null; if ( ${resumeCmdTpl} ) < "$AC_PROMPT_FILE"; then ${sq(process.execPath)} ${sq(DRAIN_SETTLE_MJS)} "$1" < /dev/null; else ${sq(process.execPath)} ${sq(DRAIN_SETTLE_MJS)} "$1" fail < /dev/null; fi; else printf '%s' "$2" | ( ${resumeCmdTpl} ); fi >> "$3" 2>&1; rm -f "$AC_PROMPT_FILE"`;
  const child = spawn("/bin/sh", ["-c", sh, "auto-continue", sessionId, prompt, logFile], { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

/** Probe is on when a per-harness command is set or AUTO_CONTINUE_PROBE=1. */
function probeConfigured(harness) {
  if (process.env.AUTO_CONTINUE_PROBE === "0") return false;
  if (process.env[`AUTO_CONTINUE_PROBE_CMD_${harness.toUpperCase()}`]) return true;
  return process.env.AUTO_CONTINUE_PROBE === "1";
}

/** Re-arm ladder, seconds. Default 45 -> 300 -> 1800, each >= 1s. */
function probeBackoffSec() {
  const raw = (process.env.AUTO_CONTINUE_PROBE_BACKOFF || "45 300 1800")
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return raw.length ? raw : [45, 300, 1800];
}

function effectiveMaxWaitSec(args) {
  const finite = (n, fb) => (Number.isFinite(n) ? n : fb);
  return finite(args.maxWaitSec ?? intEnv("AUTO_CONTINUE_MAX_WAIT"), DEFAULTS.maxWaitSec);
}

function enqueueDelaySec(args) {
  const finite = (n, fb) => (Number.isFinite(n) ? n : fb);
  const minDelay = finite(intEnv("AUTO_CONTINUE_MIN_DELAY"), DEFAULTS.minDelaySec);
  return Math.min(Math.max(minDelay, 0), effectiveMaxWaitSec(args));
}

function enqueueCap(args, harness) {
  const finite = (n, fb) => (Number.isFinite(n) ? n : fb);
  return Math.min(
    finite(args.maxContinues ?? intEnv("AUTO_CONTINUE_MAX_CONTINUES"), Infinity),
    HARNESS_CAPS[harness] ?? 3,
  );
}

function queueOut(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** True while a watcher delivery for this session is in flight, proven by
 * the drain-settle marker; a stale marker (watcher died mid-send) ages out
 * after 10 minutes so the hook's ack path cannot be blocked forever. */
async function settlingInProgress(sessionId) {
  try {
    const dir = join(homeDir(), "queue");
    const markerPath = join(dir, `${sessionKey(sessionId)}.settling`);
    const { stat } = await import("node:fs/promises");
    const info = await stat(markerPath).catch(() => null);
    if (!info) return false;
    return Date.now() - info.mtimeMs < 10 * 60 * 1000;
  } catch {
    return false;
  }
}

async function logQuiet(entry) {
  try { await appendLog(entry); } catch { /* audit log must never break the cli */ }
}

async function runQueueCmd(cmd, args) {
  const home = process.env.AUTO_CONTINUE_HOME || `${process.env.HOME || "/tmp"}/.auto-continue`;
  const harness = normalizeHarness(args.harness ?? process.env.AUTO_CONTINUE_HARNESS ?? detectHarness());
  const sessionId = args._[1] ?? "default";

  if (cmd === "list") {
    queueOut(await listQueue(sessionId));
    return { cmd, session: sessionId };
  }

  if (cmd === "clear") {
    const cleared = await clearQueue(sessionId);
    await logQuiet({ harness, event: "queue_clear", session: sessionId, kind: "queue", source: "cli", action: "cleared", detail: String(cleared) });
    queueOut({ session: sessionId, cleared });
    return { cmd, session: sessionId, cleared };
  }

  if (cmd === "status") {
    const [items, state, draining, globalCount] = await Promise.all([
      listQueue(sessionId),
      loadState(sessionId),
      readDraining(sessionId),
      globalResumeCountToday(home),
    ]);
    const armedAt = state.watcherArmedAt ?? 0;
    const armed = Boolean(armedAt && Date.now() - armedAt < DEDUPE_WINDOW_MS);
    queueOut({
      session: sessionId,
      harness,
      queued: items.length,
      head: items[0] ?? null,
      draining,
      continues: state.continues ?? 0,
      watcherArmed: armed,
      watcherArmedAt: armedAt || null,
      dailyResumes: globalCount,
      dailyCeiling: DAILY_RESUME_CEILING,
    });
    return { cmd, session: sessionId };
  }

  // enqueue: prompt is the remaining positional args (use `--` when it starts with `-`).
  const prompt = args._.slice(2).join(" ");
  if (!prompt.trim()) {
    queueOut({ armed: false, session: sessionId, queued: 0, reason: "prompt must not be empty" });
    return { cmd, armed: false };
  }
  const state = await loadState(sessionId);
  const items = await listQueue(sessionId);
  const cap = enqueueCap(args, harness);
  const armedAt = state.watcherArmedAt ?? 0;
  // Hard gates run before the write: a cap-blocked enqueue must not store a
  // prompt it reports as rejected (nothing would ever drain it — the file
  // would read as pending forever).
  if (state.continues >= cap) {
    const reason = `auto-continue reached its cap of ${cap} continuations for this session`;
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queue_blocked", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: items.length, reason });
    return { cmd, armed: false };
  }
  if (armedAt && Date.now() - armedAt < DEDUPE_WINDOW_MS) {
    const etaSec = Math.ceil((DEDUPE_WINDOW_MS - (Date.now() - armedAt)) / 1000);
    const reason = `watcher already armed (retry in ${etaSec}s)`;
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queue_blocked", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: items.length, reason });
    return { cmd, armed: false };
  }
  try {
    await enqueue(sessionId, prompt);
  } catch (err) {
    queueOut({ armed: false, session: sessionId, queued: (await listQueue(sessionId)).length, reason: String(err?.message || err) });
    return { cmd, armed: false };
  }
  const refreshed = await listQueue(sessionId);
  // A fresh .settling marker proves a delivery is in flight: its .draining
  // head is owned by that watcher's settle, and the dedupe window cannot be
  // trusted to cover long deliveries (probe ladders run 45/300/1800s). The
  // prompt is stored (it drains FIFO after the in-flight settle) but no
  // second watcher is armed — that would re-drain the same head.
  if (await settlingInProgress(sessionId)) {
    const reason = "delivery in flight; prompt queued for the next wake";
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queued", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  // One clear rule beyond the 120s hard block: the previous watcher may still
  // be sleeping (delays run up to maxWait), so arming a second sleeper while
  // the queue is already non-empty only stacks watchers on the same session.
  // The already-queued prompt(s) ride the first watcher; report armed:false.
  const maxWaitSec = effectiveMaxWaitSec(args);
  if (armedAt && Date.now() - armedAt < maxWaitSec * 1000 && refreshed.length > 1) {
    const delay = enqueueDelaySec(args);
    const reason = `watcher already queued (queue depth ${refreshed.length}; resume in ~${delay}s)`;
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queue_blocked", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  const globalCount = await globalResumeCountToday(home);
  if (globalCount >= DAILY_RESUME_CEILING) {
    const reason = `daily resume ceiling (${DAILY_RESUME_CEILING}) reached`;
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queue_blocked", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  if (args.dry) {
    const reason = "dry run: prompt queued, watcher not armed";
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queued", dry: true, detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  if (process.env.AUTO_CONTINUE_RESUME === "0") {
    const reason = "auto-resume disabled (AUTO_CONTINUE_RESUME=0)";
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queued", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  const resumeCmd = process.env[`AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()}`];
  // The claude template is claude-only: another harness with no explicit
  // resume cmd must refuse honestly instead of silently running the real
  // claude binary against its session ids.
  if (harness !== "claude" && !resumeCmd) {
    const reason = `no AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()} configured; set it to enable detached resume (prompt stays queued)`;
    await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "queued", detail: reason });
    queueOut({ armed: false, session: sessionId, queued: refreshed.length, reason });
    return { cmd, armed: false };
  }
  const delay = enqueueDelaySec(args);
  spawnWatcher(harness, sessionId, delay, { home, cwd: process.cwd(), resumeCmd: process.env[`AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()}`] });
  await saveState(sessionId, { ...state, watcherArmedAt: Date.now() });
  await bumpGlobalResumeCount(home);
  await logQuiet({ harness, event: "enqueue", session: sessionId, kind: "queue", source: "cli", action: "watcher_armed", delaySec: delay });
  queueOut({ armed: true, session: sessionId, queued: refreshed.length, delaySec: delay, reason: `watcher armed, resume in ${delay}s` });
  return { cmd, armed: true, delaySec: delay };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const first = String(args._[0] ?? "").toLowerCase();
  if (QUEUE_CMDS.has(first)) {
    return runQueueCmd(first, args);
  }
  const harness = normalizeHarness(args.harness ?? args._[0] ?? "claude");
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
    // A fresh .settling marker proves a delivery is in flight: the .draining
    // head is owned by that watcher's settle (ack or restore). Restoring or
    // re-arming here would re-drain the same head — a duplicate delivery and
    // a stranded prompt. Stale/no marker (watcher presumed dead) proceeds:
    // the restore is the crash recovery, and drain.mjs re-drains FIFO.
    const deliveryInFlight = await settlingInProgress(sessionId);
    if (!deliveryInFlight) {
      try { await restoreDraining(sessionId); } catch {}
    }
    const canResume = !args.dry && process.env.AUTO_CONTINUE_RESUME !== "0";
    const resumeCmd = process.env[`AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()}`];
    // The claude template is claude-only: another harness with no explicit
    // resume cmd must refuse honestly instead of silently running the real
    // claude binary against its session ids.
    const hasTemplate = Boolean(resumeCmd) || harness === "claude";
    const recentlyArmed = state.watcherArmedAt && Date.now() - state.watcherArmedAt < DEDUPE_WINDOW_MS;
    const globalCount = await globalResumeCountToday(home);
    const overCeiling = globalCount >= DAILY_RESUME_CEILING;
    const spawned = canResume && hasTemplate && !deliveryInFlight && !recentlyArmed && !overCeiling
      ? spawnWatcher(harness, sessionId, decision.delaySec, { home, cwd: process.cwd(), resumeCmd })
      : false;
    await saveState(sessionId, { ...state, continues: decision.continueIndex, watcherArmedAt: spawned ? Date.now() : state.watcherArmedAt });
    if (spawned) await bumpGlobalResumeCount(home);
    if (!spawned) {
      const why = deliveryInFlight
        ? "delivery in flight"
        : recentlyArmed
          ? "watcher already armed"
          : overCeiling
            ? `daily resume ceiling (${DAILY_RESUME_CEILING}) reached`
            : !hasTemplate
              ? `no AUTO_CONTINUE_RESUME_CMD_${harness.toUpperCase()} configured; set it to enable detached resume`
              : "auto-resume disabled or unsupported harness";
      process.stderr.write(`[auto-continue] ${decision.reason} (${why})\n`);
    }
    return { ...decision, spawned };
  }

  if (decision.action === "notify_only" || decision.action === "give_up") {
    // Terminal decisions must be observer-visible: give_up is the one
    // decision that previously fell through silently (empty stdout+stderr
    // reads as success, so the harness kept looping into its own kill switch).
    process.stderr.write(`[auto-continue] ${decision.reason}\n`);
  }

  // Ack the in-flight .draining head only in the ignore+stop healthy-reset
  // branch: the delivered head's session turned over cleanly (continues was
  // nonzero, now reset), so the delivery is confirmed. Never ack on a
  // limit-classified stop: OVERLOADED takes the continue_now path above and
  // returns early, and ignore with continues===0 means no delivery happened,
  // so the head stays in flight for restore on the next limit.
  //
  // While a delivery is provably in flight (fresh .settling marker) the head
  // is owned by the watcher's settle: ack would orphan a resume about to
  // fail. A STALE marker is ambiguous (dead watcher vs slow resume), so the
  // head is restored instead of dropped — settle then no-ops on success, and
  // a resume that exits nonzero finds its prompt already back. The hook never
  // drops a head; only drain-settle (which saw the exit code) does.
  if (decision.action === "ignore" && event === "stop" && state.continues !== 0) {
    await saveState(sessionId, { ...state, continues: 0 });
    if (!await settlingInProgress(sessionId)) {
      try { await restoreDraining(sessionId); } catch {}
    }
  }
  return decision;
}

process.once("uncaughtException", (err) => {
  appendLog({ harness: "unknown", event: "crash", kind: "error", source: "uncaught", action: "ignore", detail: String(err?.message || err) }).finally(() => process.exit(0));
});

if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) {
  main().then(() => process.exit(0)).catch(() => process.exit(0));
}
