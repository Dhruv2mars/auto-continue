#!/usr/bin/env node
/**
 * Delivery-settle helper run by the detached resume watcher. Owns the state
 * of a delivered .draining head:
 *   begin <sha>  -> write the .settling marker (delivery in flight; the
 *                   healthy-stop hook defers its ack while it exists). The
 *                   marker records WHICH head is in flight (prompt sha), so
 *                   a stale-marker restore of a delivery that then succeeds
 *                   can be dropped here instead of re-delivered.
 *   exit 0       -> ack (drop .draining; also drop a queue head equal to the
 *                   marker fingerprint — the stale-restore re-delivery path)
 *   exit nonzero -> restore (.draining back to queue head)
 *   giveup       -> probe never cleared: release the arm (clear
 *                   watcherArmedAt so the next limit event re-arms at once)
 *                   and refund the arm-time daily-resume bump (nothing was
 *                   sent). Queue untouched — give-up precedes the drain.
 * Any invocation drops the marker at the end (except giveup, which runs
 * before a marker exists), so the marker is exactly "resume in flight" — a
 * mid-flight ack from the hook would orphan a resume that is about to fail
 * and lose the prompt for good. A stale marker (watcher killed mid-send)
 * ages out after 10 minutes and degrades to restore, never drop.
 * Never exits nonzero (queue state is settled here, nothing left to do).
 */
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ackDraining, dropIfMarked, restoreDraining } from "./lib/queue.mjs";
import { homeDir, loadState, saveState, sessionKey } from "./lib/state.mjs";

function fingerprint(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

try {
  const sessionId = process.argv[2] ?? "default";
  const mode = process.argv[3] ?? "";
  const key = sessionKey(sessionId);
  const dir = join(homeDir(), "queue");
  const markerPath = join(dir, `${key}.settling`);
  await mkdir(dir, { recursive: true });
  if (mode === "begin") {
    // Marker proves a delivery is in flight (hook reads its existence) and
    // records which prompt is in flight (fingerprint, for settle-time drop).
    const fp = fingerprint(process.argv[4] ?? "");
    await writeFile(`${markerPath}.tmp`, `${Date.now()} ${fp}`);
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
    // Which prompt did this watcher send? Read the marker BEFORE settling.
    // Freshness uses the marker's mtime (same clock as the hook's gate).
    let fp = null;
    try {
      const info = await stat(markerPath);
      const markerFp = (await readFile(markerPath, "utf8")).trim().split(" ")[1];
      if (markerFp && Date.now() - info.mtimeMs < 10 * 60 * 1000) fp = markerFp;
    } catch {}
    if (mode === "fail") {
      await restoreDraining(sessionId);
    } else {
      await ackDraining(sessionId);
      // The stale-marker restore path (hook restored a delivery that then
      // SUCCEEDED) leaves the sent prompt at the queue head; dropping the
      // .draining file alone would re-deliver it on the next wake. Drop the
      // fingerprint match too — but only the head, only an exact match.
      if (fp) await dropIfMarked(sessionId, fp);
    }
    await unlink(markerPath).catch(() => {});
  }
} catch {
  // absent/corrupt draining or IO error -> queue state untouched
}
process.exit(0);
