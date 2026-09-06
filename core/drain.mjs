#!/usr/bin/env node
/**
 * Drain helper run by the detached resume watcher on wake.
 * Usage: node core/drain.mjs <sessionId>
 * Prints the queue head prompt (raw) to stdout, moving it to .draining first.
 * A pending .draining item (previous watcher crashed mid-send) is restored to
 * the head first, so the wake drains true FIFO order instead of falling back
 * to the canned prompt while real prompts sit queued. Prints nothing and
 * exits 0 only when the queue is genuinely empty (caller falls back to the
 * canned prompt). Never exits nonzero.
 */
import { drainHead, restoreDraining } from "./lib/queue.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  await restoreDraining(sessionId);
  const head = await drainHead(sessionId);
  if (head) process.stdout.write(head.prompt);
} catch {
  // empty queue or IO error -> caller falls back to canned prompt
}
process.exit(0);
