/**
 * OpenCode adapter (v1 plugin API) for auto-continue.
 * Listens for session.error and session.idle, classifies provider failures,
 * and re-prompts the session when the quota window has passed.
 *
 * Queue-aware: the resume prompt drains the head of the per-session prompt
 * queue (empty queue falls back to the canned retry prompt). Arming is
 * persisted to disk (state file) so a restart still resumes, and a leftover
 * .draining item is restored on the next session.error.
 *
 * Install (any OpenCode user):
 *   opencode.json -> { "plugin": ["opencode-auto-continue"] }
 * or v2: opencode2 plugin add opencode-auto-continue
 */
import { classify } from "./core/classify.mjs";
import { decide, HARNESS_CAPS } from "./core/policy.mjs";
import { loadState, saveState, appendLog } from "./core/state.mjs";
import { drainHead, restoreDraining, ackDraining, peekHead } from "./core/queue.mjs";

const RETRY_PROMPT =
  process.env.AUTO_CONTINUE_PROMPT || "Continue from where the turn was interrupted by the usage limit.";

const pending = new Map();
// Sessions with a resume send in flight. Checked synchronously (no await
// between check and claim) so concurrent idles cannot double-prompt.
const sending = new Set();

function sessionOf(payload = {}) {
  return payload.sessionID ?? payload.sessionId ?? payload.info?.id ?? payload.id ?? "default";
}

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function messageTime(m) {
  if (!m || typeof m !== "object") return 0;
  const cands = [m.createdAt, m.timestamp, m.time, m.at, m.queuedAt, m.updatedAt, m.ts, m.sentAt];
  for (const c of cands) {
    const t = toMs(c);
    if (t > 0) return t;
  }
  return 0;
}

function isUserMessage(m) {
  if (!m || typeof m !== "object") return false;
  const role = m.role ?? m.type ?? m.author ?? m.from ?? m.sender ?? m.kind;
  return typeof role === "string" && /user|human|customer/i.test(role);
}

// Numeric user-message-count fields in a payload, for user-continued
// detection. Only user-scoped counters count: generic totals grow on every
// assistant message and must never stand a resume down on their own.
function extractCounts(props) {
  const out = {};
  if (!props || typeof props !== "object") return out;
  for (const k of ["userMessageCount", "userMessagesCount", "numUserMessages", "totalUserMessages"]) {
    if (Number.isFinite(props[k])) out[k] = props[k];
  }
  if (Array.isArray(props.messages)) {
    out.userMessagesLength = props.messages.filter(isUserMessage).length;
  }
  return out;
}

// Best-effort guard: did the user already continue on their own after we
// armed? Inspects whatever the idle payload exposes (user timestamps,
// message arrays, count growth vs the arm-time baseline). Unknown shapes
// return false so we still resume.
function userContinuedSince(props, armedAt, baseline) {
  if (!props || typeof props !== "object" || !Number.isFinite(armedAt)) return false;
  for (const k of ["lastUserMessageAt", "lastUserMessageTimestamp", "lastUserMessageTime"]) {
    if (toMs(props[k]) > armedAt) return true;
  }
  for (const k of ["messages", "messageList", "history"]) {
    const arr = props[k];
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (isUserMessage(m) && messageTime(m) > armedAt) return true;
      }
    }
  }
  for (const k of ["lastMessage", "latestMessage", "lastUserMessage"]) {
    const m = props[k];
    if (isUserMessage(m) && messageTime(m) > armedAt) return true;
  }
  if (baseline && typeof baseline === "object") {
    const now = extractCounts(props);
    for (const k of Object.keys(now)) {
      if (Number.isFinite(baseline[k]) && now[k] > baseline[k]) return true;
    }
  }
  return false;
}

// Resolve the resume text: queue head, canned prompt when empty. A pending
// .draining item (crash between drain and ack) is restored and retried once.
// Returns { text, source } so the resumed log row records queue vs canned.
async function resolveResumeText(sessionID) {
  try {
    const head = await drainHead(sessionID);
    if (head && typeof head.prompt === "string" && head.prompt.trim()) return { text: head.prompt, source: "queue" };
    return { text: RETRY_PROMPT, source: "canned" };
  } catch {
    try {
      await restoreDraining(sessionID);
      const head = await drainHead(sessionID);
      if (head && typeof head.prompt === "string" && head.prompt.trim()) return { text: head.prompt, source: "queue" };
    } catch {}
    return { text: RETRY_PROMPT, source: "canned" };
  }
}

