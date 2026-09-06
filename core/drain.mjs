#!/usr/bin/env node
/**
 * Drain helper run by the detached resume watcher on wake.
 * Usage: node core/drain.mjs <sessionId>
 * Ownership-aware: refuses (exit 3, no output) while a delivery for this
 * session is in flight (.settling marker fresh — another live watcher owns
 * the head; delivering would duplicate the prompt). Takes over stale or
 * absent markers. On take-over a pending .draining head is restored first,
 * so the wake drains true FIFO order instead of falling back to the canned
 * prompt while real prompts sit queued. Prints the owned prompt on stdout;
 * prints nothing and exits 0 only when the queue is genuinely empty (caller
 * falls back to the canned prompt). Never exits nonzero except the
 * ownership refusal (3), which the watcher treats as "nothing to send".
 */
import { drainIfUnowned } from "./lib/queue.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  const res = await drainIfUnowned(sessionId);
  if (res.skipped) process.exit(3);
  if (res.head) process.stdout.write(res.head.prompt);
} catch {
  // empty queue or IO error -> caller falls back to canned prompt
}
process.exit(0);
