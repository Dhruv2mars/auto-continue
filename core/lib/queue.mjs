/**
 * Prompt queue for auto-continue.
 * Stores user-enqueued prompts per session under $AUTO_CONTINUE_HOME/queue/.
 * Watcher wake drains the head (moved to .draining first for crash safety)
 * and sends it as the resume prompt; empty queue falls back to canned text.
 */
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homeDir, sessionKey } from "./state.mjs";

export const MAX_PROMPT_LEN = 8000;

function queueDir() {
  return join(homeDir(), "queue");
}

function queuePath(sessionId) {
  return join(queueDir(), `${sessionKey(sessionId)}.json`);
}

function drainingPath(sessionId) {
  return join(queueDir(), `${sessionKey(sessionId)}.draining`);
}

async function ensureQueueDir() {
  const dir = queueDir();
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function validItem(e) {
  return e && typeof e.prompt === "string";
}

export async function list(sessionId) {
  const path = queuePath(sessionId);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt queue file: quarantine aside (best effort) and return empty.
    // A later enqueue() then writes fresh; no silent merge with garbage.
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
    return [];
  }
  if (!Array.isArray(parsed)) {
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
    return [];
  }
  return parsed.filter(validItem);
}

export async function enqueue(sessionId, prompt) {
  const text = String(prompt ?? "");
  if (!text.trim()) throw new Error("prompt must not be empty");
  if (text.length > MAX_PROMPT_LEN) throw new Error(`prompt exceeds ${MAX_PROMPT_LEN} chars`);
  await ensureQueueDir();
  const items = await list(sessionId);
  const item = { prompt: text, queuedAt: Date.now() };
  items.push(item);
  await atomicWrite(queuePath(sessionId), JSON.stringify(items));
  return item;
}

export async function peekHead(sessionId) {
  const items = await list(sessionId);
  return items.length ? items[0] : null;
}

export async function clear(sessionId) {
  const items = await list(sessionId);
  let n = items.length;
  if (await exists(drainingPath(sessionId))) n += 1;
  await unlink(queuePath(sessionId)).catch(() => {});
  await unlink(drainingPath(sessionId)).catch(() => {});
  return n;
}

async function readDrainingRaw(sessionId) {
  const path = drainingPath(sessionId);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!validItem(parsed)) throw new Error("bad draining item");
    return parsed;
  } catch {
    // Corrupt .draining must not stall the queue: treat as absent.
    await unlink(path).catch(() => {});
    return null;
  }
}

/**
 * Move the head item to .draining and return it.
 * Returns null when the queue is empty. Throws while a .draining item
 * is still pending (caller must ack/restore first).
 */
export async function drainHead(sessionId) {
  // Corrupt .draining is treated as absent (readDrainingRaw unlinks it);
  // a valid pending item still blocks until ack/restore.
  if (await readDrainingRaw(sessionId)) {
    throw new Error("draining item pending; ack or restore first");
  }
  const items = await list(sessionId);
  if (items.length === 0) return null;
  const head = items[0];
  const rest = items.slice(1);
  await ensureQueueDir();
  // Draining-first order: crash between the two writes leaves a duplicate
  // (restore dedupes) rather than a lost prompt.
  await atomicWrite(drainingPath(sessionId), JSON.stringify(head));
  if (rest.length === 0) {
    await unlink(queuePath(sessionId)).catch(() => {});
  } else {
    await atomicWrite(queuePath(sessionId), JSON.stringify(rest));
  }
  return head;
}

/**
 * Put a pending .draining item back at the head of the queue.
 * Deduplicates when the queue still holds the same entry (crash between
 * draining-write and queue-write). Returns the restored item or null.
 */
export async function restoreDraining(sessionId) {
  const draining = await readDrainingRaw(sessionId);
  if (!draining) return null;
  const items = await list(sessionId);
  // Dedupe only the crash case: queue head deep-equals draining
  // (head was never removed). Two distinct enqueues in the same ms must
  // both survive, so matching anywhere in the list is wrong.
  const head = items[0];
  const alreadyThere =
    head != null &&
    head.prompt === draining.prompt &&
    head.queuedAt === draining.queuedAt;
  if (!alreadyThere) {
    items.unshift(draining);
    await ensureQueueDir();
    await atomicWrite(queuePath(sessionId), JSON.stringify(items));
  }
  await unlink(drainingPath(sessionId)).catch(() => {});
  return draining;
}

/** Drop the pending .draining item after successful delivery. */
export async function ackDraining(sessionId) {
  const draining = await readDrainingRaw(sessionId);
  if (!draining) return null;
  await unlink(drainingPath(sessionId)).catch(() => {});
  return draining;
}

// Aliases for CLI / drain-helper call sites.
export const readQueue = list;
export const listQueue = list;
export const clearQueue = clear;
export const readDraining = readDrainingRaw;