async function disarmDisk(sessionID) {
  try {
    const st = await loadState(sessionID);
    const next = { ...st };
    delete next.armedAt;
    delete next.delaySec;
    delete next.baseline;
    await saveState(sessionID, next);
  } catch {}
}

// Caller must hold the sending claim for sessionID. Disarm happens after a
// successful ack, never before the drain, so a crash between drain and ack
// leaves .draining for the next session.error to restore. Returns the source
// of the sent text for audit logging.
async function sendResume(client, sessionID) {
  const { text, source } = await resolveResumeText(sessionID);
  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] },
    });
    try {
      await ackDraining(sessionID);
    } catch {}
    // Success is the latest truth: drop any in-memory arm a concurrent
    // session.error created while this send was in flight. A genuine new
    // limit re-arms through a fresh error event; leaving the stale entry
    // would re-deliver the same prompt on the next idle.
    pending.delete(sessionID);
    try {
      const st = await loadState(sessionID);
      await disarmDisk(sessionID);
      await appendLog({ harness: "opencode", event: "resumed", session: sessionID, kind: "rate_limit", source: "policy", action: "resumed", continues: st.continues ?? null, delivered: source });
      return { text, source, continues: st.continues ?? null };
    } catch {
      await appendLog({ harness: "opencode", event: "resumed", session: sessionID, kind: "rate_limit", source: "policy", action: "resumed", continues: null, delivered: source });
      return { text, source, continues: null };
    }
  } catch (err) {
    try {
      await restoreDraining(sessionID);
    } catch {}
    await appendLog({ harness: "opencode", event: "resume_failed", session: sessionID, kind: "error", source: "client", action: "ignore", detail: String(err) });
    return { text, source, failed: true };
  }
}

