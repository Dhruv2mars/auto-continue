#!/usr/bin/env node
/**
 * Drain helper run by the detached resume watcher on wake.
 * Usage: node core/drain.mjs <sessionId>
 * Prints the queue head prompt (raw) to stdout, moving it to .draining first.
 * Prints nothing and exits 0 when the queue is empty (caller falls back
 * to the canned prompt). Never exits nonzero.
 */
import { drainHead } from "./lib/queue.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  const head = await drainHead(sessionId);
  if (head) process.stdout.write(head.prompt);
} catch {
  // empty queue or IO error -> caller falls back to canned prompt
}
process.exit(0);
