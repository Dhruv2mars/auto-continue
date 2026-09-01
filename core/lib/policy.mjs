/**
 * Continuation policy. One place decides whether auto-continue acts.
 * Harness loop caps are hard limits enforced by each harness; we stay one
 * under them so our cap never collides with the harness's kill switch.
 */

// Conservative: codex and opencode native block/retry ceilings are not fully
// documented, so we assume the tightest plausible cap for those harnesses.
export const HARNESS_CAPS = { claude: 7, zcode: 2, codex: 2, cursor: 4, opencode: 2 };
export const DEFAULTS = { backoffSec: [45, 300, 1800], maxWaitSec: 7200, minDelaySec: 10 };

/**
 * @param {{kind: string, retryAfterSec: number|null}} classification
 * @param {{continues: number}} state
 * @param {{harness: string, maxContinues?: number, maxWaitSec?: number, backoffSec?: number[], minDelaySec?: number}} opts
 */
export function decide(classification, state, opts) {
  const { kind, retryAfterSec } = classification;
  const finite = (n, fallback) => (Number.isFinite(n) ? n : fallback);
  const cap = Math.min(finite(opts.maxContinues, Infinity), HARNESS_CAPS[opts.harness] ?? 3);
  const maxWait = finite(opts.maxWaitSec, DEFAULTS.maxWaitSec);
  const minDelay = finite(opts.minDelaySec, DEFAULTS.minDelaySec);
  const backoff = (opts.backoffSec ?? DEFAULTS.backoffSec).map((n) => finite(n, 0));

  if (kind === "rate_limit") {
    if (state.continues >= cap) {
      return { action: "give_up", delaySec: null, reason: `auto-continue reached its cap of ${cap} continuations for this session` };
    }
    const floor = backoff[Math.min(state.continues, backoff.length - 1)];
    const delay = Math.min(Math.max(retryAfterSec ?? floor, minDelay), maxWait);
    return {
      action: "resume_later",
      delaySec: delay,
      continueIndex: state.continues + 1,
      reason: `usage limit hit; resuming in ${delay}s (continuation ${state.continues + 1}/${cap})`,
    };
  }

  if (kind === "overloaded") {
    if (state.continues >= cap) {
      return { action: "give_up", delaySec: null, reason: `auto-continue reached its cap of ${cap} continuations for this session` };
    }
    const delay = Math.min(Math.max(retryAfterSec ?? 30, 10), 300);
    return {
      action: "continue_now",
      delaySec: delay,
      continueIndex: state.continues + 1,
      reason: `provider overloaded; wait ${delay}s, then continue the interrupted work`,
    };
  }

  if (kind === "auth" || kind === "billing") {
    return { action: "notify_only", delaySec: null, reason: "auth/billing error; auto-continue will not retry credentials or payment issues" };
  }

  return { action: "ignore", delaySec: null, reason: null };
}

export function blockDecision(reason) {
  return { decision: "block", reason };
}
