/**
 * Prompt queue for auto-continue.
 * Stores user-enqueued prompts per session under $AUTO_CONTINUE_HOME/queue/.
 * Watcher wake drains the head (moved to .draining first for crash safety)
 * and sends it as the resume prompt; empty queue falls back to canned text.
 */
import { chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homeDir, sessionKey } from "./state.mjs";

export const MAX_PROMPT_LEN = 8000;

// A delivery whose .settling marker is older than this is presumed orphaned
// (watcher killed mid-send); the stale branch restores rather than drops.
const SETTLING_MAX_AGE_MS = 10 * 60 * 1000;

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
  // Locked read-modify-write: concurrent CLI enqueues share this path and a
  // bare list->push->write lets the last rename win, silently dropping the
  // other writers' prompts.
  return withQueueLock(sessionId, async () => {
    const items = await list(sessionId);
    const item = { prompt: text, queuedAt: Date.now() };
    items.push(item);
    await atomicWrite(queuePath(sessionId), JSON.stringify(items));
    return item;
  });
}

export async function peekHead(sessionId) {
  const items = await list(sessionId);
  return items.length ? items[0] : null;
}

export async function clear(sessionId) {
  // Serialized like every mutator: an unlocked clear let a concurrent
  // enqueue's write land after it and resurrect the cleared prompts.
  return withQueueLock(sessionId, async () => {
    const items = await list(sessionId);
    let n = items.length;
    if (await exists(drainingPath(sessionId))) n += 1;
    await unlink(queuePath(sessionId)).catch(() => {});
    await unlink(drainingPath(sessionId)).catch(() => {});
    return n;
  });
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

/**
 * Cross-process serialization for queue mutators. A lock file carrying the
 * holder pid guards enqueue/drain/clear critical sections. Contention waits;
 * a lock is stolen ONLY when its recorded pid is provably dead (kill(pid,0)
 * fails) — stealing a live holder's lock collapsed mutual exclusion and
 * lost prompts. On timeout the mutator fails loudly (honest CLI error)
 * rather than writing unlocked.
 */
const LOCK_TIMEOUT_MS = 5000;

async function holderAlive(lockPath) {
  try {
    const pid = parseInt(await readFile(lockPath, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false; // corrupt -> stealable
    process.kill(pid, 0); // signal 0 = liveness probe
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false; // pid gone -> stealable
    return err?.code === "EPERM"; // exists but signaled refused -> alive
  }
}

export async function withQueueLock(sessionId, fn) {
  const dir = queueDir();
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, `${sessionKey(sessionId)}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let locked = false;
  while (Date.now() < deadline) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      locked = true;
      break;
    } catch {
      if (!(await holderAlive(lockPath))) {
        // Holder provably dead: steal and retry the O_EXCL claim.
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!locked) throw new Error(`queue busy: lock for ${sessionId} held by a live process`);
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/** Short fingerprint identifying a prompt across drain/settle/queue files. */
export function promptFingerprint(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

async function markerInfo(sessionId) {
  const path = join(queueDir(), `${sessionKey(sessionId)}.settling`);
  try {
    const info = await stat(path);
    const fresh = Date.now() - info.mtimeMs < SETTLING_MAX_AGE_MS;
    let fp = null;
    try {
      fp = (await readFile(path, "utf8")).trim().split(" ")[1] || null;
    } catch {}
    return { fresh, fp };
  } catch {
    return { fresh: false, fp: null };
  }
}

function restoredPath(sessionId) {
  return join(queueDir(), `${sessionKey(sessionId)}.restored`);
}

/**
 * Hook-side stale-restore receipt: the hook restored a .draining head whose
 * settling marker read stale (watcher presumed dead). The delivery may still
 * be alive and about to succeed — settle drops a head matching THIS receipt,
 * so identity, not marker liveness, drives the convergence. A receipt is
 * only honored by the settle of the delivery whose marker it was written for
 * (the settle reads it before removing its marker).
 */
export async function markRestored(sessionId, fingerprint) {
  if (!fingerprint) return;
  await mkdir(queueDir(), { recursive: true });
  await atomicWrite(restoredPath(sessionId), String(fingerprint));
}

/**
 * Settle-side convergence: drop the queue HEAD only when a hook restore
 * receipt matches the delivered prompt's fingerprint (the hook restored a
 * delivery that then succeeded — without the drop the sent prompt would be
 * re-delivered on the next wake). Unconditional on marker age: the receipt
 * identifies WHICH prompt, not liveness. A mismatch (a different prompt was
 * enqueued meanwhile) keeps the queue.
 */
export async function dropIfRestored(sessionId, fingerprint) {
  if (!fingerprint) return false;
  return withQueueLock(sessionId, async () => {
    let receipt = null;
    try {
      receipt = (await readFile(restoredPath(sessionId), "utf8")).trim();
    } catch {
      return false;
    }
    await unlink(restoredPath(sessionId)).catch(() => {});
    if (receipt !== fingerprint) return false;
    const items = await list(sessionId);
    if (!items.length) return false;
    if (promptFingerprint(items[0].prompt) !== fingerprint) return false;
    const rest = items.slice(1);
    if (rest.length === 0) await unlink(queuePath(sessionId)).catch(() => {});
    else await atomicWrite(queuePath(sessionId), JSON.stringify(rest));
    return true;
  });
}

/**
 * Watcher-wake drain with ownership: refuses while a delivery for this
 * session is provably in flight (fresh .settling marker from another wake —
 * two live watchers, e.g. a probing one and a re-armed one, must not
 * restore-and-re-drain the same head). A stale marker means its watcher is
 * presumed dead: the wake takes over. On take-over the pending .draining
 * head is restored first (true FIFO), then the new head is drained and the
 * .settling marker written atomically-with the claim (same lock), so a
 * sibling wake can never slip into the drain-to-begin window. The marker is
 * stamped for a REAL head only — the canned fallback (empty queue) is not a
 * queue delivery; stamping it orphaned a fresh marker for 10 minutes and
 * starved enqueues with nothing in flight. Returns {head} when this wake
 * owns a queue delivery (marker already written), {head:null} for the
 * canned path (no marker; concurrent canned sends are idempotent resumes
 * of the same turn, and the next queue delivery re-claims cleanly).
 */
export async function drainIfUnowned(sessionId) {
  return withQueueLock(sessionId, async () => {
    const marker = await markerInfo(sessionId);
    if (marker.fresh) return { skipped: true, why: "delivery in flight" };
    await restoreDraining(sessionId);
    const head = await drainHead(sessionId);
    if (head) {
      const fp = promptFingerprint(head.prompt);
      const markerPath = join(queueDir(), `${sessionKey(sessionId)}.settling`);
      await atomicWrite(markerPath, `${Date.now()} ${fp}`);
      return { head, fingerprint: fp };
    }
    return { head: null };
  });
}
