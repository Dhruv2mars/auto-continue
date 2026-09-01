/**
 * Continuation policy. One place decides whether auto-continue acts.
 * Harness loop caps are hard limits enforced by each harness; we stay one
 * under them so our cap never collides with the harness's kill switch.
 */

export const HARNESS_CAPS = { claude: 7, zcode: 2, codex: 3, cursor: 4, opencode: 3 };
export const DEFAULTS = { backoffSec: [45, 300, 1800], maxWaitSec: 7200 };

/**
 * @param {{kind: string, retryAfterSec: number|null}} classification
 * @param {{continues: number}} state
 * @param {{harness: string, maxContinues?: number, maxWaitSec?: number, backoffSec?: number[]}} opts
 */
export function decide(classification, state, opts) {
  const { kind, retryAfterSec } = classification;
  const cap = Math.min(opts.maxContinues ?? Infinity, HARNESS_CAPS[opts.harness] ?? 3);
  const maxWait = opts.maxWaitSec ?? DEFAULTS.maxWaitSec;
  const backoff = opts.backoffSec ?? DEFAULTS.backoffSec;

  if (kind === "rate_limit") {
    if (state.continues >= cap) {
      return { action: "give_up", delaySec: null, reason: `auto-continue reached its cap of ${cap} continuations for this session` };
    }
    const floor = backoff[Math.min(state.continues, backoff.length - 1)];
    const delay = Math.min(Math.max(retryAfterSec ?? floor, 10), maxWait);
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
