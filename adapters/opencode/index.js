/**
 * OpenCode adapter (v1 plugin API) for auto-continue.
 * Listens for session.error and session.idle, classifies provider failures,
 * and re-prompts the session when the quota window has passed.
 *
 * Install (any OpenCode user):
 *   opencode.json -> { "plugin": ["opencode-auto-continue"] }
 * or v2: opencode2 plugin add opencode-auto-continue
 */
import { classify } from "./core/classify.mjs";
import { decide, HARNESS_CAPS } from "./core/policy.mjs";
import { loadState, saveState, appendLog } from "./core/state.mjs";

const RETRY_PROMPT =
  process.env.AUTO_CONTINUE_PROMPT || "Continue from where the turn was interrupted by the usage limit.";

const pending = new Map();

function sessionOf(payload = {}) {
  return payload.sessionID ?? payload.sessionId ?? payload.info?.id ?? payload.id ?? "default";
}

export const AutoContinue = async ({ client }) => {
  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.error") {
          const sessionID = sessionOf(event.properties ?? {});
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
            await saveState(sessionID, { continues: decision.continueIndex });
            pending.set(sessionID, { at: Date.now(), delaySec: decision.delaySec ?? 15 });
          }
          return;
        }

        if (event.type === "session.idle") {
          const sessionID = sessionOf(event.properties ?? {});
          const armed = pending.get(sessionID);
          if (!armed) return;
          const waitedMs = Date.now() - armed.at;
          const delayMs = (armed.delaySec ?? 15) * 1000;
          if (waitedMs < delayMs) {
            setTimeout(async () => {
              try {
                await client.session.promptAsync({
                  path: { id: sessionID },
                  body: { parts: [{ type: "text", text: RETRY_PROMPT }] },
                });
                await appendLog({ harness: "opencode", event: "resumed", session: sessionID, kind: "rate_limit", source: "policy", action: "resumed", continues: null });
              } catch (err) {
                await appendLog({ harness: "opencode", event: "resume_failed", session: sessionID, kind: "error", source: "client", action: "ignore", detail: String(err) });
              }
            }, delayMs - waitedMs);
          } else {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: RETRY_PROMPT }] },
            });
          }
          pending.delete(sessionID);
          return;
        }
      } catch (err) {
        await appendLog({ harness: "opencode", event: "plugin_error", kind: "error", source: "uncaught", action: "ignore", detail: String(err) }).catch(() => {});
      }
    },
  };
};
