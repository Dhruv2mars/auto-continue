#!/usr/bin/env node
/**
 * Ack helper run by the detached resume watcher after a successful resume.
 * Usage: node core/drain-ack.mjs <sessionId>
 * Drops the pending .draining head after delivery. No-op when absent/corrupt.
 * Never exits nonzero.
 */
import { ackDraining } from "./lib/queue.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  await ackDraining(sessionId);
} catch {
  // absent/corrupt draining or IO error -> leave for restore path
}
process.exit(0);
