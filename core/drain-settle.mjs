#!/usr/bin/env node
/**
 * Delivery-settle helper run by the detached resume watcher. Owns the state
 * of a delivered .draining head:
 *   begin-file <path> -> re-stamp the .settling marker (delivery in flight;
 *                   the healthy-stop hook defers its ack while it exists),
 *                   fingerprinting the prompt FILE directly so the marker
 *                   covers the exact stored bytes (never through shell
 *                   substitution, which strips trailing newlines).
 *   exit 0       -> ack (.draining gone). If the hook's stale-restore put
 *                   the head back while this delivery ran (.restored receipt
 *                   matching this fingerprint), the head is dropped too:
 *                   identity-based convergence, delivered exactly once.
 *   exit nonzero -> restore (.draining back to queue head; receipt cleared).
 *   giveup <tok> -> probe never cleared: release THIS arm only (watcherArmedAt
 *                   cleared when it still equals the arm token, continues
 *                   refunded only for the bump this arm's own arm-time made
 *                   — the token encodes that), daily bump refunded once.
 * Any invocation drops the marker at the end (except giveup), so the marker
 * is exactly "resume in flight". A stale marker (watcher killed mid-send)
 * ages out after 10 minutes and the hook then restores instead of dropping.
 * Never exits nonzero (queue state is settled here, nothing left to do).
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ackDraining, dropIfRestored, restoreDraining, promptFingerprint } from "./lib/queue.mjs";
import { homeDir, loadState, saveState, sessionKey } from "./lib/state.mjs";

try {
  const sessionId = process.argv[2] ?? "default";
  const mode = process.argv[3] ?? "";
  const key = sessionKey(sessionId);
  const dir = join(homeDir(), "queue");
  const markerPath = join(dir, `${key}.settling`);
  const restoredPath = join(dir, `${key}.restored`);
  await mkdir(dir, { recursive: true });
  if (mode === "begin" || mode === "begin-file") {
    // Marker proves a delivery is in flight (hook reads its existence); the
    // fingerprint identifies WHICH prompt is in flight and the token WHICH
    // arm stamped it. begin-file reads the drained prompt file itself so
    // the fingerprint covers the EXACT stored bytes (a shell "$(cat)"
    // argument would strip trailing newlines). argv[5] is the arm token.
    let fp;
    if (mode === "begin-file") {
      const { readFile: rf } = await import("node:fs/promises");
      fp = promptFingerprint(await rf(process.argv[4], "utf8"));
    } else {
      fp = process.argv[4] || promptFingerprint("");
    }
    const armTok = String(process.argv[5] ?? "").split(":")[0] || "0";
    await writeFile(`${markerPath}.tmp`, `${Date.now()} ${fp} ${armTok}`);
    // Race with a concurrent settle on the same head: fine, marker exists.
    await rename(`${markerPath}.tmp`, markerPath).catch(() => {});
  } else if (mode === "giveup") {
    // Ownership token: "<armedAt>:<continuesBefore>" captured at arm time by
    // the watcher argument. Refund ONLY this arm's own bump, and clear the
    // arm only if a newer arm has not already replaced it.
    const [armedAtTok, contBeforeTok] = String(process.argv[4] ?? "").split(":");
    const st = await loadState(sessionId);
    const contBefore = Number.isFinite(parseInt(contBeforeTok, 10)) ? parseInt(contBeforeTok, 10) : null;
    const next = { ...st };
    if (st.watcherArmedAt && String(st.watcherArmedAt) === armedAtTok) {
      next.watcherArmedAt = 0;
      if (contBefore != null && (st.continues ?? 0) > contBefore) next.continues = Math.max(0, (st.continues ?? 0) - 1);
      await saveState(sessionId, next);
      const gpath = join(homeDir(), "state", "_global.json");
      try {
        const meta = JSON.parse(await readFile(gpath, "utf8"));
        const today = new Date().toISOString().slice(0, 10);
        if (meta.day === today && meta.resumes > 0) {
          await writeFile(gpath, JSON.stringify({ day: today, resumes: meta.resumes - 1 }));
        }
      } catch {}
    }
    // A newer arm owns the state now: leave its continues/armedAt alone (its
    // own giveup will handle them). No daily refund either — the newer arm
    // made that bump.
  } else {
    // Ownership has TWO halves:
    // - QUEUE side (.draining + marker): decided by MARKER IDENTITY — did
    //   THIS arm stamp the marker now on disk? A takeover re-drain restamps
    //   it with the newer arm's token, so a presumed-dead delivery's late
    //   settle can no longer ack/restore the live owner's head. This half
    //   must run even when state has moved on (a newer arm persisted while
    //   this watcher still slept): refusing it orphaned a delivered head
    //   under a fresh marker — 10-min queue freeze, then duplicate.
    // - STATE side (watcherArmedAt): decided by the TOKEN matching the
    //   persisted arm — a stale arm never releases or rewrites a newer
    //   arm's state (that is giveup/fail's job only, and only their own).
    const armedAtTok = String(process.argv[4] ?? "").split(":")[0];
    let markerToken = null;
    let fp = null;
    try {
      const parts = (await readFile(markerPath, "utf8")).trim().split(" ");
      fp = parts[1] || null;
      markerToken = parts[2] || null;
    } catch {
      process.exit(0); // no marker: this delivery was never begun; nothing to settle
    }
    const ownsMarker = markerToken === armedAtTok;
    if (!ownsMarker) process.exit(0);
    if (mode === "fail") {
      await restoreDraining(sessionId);
      await unlink(restoredPath).catch(() => {});
      // The arm's delivery failed: no live watcher remains for this arm.
      // Release it so the next real limit event re-arms instead of being
      // suppressed for the dedupe window while burning continuation budget.
      try {
        const st = await loadState(sessionId);
        if (String(st.watcherArmedAt) === armedAtTok) {
          await saveState(sessionId, { ...st, watcherArmedAt: 0 });
        }
      } catch {}
    } else {
      // Fingerprint read BEFORE ack removes the marker — identity, not
      // liveness, decides the convergence drop.
      await ackDraining(sessionId);
      await dropIfRestored(sessionId, fp);
      await unlink(restoredPath).catch(() => {});
    }
    await unlink(markerPath).catch(() => {});
  }
} catch {
  // absent/corrupt draining or IO error -> queue state untouched
}
process.exit(0);
