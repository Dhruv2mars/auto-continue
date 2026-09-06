/**
 * Error classification for auto-continue.
 * Input: whatever the harness handed us. Output: a small normalized verdict.
 * Baseline is always text classification over the stringified payload, so an
 * undocumented payload shape still classifies; structured fields refine it.
 */

// Limit idioms only: bare nouns like "quota" or "capacity" appear constantly
// in benign assistant prose ("the quota of open files per process"), and
// wildcard spans like /limit.*reached/ match ordinary sentences ("once the
// 100th row is reached, we apply a limit"), so this list stays literal.
// Strong idioms assert the limit event itself. Weak tokens (WEAK_LIMIT_RE)
// merely mention limit vocabulary ("next I will discuss the rate limit
// headers") and only classify when corroborated by addressee/retry/reset
// language (LIMIT_CONTEXT_RE) — real limit messages talk to *you* and say
// when to *try again*; explanatory prose does neither.
const RATE_LIMIT_RE = /usage limit (?:has been |was |is )?(?:reached|hit)|rate limit (?:has been |was |is )?(?:reached|exceeded|hit)|(?:reached|hit|exceeded) your (?:usage|rate|token|plan|weekly|daily) limit|you(?:'ve)? h(?:it|ave reached)|you have reached your|too many requests|quota (?:exceeded|exhausted|reached|limit)|your quota|quota is (?:exceeded|exhausted)|plan limit (?:has been |was )?(?:reached|hit)/i;
const WEAK_LIMIT_RE = /\b(?:rate|usage|token|plan|weekly|daily|character|message) limit\b|usage cap|\b429\b/i;
const LIMIT_CONTEXT_RE = /\b(?:you|your|you've|you'll|please|try|retry|resets?|wait|come back|later|paused?|temporarily)\b/i;
const OVERLOAD_RE = /overloaded|over capacity|at capacity|529|server is busy|temporarily unavailable/i;
const AUTH_RE = /invalid api key|unauthorized|authentication|401|forbidden|403|not authenticated/i;
const BILLING_RE = /billing|credit|payment|insufficient funds|402|subscription/i;
const ABORT_RE = /aborted|abortedbyuser|user interrupt|cancelled by user|canceled by user/i;

const CLOCK_RE = /\b(?:resets?|reset)(?:\s+at|\s+by)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const RELATIVE_RE = /\b(?:retry|try) again (?:in|after)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i;
const DURATION_RE = /\bin\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i;

function secondsFromUnit(n, unit) {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u.startsWith("m")) return n * 60;
  return Math.ceil(n);
}

export function parseRetryAfterSec(text) {
  if (!text) return null;
  let m = text.match(RELATIVE_RE) || text.match(DURATION_RE);
  if (m) return secondsFromUnit(parseFloat(m[1]), m[2]);
  m = text.match(/retry-?after["':\s]*(\d+(?:\.\d+)?)/i);
  if (m) return Math.ceil(parseFloat(m[1]));
  m = text.match(CLOCK_RE);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3] ? m[3].toLowerCase() : null;
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return Math.ceil((target - now) / 1000);
  }
  return null;
}

// retry-after may be delta-seconds ("120") or an HTTP-date; an HTTP-date is
// deliberately not parsed here (clock skew turns it into a wrong wait), so it
// degrades to null and the policy falls back to its default ladder.
function parseRetryAfterHeaderValue(ra) {
  if (!ra) return null;
  const n = Math.ceil(parseFloat(ra));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function classifyText(text) {
  if (!text) return { kind: "other", retryAfterSec: null };
  if (ABORT_RE.test(text)) return { kind: "abort", retryAfterSec: null };
  if (AUTH_RE.test(text)) return { kind: "auth", retryAfterSec: null };
  if (BILLING_RE.test(text)) return { kind: "billing", retryAfterSec: null };
  const limitHit = RATE_LIMIT_RE.test(text) || (WEAK_LIMIT_RE.test(text) && LIMIT_CONTEXT_RE.test(text));
  if (limitHit) return { kind: "rate_limit", retryAfterSec: parseRetryAfterSec(text) };
  if (OVERLOAD_RE.test(text)) return { kind: "overloaded", retryAfterSec: parseRetryAfterSec(text) };
  return { kind: "other", retryAfterSec: null };
}

function fromStructured(error) {
  if (!error || typeof error !== "object") return null;
  // Coerce: providers send "429" (string) as often as 429 (number).
  const raw = error.statusCode ?? error.status ?? error.data?.statusCode ?? error.data?.status;
  const status = raw == null || raw === "" ? NaN : Number(raw);
  if (status === 429) {
    const headers = error.responseHeaders ?? error.data?.responseHeaders ?? {};
    const ra = headers["retry-after"] ?? headers["Retry-After"];
    return { kind: "rate_limit", retryAfterSec: parseRetryAfterHeaderValue(ra) };
  }
  if (status === 401 || status === 403) return { kind: "auth", retryAfterSec: null };
  if (status === 402) return { kind: "billing", retryAfterSec: null };
  if (status === 529 || status === 503) return { kind: "overloaded", retryAfterSec: null };
  // isRetryable means "transient, try again soon" (timeouts, capacity) —
  // overloaded, not rate_limit: it must not consume the quota backoff ladder.
  if (error.isRetryable === true) return { kind: "overloaded", retryAfterSec: null };
  return null;
}

/**
 * @param {{payload?: object, matcher?: string, error?: object, text?: string, event?: string}} input
 * @returns {{kind: string, retryAfterSec: number|null, source: string}}
 */
export function classify(input = {}) {
  const structured = fromStructured(input.error);
  const text = [input.text, input.error?.message, input.error?.data?.message].filter(Boolean).join(" ");
  const textual = classifyText(text || (input.payload ? JSON.stringify(input.payload) : ""));
  if (input.matcher && /rate_limit|ratelimit/i.test(input.matcher)) {
    if (structured && (structured.kind === "auth" || structured.kind === "billing")) {
      return { kind: structured.kind, retryAfterSec: structured.retryAfterSec ?? textual.retryAfterSec, source: "structured" };
    }
    if (textual.kind === "abort" || textual.kind === "auth" || textual.kind === "billing") {
      return { ...textual, source: "text" };
    }
    return { kind: "rate_limit", retryAfterSec: structured?.retryAfterSec ?? textual.retryAfterSec, source: "matcher" };
  }
  if (structured) return { kind: structured.kind, retryAfterSec: structured.retryAfterSec ?? textual.retryAfterSec, source: "structured" };
  return { ...textual, source: "text" };
}
