#!/usr/bin/env node
/**
 * Delivery-settle helper run by the detached resume watcher. Owns the state
 * of a delivered .draining head:
 *   begin        -> write the .settling marker (delivery in flight; the
 *                   healthy-stop hook defers its ack while it exists)
 *   exit 0       -> ack (drop .draining)
 *   exit nonzero -> restore (.draining back to queue head)
 *   giveup       -> probe never cleared: release the arm (clear
 *                   watcherArmedAt so the next limit event re-arms at once)
 *                   and refund the arm-time daily-resume bump (nothing was
 *                   sent). Queue untouched — give-up precedes the drain.
 * Any invocation drops the marker at the end (except giveup, which runs
 * before a marker exists), so the marker is exactly "resume in flight" — a
 * mid-flight ack from the hook would orphan a resume that is about to fail
 * and lose the prompt for good. A stale marker (watcher killed mid-send)
 * ages out in the hook after 10 minutes.
 * Never exits nonzero (queue state is settled here, nothing left to do).
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ackDraining, restoreDraining } from "./lib/queue.mjs";
import { homeDir, loadState, saveState, sessionKey } from "./lib/state.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  const mode = process.argv[3] ?? "";
  const key = sessionKey(sessionId);
  const dir = join(homeDir(), "queue");
  const markerPath = join(dir, `${key}.settling`);
  await mkdir(dir, { recursive: true });
  if (mode === "begin") {
    // Marker proves a delivery is in flight (hook reads its existence).
    await writeFile(`${markerPath}.tmp`, String(Date.now()));
    // Race with a concurrent settle on the same head: fine, marker exists.
    await rename(`${markerPath}.tmp`, markerPath).catch(() => {});
  } else if (mode === "giveup") {
    const st = await loadState(sessionId);
    await saveState(sessionId, { ...st, continues: Math.max(0, (st.continues ?? 0) - 1), watcherArmedAt: 0 });
    const gpath = join(homeDir(), "state", "_global.json");
    try {
      const meta = JSON.parse(await readFile(gpath, "utf8"));
      const today = new Date().toISOString().slice(0, 10);
      if (meta.day === today && meta.resumes > 0) {
        await writeFile(gpath, JSON.stringify({ day: today, resumes: meta.resumes - 1 }));
      }
    } catch {}
  } else {
    if (mode === "fail") {
      await restoreDraining(sessionId);
    } else {
      await ackDraining(sessionId);
    }
    await unlink(markerPath).catch(() => {});
  }
} catch {
  // absent/corrupt draining or IO error -> queue state untouched
}
process.exit(0);
