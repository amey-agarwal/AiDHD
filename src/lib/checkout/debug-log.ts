/**
 * Request/response tracing for the Prava → Duffel checkout flow, for local
 * debugging. Card PAN/CVV are always redacted here to last-4/presence-only —
 * see the credential-handling boundary in app/api/checkout/execute/route.ts
 * for why full values must never reach a logger.
 *
 * Every entry also publishes to an in-memory bus so /debug can show it live
 * in the browser (see app/api/checkout/debug-stream/route.ts) — same
 * redaction, just a second sink alongside console.log.
 */

export type DebugLogLevel = "info" | "warn" | "error";

export type DebugLogEntry = {
  id: number;
  ts: string;
  tag: string;
  message: string;
  data?: unknown;
  /** Correlates every event for one booking attempt across Prava/lastminute/harness — see logBookingEvent. */
  booking_id?: string;
  stage?: string;
  level?: DebugLogLevel;
  duration_ms?: number;
  /** Redacted (masked) base64 screenshot, harness steps only. */
  screenshot_base64?: string;
};

type DebugBus = {
  buffer: DebugLogEntry[];
  subscribers: Set<(entry: DebugLogEntry) => void>;
  nextId: number;
};

const BUFFER_LIMIT = 500;

// Kept on globalThis so it survives Next.js dev-mode HMR, same pattern as
// lib/store.ts's in-memory demo store.
const globalForDebugBus = globalThis as unknown as { __aidhdDebugBus?: DebugBus };

function getBus(): DebugBus {
  if (!globalForDebugBus.__aidhdDebugBus) {
    globalForDebugBus.__aidhdDebugBus = { buffer: [], subscribers: new Set(), nextId: 1 };
  }
  return globalForDebugBus.__aidhdDebugBus;
}

/**
 * Single chokepoint for every log entry in this module — console.log AND the
 * live bus both go through here, both scrubbed. Nothing downstream of this
 * function ever sees an unscrubbed value, regardless of what the call site
 * passed in (that's the "redaction enforced at the emitter, not the call
 * site" requirement — see scrubSecrets below).
 */
function publish(tag: string, message: string, data?: unknown, extra?: Partial<DebugLogEntry>) {
  const bus = getBus();
  const safeMessage = scrubSecrets(message) as string;
  const safeData = data !== undefined ? scrubSecrets(data) : undefined;
  const entry: DebugLogEntry = {
    id: bus.nextId++,
    ts: new Date().toISOString(),
    tag,
    message: safeMessage,
    data: safeData,
    ...extra,
  };
  console.log(`[${tag}] ${safeMessage}`, safeData !== undefined ? JSON.stringify(safeData) : "");
  bus.buffer.push(entry);
  if (bus.buffer.length > BUFFER_LIMIT) bus.buffer.shift();
  for (const sub of bus.subscribers) {
    try {
      sub(entry);
    } catch {
      // A broken subscriber (e.g. a closed SSE stream) must never break logging.
    }
  }
}

/** Live entries as they're published — returns an unsubscribe function. */
export function subscribeDebugLog(cb: (entry: DebugLogEntry) => void): () => void {
  const bus = getBus();
  bus.subscribers.add(cb);
  return () => bus.subscribers.delete(cb);
}

/** Buffered entries published before a client connected (most recent 500). */
export function getDebugLogHistory(): DebugLogEntry[] {
  return [...getBus().buffer];
}

/** Buffered entries for one booking_id only — backs /logs's per-booking timeline. */
export function getBookingLogHistory(bookingId: string): DebugLogEntry[] {
  return getBus().buffer.filter((e) => e.booking_id === bookingId);
}

export function logRequest(tag: string, method: string, url: string, body?: unknown) {
  publish(tag, `→ ${method} ${url}`, body);
}

export function logResponse(tag: string, method: string, url: string, status: number, body?: unknown) {
  publish(tag, `← ${status} ${method} ${url}`, body);
}

export function logInfo(tag: string, message: string, data?: unknown) {
  publish(tag, message, data);
}

/**
 * booking_id-correlated structured event — the shape STEP 4 of the
 * lastminute/Prava integration plan asks for: { stage, level, duration_ms,
 * screenshot }. logRequest/logResponse/logInfo above remain in place
 * unchanged for the pre-existing Duffel/Prava call sites; this is the entry
 * point new lastminute/harness code should use instead so every event for
 * one booking attempt can be filtered/grouped/downloaded together.
 */
export function logBookingEvent(input: {
  booking_id: string;
  stage: string;
  event: string;
  level?: DebugLogLevel;
  data?: unknown;
  duration_ms?: number;
  screenshot_base64?: string;
}) {
  publish(input.stage, input.event, input.data, {
    booking_id: input.booking_id,
    stage: input.stage,
    level: input.level ?? "info",
    duration_ms: input.duration_ms,
    screenshot_base64: input.screenshot_base64,
  });
}

/** Redacts a card-shaped object's PAN to last-4 and CVV to presence-only. */
export function redactCard<T extends { number?: string; cvc?: string }>(card: T): T {
  return {
    ...card,
    number: card.number ? `•••• ${card.number.slice(-4)}` : card.number,
    cvc: card.cvc ? "•••" : card.cvc,
  };
}

/** Redacts a Prava payment-result-shaped object's token/dynamic_cvv. */
export function redactPaymentResult<T extends { token?: string; dynamic_cvv?: string }>(
  result: T,
): T {
  return {
    ...result,
    token: result.token ? `•••• ${result.token.slice(-4)}` : result.token,
    dynamic_cvv: result.dynamic_cvv ? "•••" : result.dynamic_cvv,
  };
}

const REDACT_KEY_FULL = /^(cvv|cvc|dynamic_cvv|security_code|password|passport|passport_number|date_of_birth|dob|born_on|session_token|access_token)$/i;
const REDACT_KEY_SECRET_LIKE = /secret|api[_-]?key|authorization/i;
const REDACT_KEY_PAN_LIKE = /^(number|pan|card_number|token)$/i;
const PAN_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;
const SK_KEY_PATTERN = /\bsk_[A-Za-z0-9_]{6,}/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

function redactStringValue(value: string): string {
  return value
    .replace(PAN_PATTERN, (m) => {
      const digits = m.replace(/[ -]/g, "");
      if (digits.length < 13) return m; // avoid mangling unrelated short numbers/ids
      return `•••• ${digits.slice(-4)}`;
    })
    .replace(SK_KEY_PATTERN, "sk_[REDACTED]")
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
}

/**
 * Central scrubber — every value that reaches publish() (console.log AND the
 * live bus) passes through here first, regardless of what any call site
 * passed in. Strips full PANs, CVVs, expiry, sk_* keys, session/access
 * tokens, JWTs, and passenger passport/DOB fields down to a redacted form.
 * See debug-log.test.ts for the assertion that a full PAN/CVV cannot
 * survive this function.
 */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED: too deep]";
  if (typeof value === "string") return redactStringValue(value);
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_FULL.test(key) || REDACT_KEY_SECRET_LIKE.test(key)) {
        out[key] = v == null ? v : "[REDACTED]";
      } else if (REDACT_KEY_PAN_LIKE.test(key) && typeof v === "string") {
        const digits = v.replace(/[ -]/g, "");
        out[key] = digits.length >= 8 ? `•••• ${digits.slice(-4)}` : redactStringValue(v);
      } else if (/^expiry/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = scrubSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
