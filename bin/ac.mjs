#!/usr/bin/env node
/**
 * ac — queue a prompt now, send it when your 5h rate-limit window reopens.
 *
 * You already know when the limit resets; the harness just told you. So you
 * type the time. There is no detection, no classification, no polling.
 *
 * The timer IS the process: `ac add` forks one detached `sleep N; send` per
 * queued prompt. No daemon, so no pid file, no startup race, no coordination.
 *
 * queue.json is a VIEW, not the source of truth — the sleeper carries its
 * prompt in its own file and needs nothing else to do its job. Because
 * nothing gates on the JSON, it cannot deadlock or corrupt a delivery.
 *
 *   ac add 3pm finish the migration
 *   ac add +5h run the test suite and fix what breaks
 *   ac list
 *   ac cancel <id>
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync,
} from "node:fs";

const HOME = process.env.AUTO_CONTINUE_HOME || join(homedir(), ".auto-continue");
const QUEUE = join(HOME, "queue.json");
const PAD_SEC = Number(process.env.AC_PAD_SEC ?? 60);  // clock slop: windows reopen a little late
const RETRIES = 3;           // send attempts, 5 min apart, if the first is early
const RETRY_SEC = Number(process.env.AC_RETRY_SEC ?? 300);
const GRACE_SEC = 30 * 60;   // past this, an unsent entry is orphaned regardless of pid
const KEEP_DAYS = 7;

// One line per harness: $1 is the session id (may be empty), $2 the prompt file.
const SEND = {
  claude: `claude --resume "$1" -p --permission-mode acceptEdits "$(cat "$2")"`,
  claude_nosession: `claude -c -p --permission-mode acceptEdits "$(cat "$2")"`,
};

function dir(...p) {
  const d = join(HOME, ...p);
  mkdirSync(d, { recursive: true });
  try { chmodSync(HOME, 0o700); } catch {}
  return d;
}

function readQueue() {
  try { return JSON.parse(readFileSync(QUEUE, "utf8")); } catch { return []; }
}

function writeQueue(entries) {
  dir();
  const tmp = `${QUEUE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, QUEUE);
}

/**
 * Parse a time the USER typed — not provider prose. Absolute ("3pm", "15:30")
 * resolves to the next occurrence; relative ("+5h", "90m") counts from now.
 * Anything else throws, loudly, while you are still at the keyboard.
 */
export function parseWhen(input, now = new Date()) {
  const s = String(input || "").trim().toLowerCase();
  let m = s.match(/^\+?(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    const sec = unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
    return new Date(now.getTime() + Math.round(sec) * 1000);
  }
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3];
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) throw new Error(`not a time: ${input}`);
    const t = new Date(now);
    t.setHours(h, min, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  }
  throw new Error(`cannot read "${input}" as a time — try 3pm, 15:30, +5h, or 90m`);
}

function detectHarness(env = process.env) {
  if (env.ZCODE_SESSION_ID) return "zcode";
  if (env.CODEX_SESSION_ID) return "codex";
  if (env.CURSOR_SESSION_ID) return "cursor";
  return "claude";
}

function detectSession(env = process.env) {
  return env.AC_SESSION || env.CLAUDE_CODE_SESSION_ID || env.ZCODE_SESSION_ID ||
    env.CODEX_SESSION_ID || env.CURSOR_SESSION_ID || "";
}