export const AutoContinue = async ({ client }) => {
  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.error") {
          const sessionID = sessionOf(event.properties ?? {});
          // Crash recovery: a previous idle may have drained the queue head
          // to .draining but died before ack; put it back so it can be resent.
          try {
            await restoreDraining(sessionID);
          } catch {}
          const error = event.properties?.error ?? {};
          const classification = classify({ error, payload: event.properties ?? {} });
          const state = await loadState(sessionID);
          const decision = decide(classification, state, {
            harness: "opencode",
            maxContinues: process.env.AUTO_CONTINUE_MAX_CONTINUES ? parseInt(process.env.AUTO_CONTINUE_MAX_CONTINUES, 10) : undefined,
            maxWaitSec: process.env.AUTO_CONTINUE_MAX_WAIT ? parseInt(process.env.AUTO_CONTINUE_MAX_WAIT, 10) : undefined,
            minDelaySec: process.env.AUTO_CONTINUE_MIN_DELAY ? parseInt(process.env.AUTO_CONTINUE_MIN_DELAY, 10) : undefined,
          });
          await appendLog({
            harness: "opencode", event: "session_error", session: sessionID,
            kind: classification.kind, source: classification.source,
            action: decision.action, delaySec: decision.delaySec, continues: state.continues,
          });
          if (decision.action === "resume_later" || decision.action === "continue_now") {
            const prev = pending.get(sessionID);
            if (prev?.timer) {
              try {
                clearTimeout(prev.timer);
              } catch {}
            }
            const armedAt = Date.now();
            const delaySec = decision.delaySec ?? 15;
            const baseline = extractCounts(event.properties ?? {});
            // Persist arming to disk so a restart still resumes.
            await saveState(sessionID, { continues: decision.continueIndex, armedAt, delaySec, baseline });
            pending.set(sessionID, { at: armedAt, delaySec, baseline, timer: null });
          }
          return;
        }

        if (event.type === "session.idle") {
          const sessionID = sessionOf(event.properties ?? {});
          const props = event.properties ?? {};
          // Synchronous claim: concurrent idles in the same tick must not
          // both pass. The first claims, the rest park their props for the
          // user-guard re-check and stand down.
          if (sending.has(sessionID)) {
            const cur = pending.get(sessionID);
            if (cur) cur.latestProps = props;
            return;
          }
          sending.add(sessionID);
          let released = false;
          const release = () => { if (!released) { released = true; sending.delete(sessionID); } };
          let armed = pending.get(sessionID);
          if (!armed) {
            // Restart recovery: re-arm from disk. The entry claim above
            // already excludes concurrent idles, so no second claim here.
            try {
              try {
                await restoreDraining(sessionID);
              } catch {}
              const st = await loadState(sessionID);
              if (st && st.armedAt) {
                armed = { at: st.armedAt, delaySec: st.delaySec ?? 15, baseline: st.baseline ?? null, timer: null };
                pending.set(sessionID, armed);
              }
            } finally {
              release();
            }
            if (!armed) return;
            // Re-claim for the send path below (recovery released it).
            sending.add(sessionID);
            released = false;
          }
          // Best-effort: user typed first -> stand down, never prompt over them.
          // The entry claim is held throughout. Parked props are re-checked by
          // the timer callback before it claims the slot; once a send is truly
          // in flight, user evidence cannot retroactively cancel it — but the
          // send path drops the pending entry on success, so a parked idle
          // after it sees no arm and stands down.
          const standDown = async () => {
            if (armed.timer) {
              try {
                clearTimeout(armed.timer);
              } catch {}
            }
            pending.delete(sessionID);
            try {
              await disarmDisk(sessionID);
              const st = await loadState(sessionID).catch(() => null);
              await appendLog({ harness: "opencode", event: "idle_skipped", session: sessionID, kind: "user", source: "payload", action: "ignore", detail: "user continued before resume", continues: st?.continues ?? null });
            } finally {
              release();
            }
            return true;
          };
          if (userContinuedSince(props, armed.at, armed.baseline)) {
            await standDown();
            return;
          }
          const waitedMs = Date.now() - armed.at;
          const delayMs = (armed.delaySec ?? 15) * 1000;
          if (waitedMs < delayMs) {
            if (armed.timer) { release(); return; } // one parked timer per session
            const timerProps = () => pending.get(sessionID)?.latestProps ?? props;
            armed.timer = setTimeout(async () => {
              // Claim the sending slot before acting: a late idle during this
              // callback's await must see sending.has() and park, not re-send.
              if (sending.has(sessionID)) return; // impossible, but never double-claim
              sending.add(sessionID);
              let timerReleased = false;
              const releaseTimer = () => { if (!timerReleased) { timerReleased = true; sending.delete(sessionID); } };
              try {
                const latest = timerProps();
                if (userContinuedSince(latest, armed.at, armed.baseline)) {
                  if (armed.timer) { try { clearTimeout(armed.timer); } catch {} }
                  pending.delete(sessionID);
                  try {
                    await disarmDisk(sessionID);
                    await appendLog({ harness: "opencode", event: "idle_skipped", session: sessionID, kind: "user", source: "payload", action: "ignore", detail: "user continued before resume", continues: null });
                  } catch {}
                  return;
                }
                pending.delete(sessionID);
                await sendResume(client, sessionID);
              } catch {} finally {
                releaseTimer();
              }
            }, delayMs - waitedMs);
            armed.latestProps = props;
            release();
            await appendLog({ harness: "opencode", event: "idle_parked", session: sessionID, kind: "rate_limit", source: "policy", action: "parked", delaySec: Math.ceil((delayMs - waitedMs) / 1000), continues: null });
            return;
          }
          // Due path: the entry claim is already held, so no concurrent idle
          // can enter. Re-check user evidence at the last moment, then send.
          if (userContinuedSince(props, armed.at, armed.baseline)) {
            await standDown();
            return;
          }
          if (armed.timer) {
            try {
              clearTimeout(armed.timer);
            } catch {}
          }
          pending.delete(sessionID);
          try {
            await sendResume(client, sessionID);
          } finally {
            release();
          }
          return;
        }
      } catch (err) {
        await appendLog({ harness: "opencode", event: "plugin_error", kind: "error", source: "uncaught", action: "ignore", detail: String(err) }).catch(() => {});
      }
    },
  };
};