function sendTemplate(harness, session) {
  const override = process.env[`AC_SEND_${harness.toUpperCase()}`];
  if (override) return override;
  if (harness === "claude") return session ? SEND.claude : SEND.claude_nosession;
  return null; // no guessing another harness's CLI: refuse and say so
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sentMarker(id) {
  return join(HOME, "sent", id);
}

function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Fork the sleeper. It waits out the window, optionally serialises behind an
 * earlier send into the same session, then runs the harness command with the
 * prompt supplied as a FILE — never interpolated into the shell string.
 */
function fork(entry, delaySec) {
  const tpl = sendTemplate(entry.harness, entry.session);
  if (!tpl) throw new Error(`no send command for ${entry.harness}; set AC_SEND_${entry.harness.toUpperCase()}`);
  const log = join(dir("logs"), `${entry.id}.log`);
  const marker = sentMarker(entry.id);
  dir("sent");
  const wait = entry.waitPid
    ? `while kill -0 ${entry.waitPid} 2>/dev/null; do sleep 2; done; `
    : "";
  const sh =
    `sleep ${Math.max(0, Math.round(delaySec))}; ${wait}` +
    `cd ${sq(entry.cwd)} || exit 1; ` +
    `i=0; while [ $i -lt ${RETRIES} ]; do ` +
    `if ( ${tpl} ) >> ${sq(log)} 2>&1; then break; fi; ` +
    `i=$((i+1)); [ $i -lt ${RETRIES} ] && sleep ${RETRY_SEC}; done; ` +
    `touch ${sq(marker)}`;
  const child = spawn("/bin/sh", ["-c", sh, "ac", entry.session, entry.promptFile], {
    detached: true, stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

/**
 * Reboot recovery, and the only "daemon" here: every invocation re-forks any
 * entry whose sleeper is gone. Overdue ones fire immediately.
 */
function reconcile(entries, now = Date.now()) {
  let changed = false;
  for (const e of entries) {
    if (existsSync(sentMarker(e.id))) continue;
    const overdue = now > e.sendAt + GRACE_SEC * 1000;
    if (alive(e.pid) && !overdue) continue;
    try {
      e.pid = fork(e, Math.max(0, (e.sendAt - now) / 1000));
      changed = true;
    } catch { /* unconfigured harness: leave it listed, report on `list` */ }
  }
  return changed;
}

function prune(entries, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 86400000;
  const keep = [];
  for (const e of entries) {
    if (e.createdAt > cutoff) { keep.push(e); continue; }
    for (const p of [e.promptFile, sentMarker(e.id), join(HOME, "logs", `${e.id}.log`)]) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  return keep;
}

function status(e) {
  if (existsSync(sentMarker(e.id))) return "sent";
  if (alive(e.pid)) return "pending";
  return "orphaned";
}

function cmdAdd(argv) {
  const when = argv[0];
  const prompt = argv.slice(1).join(" ").trim();
  if (!when || !prompt) {
    console.error("usage: ac add <time> <prompt...>    e.g. ac add 3pm finish the migration");
    return 1;
  }
  const sendAt = parseWhen(when).getTime() + PAD_SEC * 1000;
  const harness = process.env.AC_HARNESS || detectHarness();
  const session = detectSession();
  const id = `${new Date(sendAt).toISOString().slice(0, 16).replace(/[:T-]/g, "")}-${Math.random().toString(36).slice(2, 7)}`;
  const promptFile = join(dir("prompts"), `${id}.txt`);
  writeFileSync(promptFile, prompt);

  const entries = prune(readQueue());
  // Serialise behind any live send into the same session: two concurrent
  // headless turns on one transcript is the only race left, and one
  // `kill -0` spin removes it without any shared state.
  const prior = entries.filter((e) => e.session === session && status(e) === "pending").pop();
  const entry = {
    id, harness, session, cwd: process.cwd(), sendAt, prompt, promptFile,
    createdAt: Date.now(), waitPid: prior?.pid ?? null, pid: null,
  };
  try {
    entry.pid = fork(entry, (sendAt - Date.now()) / 1000);
  } catch (err) {
    console.error(`ac: ${err.message}`);
    return 1;
  }
  entries.push(entry);
  writeQueue(entries);
  const mins = Math.round((sendAt - Date.now()) / 60000);
  console.log(`queued ${id} → ${new Date(sendAt).toLocaleTimeString()} (in ${mins}m), ${harness}${session ? ` session ${session.slice(0, 8)}` : " (most recent session)"}`);
  return 0;
}

function cmdList() {
  const entries = prune(readQueue());
  reconcile(entries);
  writeQueue(entries);
  if (!entries.length) { console.log("nothing queued"); return 0; }
  for (const e of entries) {
    const when = new Date(e.sendAt).toLocaleString();
    const p = e.prompt.length > 60 ? e.prompt.slice(0, 57) + "..." : e.prompt;
    console.log(`${e.id}  ${status(e).padEnd(8)} ${when}  ${e.harness}  ${p}`);
  }
  return 0;
}

function cmdCancel(argv) {
  const target = argv[0];
  if (!target) { console.error("usage: ac cancel <id|all>"); return 1; }
  const entries = readQueue();
  const hit = target === "all" ? entries : entries.filter((e) => e.id === target || e.id.startsWith(target));
  if (!hit.length) { console.error(`no queued prompt matching "${target}"`); return 1; }
  for (const e of hit) {
    if (alive(e.pid)) { try { process.kill(-e.pid, "SIGTERM"); } catch { try { process.kill(e.pid, "SIGTERM"); } catch {} } }
    try { rmSync(e.promptFile, { force: true }); } catch {}
  }
  const ids = new Set(hit.map((e) => e.id));
  writeQueue(entries.filter((e) => !ids.has(e.id)));
  console.log(`cancelled ${hit.length}`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const cmd = (argv[0] || "list").toLowerCase();
  const rest = argv.slice(1);
  if (cmd === "add" || cmd === "queue") return cmdAdd(rest);
  if (cmd === "list" || cmd === "ls") return cmdList();
  if (cmd === "cancel" || cmd === "clear") return cmdCancel(rest);
  console.error("usage: ac add <time> <prompt...> | ac list | ac cancel <id|all>");
  return 1;
}

if (process.argv[1]?.endsWith("ac.mjs")) process.exit(main());
