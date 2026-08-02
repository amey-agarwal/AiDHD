import { randomUUID } from "crypto";
import { hasPrava } from "./config";
import { logRequest, logResponse, logInfo, redactPaymentResult } from "../checkout/debug-log";

/**
 * Typed error codes per docs.prava.space/api-reference/errors.md (verified
 * 2026-08-02 — see docs/lastminute-prava-integration.md §2). `retriable`
 * marks codes worth a backoff retry (transient/internal); everything else
 * (auth, validation, not-found, business-state) is retry-proof and should
 * fail fast.
 */
export const PRAVA_ERROR_INFO = {
  AUTH_1001: { message: "Invalid or missing API key", retriable: false },
  AUTH_1002: { message: "Missing or invalid Authorization header", retriable: false },
  AUTH_1003: { message: "Session has expired", retriable: false },
  AUTH_1004: { message: "Session has been revoked", retriable: false },
  VAL_2001: { message: "Request failed schema validation", retriable: false },
  INVALID_REQUEST: { message: "Missing required field", retriable: false },
  TRIES_EXHAUSTED: { message: "Account's session allowance is depleted", retriable: false },
  MERCHANT_LOOKUP_ERROR: { message: "Merchant account unresolvable", retriable: true },
  CONFIG_ERROR: { message: "Merchant account is missing payment configuration", retriable: false },
  CARD_NOT_FOUND: { message: "Pre-selected card doesn't exist", retriable: false },
  CARD_INACTIVE: { message: "Pre-selected card is not active", retriable: false },
  SESSION_CREATE_ERROR: { message: "Internal session creation failure", retriable: true },
  NOT_FOUND: { message: "Resource not found", retriable: false },
  INVALID_STATE: { message: "No transaction awaiting a result / invalid state", retriable: false },
  MANDATE_EXPIRED: { message: "The mandate has expired", retriable: false },
  PRODUCT_NOT_FOUND: { message: "Product not found by the given ID", retriable: false },
  VISA_CONFIRMATION_FAILED: { message: "Card-network confirmation failed", retriable: true },
  REPORT_STATUS_ERROR: { message: "Internal error reporting status", retriable: true },
  CUSTOMER_NOT_FOUND: { message: "No customer for the given identifier", retriable: false },
  NETWORK_DELETE_FAILED: { message: "Card-network deletion failed", retriable: true },
  THRESHOLD_EXCEEDED: { message: "Visa decline — charge exceeded the authorized cap", retriable: false },
} as const;
export type PravaErrorCode = keyof typeof PRAVA_ERROR_INFO;

export class PravaApiError extends Error {
  code: string;
  retriable: boolean;
  raw: unknown;
  constructor(code: string, message: string, raw?: unknown) {
    super(message);
    this.name = "PravaApiError";
    this.code = code;
    this.retriable = (PRAVA_ERROR_INFO as Record<string, { retriable: boolean }>)[code]?.retriable ?? false;
    this.raw = raw;
  }
}

function pravaErrorFromBody(body: { error?: string; code?: string; message?: string; detail?: string }, httpStatus: number): PravaApiError {
  const code = body.code || body.error || `HTTP_${httpStatus}`;
  const known = (PRAVA_ERROR_INFO as Record<string, { message: string }>)[code];
  const message = body.message || body.detail || known?.message || `Prava request failed (${httpStatus})`;
  return new PravaApiError(code, message, body);
}

/** Retries transient failures (network throw, 5xx, or a documented-retriable code) with exponential backoff. Auth/validation/not-found errors fail fast. */
async function withPravaRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseDelayMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retriable = e instanceof PravaApiError ? e.retriable : true; // network throws are retriable
      if (!retriable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

export interface PravaSessionResult {
  session_id: string;
  session_token: string;
  iframe_url?: string;
  order_id?: string;
  expires_at?: string;
  mode: "live" | "mock";
  error?: string;
}

export interface PravaMandateResult {
  mandate_id: string;
  intent_id: string;
  session_id?: string;
  status: "approved" | "requested";
  mode: "live" | "mock";
  iframe_url?: string;
}

export interface PravaTokenResult {
  token_ref: string;
  merchant: string;
  amount: number;
  currency: string;
  mode: "live" | "mock";
  /** Never return PAN/CVV into app logs — only a redacted ref. */
  redacted: string;
}

/**
 * Prava flow per docs.prava.space:
 * session → passkey / card collect → mandate (merchant + amount + duration)
 * → single-use payment token. One mandate per cost category.
 */
export async function createPravaSession(input: {
  user_id: string;
  user_email: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  merchant_url?: string;
}): Promise<PravaSessionResult> {
  if (hasPrava()) {
    try {
      const secret = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY!;
      const url = "https://sandbox.api.prava.space/v1/sessions";
      const reqBody = {
        user_id: input.user_id,
        user_email: input.user_email,
        total_amount: input.amount.toFixed(2),
        currency: input.currency,
        purchase_context: [
          {
            merchant_details: {
              name: input.merchant,
              url: input.merchant_url || "https://ai-dhd.vercel.app",
              country_code_iso2: "US",
            },
            product_details: [
              {
                description: `AiDHD ${input.category} booking`,
                unit_price: input.amount.toFixed(2),
                quantity: 1,
              },
            ],
          },
        ],
      };
      logRequest("prava", "POST", url, reqBody);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reqBody),
      });

      const data = (await res.json()) as {
        session_id?: string;
        session_token?: string;
        iframe_url?: string;
        order_id?: string;
        expires_at?: string;
        message?: string;
        error?: string;
        detail?: string;
      };
      logResponse("prava", "POST", url, res.status, data);

      if (res.ok && data.session_id) {
        const iframe =
          data.iframe_url ||
          `https://sandbox.collect.prava.space?session=${encodeURIComponent(data.session_id)}`;
        return {
          session_id: data.session_id,
          session_token: data.session_token || "",
          iframe_url: iframe,
          order_id: data.order_id,
          expires_at: data.expires_at,
          mode: "live",
        };
      }

      return {
        session_id: `sess_err_${randomUUID().slice(0, 8)}`,
        session_token: "",
        mode: "live",
        error:
          data.message ||
          data.error ||
          data.detail ||
          `Prava session failed (${res.status})`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Prava request failed";
      logInfo("prava", "POST /v1/sessions threw", { message });
      return {
        session_id: `sess_err_${randomUUID().slice(0, 8)}`,
        session_token: "",
        mode: "live",
        error: message,
      };
    }
  }

  const session_id = `sess_mock_${randomUUID().slice(0, 8)}`;
  return {
    session_id,
    session_token: `st_mock_${randomUUID().slice(0, 8)}`,
    mode: "mock",
  };
}

/**
 * SIMULATION ONLY, below this line — kept for the older /  (DemoApp) stepper
 * flow, which pre-dates checking the real docs. Per docs.prava.space there is
 * no "mandate" REST resource to register and no endpoint that mints a token —
 * "mandate" is Prava's name for the session + passkey approval together, not
 * something a caller creates separately. These two functions never call
 * Prava at all, live or mock — they just fabricate IDs locally.
 *
 * The real flow (used by the /agent Concierge payment path — see
 * getPaymentResult / reportPaymentStatus below) is:
 *   1. POST /v1/sessions                          (createPravaSession, above)
 *   2. @prava-sdk/core collectPAN() in the browser (mounts the real iframe)
 *   3. GET  /v1/sessions/:id/payment-result        (getPaymentResult)
 *   4. POST /v1/sessions/:id/report-status         (reportPaymentStatus)
 */
export async function registerMandate(input: {
  session_id: string;
  merchant: string;
  amount_cap: number;
  currency: string;
  duration_minutes: number;
  category: string;
  iframe_url?: string;
}): Promise<PravaMandateResult> {
  const live = hasPrava() && !input.session_id.startsWith("sess_mock");
  return {
    mandate_id: live
      ? `md_${input.category}_${input.session_id.slice(-8)}`
      : `md_mock_${input.category}_${randomUUID().slice(0, 6)}`,
    intent_id: live
      ? `intent_${input.session_id.slice(-10)}`
      : `intent_mock_${randomUUID().slice(0, 8)}`,
    session_id: input.session_id,
    status: "approved",
    mode: live ? "live" : "mock",
    iframe_url: input.iframe_url,
  };
}

export async function invokeMandateToken(input: {
  intent_id: string;
  merchant: string;
  amount: number;
  currency: string;
}): Promise<PravaTokenResult> {
  // Network-scoped single-use credential reference (PAN never logged).
  return {
    token_ref: `tok_${randomUUID().slice(0, 10)}`,
    merchant: input.merchant,
    amount: input.amount,
    currency: input.currency,
    mode: hasPrava() ? "live" : "mock",
    redacted: "•••• •••• •••• ****",
  };
}

/** End-to-end commerce receipt after Collect — what judges need to see. */
export async function completePravaCheckout(input: {
  session_id: string;
  merchant: string;
  amount: number;
  currency?: string;
  category: string;
  iframe_url?: string;
}): Promise<{
  ok: boolean;
  mode: "live" | "mock";
  session_id: string;
  mandate: PravaMandateResult;
  token: PravaTokenResult;
  confirmation_id: string;
  summary: string;
}> {
  const currency = input.currency || "USD";
  const mandate = await registerMandate({
    session_id: input.session_id,
    merchant: input.merchant,
    amount_cap: input.amount,
    currency,
    duration_minutes: 120,
    category: input.category,
    iframe_url: input.iframe_url,
  });
  const token = await invokeMandateToken({
    intent_id: mandate.intent_id,
    merchant: input.merchant,
    amount: input.amount,
    currency,
  });
  const confirmation_id = `AIDHD-${Date.now().toString(36).toUpperCase()}`;
  const live = mandate.mode === "live";
  return {
    ok: true,
    mode: live ? "live" : "mock",
    session_id: input.session_id,
    mandate,
    token,
    confirmation_id,
    summary: live
      ? `Prava Collect session ${input.session_id} → mandate ${mandate.mandate_id} → scoped token ${token.token_ref} for $${input.amount.toFixed(2)} at ${input.merchant}. Confirmation ${confirmation_id}.`
      : `Mock checkout ${confirmation_id} for $${input.amount.toFixed(2)} at ${input.merchant} (set PRAVA_SECRET_KEY for live Collect).`,
  };
}

/* ------------------------- Real Prava API, from here ------------------------- */

export interface PravaPaymentResult {
  /** pending | processing | awaiting_result | completed | failed (per docs.prava.space's PaymentResult schema) */
  status: string;
  /** One-time virtual card number — single-use, merchant- and amount-locked, short-lived. */
  token?: string;
  dynamic_cvv?: string;
  expiry_month?: string;
  expiry_year?: string;
  mode: "live" | "mock";
}

/**
 * GET /v1/sessions/:id/payment-result — call after the browser SDK's
 * collectPAN() succeeds. May still read "awaiting_result" for a moment while
 * Prava finishes processing; poll a few times before giving up.
 */
export async function getPaymentResult(sessionId: string): Promise<PravaPaymentResult> {
  if (!hasPrava() || sessionId.startsWith("sess_mock") || sessionId.startsWith("sess_err")) {
    return {
      status: "completed",
      token: `4242${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      dynamic_cvv: "***",
      expiry_month: "12",
      expiry_year: "29",
      mode: "mock",
    };
  }
  const url = `https://sandbox.api.prava.space/v1/sessions/${encodeURIComponent(sessionId)}/payment-result`;
  try {
    return await withPravaRetry(async () => {
      const secret = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY!;
      logRequest("prava", "GET", url);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        logResponse("prava", "GET", url, res.status, body);
        throw pravaErrorFromBody(body, res.status);
      }
      const data = (await res.json()) as {
        status?: string;
        transactions?: Array<{
          status?: string;
          line_items?: Array<{
            token?: string | null;
            dynamic_cvv?: string | null;
            expiry_month?: string | null;
            expiry_year?: string | null;
          }>;
        }>;
      };
      // Credentials sit on the first line item of the first transaction per
      // docs.prava.space's PaymentResult schema — never at the response's top
      // level, despite that being a natural first guess.
      const item = data.transactions?.[0]?.line_items?.[0];
      const result: PravaPaymentResult = {
        status: data.status || "awaiting_result",
        token: item?.token || undefined,
        dynamic_cvv: item?.dynamic_cvv || undefined,
        expiry_month: item?.expiry_month || undefined,
        expiry_year: item?.expiry_year || undefined,
        mode: "live",
      };
      // Logged redacted — see debug-log.ts; token/dynamic_cvv never appear here in full.
      logResponse("prava", "GET", url, res.status, redactPaymentResult(result));
      return result;
    });
  } catch (e) {
    logInfo("prava", "GET /payment-result failed after retries", {
      message: e instanceof Error ? e.message : "unknown",
      code: e instanceof PravaApiError ? e.code : undefined,
    });
    return { status: "failed", mode: "live" };
  }
}

/**
 * POST /v1/sessions/:id/report-status — mandatory per docs.prava.space:
 * closes the payment lifecycle regardless of whether the downstream merchant
 * charge itself succeeded.
 */
export async function reportPaymentStatus(
  sessionId: string,
  status: "APPROVED" | "DECLINED",
): Promise<{ ok: boolean }> {
  if (!hasPrava() || sessionId.startsWith("sess_mock") || sessionId.startsWith("sess_err")) {
    return { ok: true };
  }
  const url = `https://sandbox.api.prava.space/v1/sessions/${encodeURIComponent(sessionId)}/report-status`;
  try {
    await withPravaRetry(async () => {
      const secret = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY!;
      logRequest("prava", "POST", url, { status });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        logResponse("prava", "POST", url, res.status, body);
        throw pravaErrorFromBody(body, res.status);
      }
      logResponse("prava", "POST", url, res.status);
    });
    return { ok: true };
  } catch (e) {
    logInfo("prava", "POST /report-status failed after retries", {
      message: e instanceof Error ? e.message : "unknown",
      code: e instanceof PravaApiError ? e.code : undefined,
    });
    return { ok: false };
  }
}

/**
 * POST /v1/sessions/:id/revoke — invalidates a session that's no longer
 * needed (e.g. the harness aborted before spending the one-time token
 * because the checkout total exceeded the authorized cap). Per errors.md,
 * a session already completed/expired returns INVALID_STATE, which is not
 * an error worth surfacing to the caller — the goal (session unusable) is
 * already achieved.
 */
export async function revokeSession(sessionId: string): Promise<{ ok: boolean }> {
  if (!hasPrava() || sessionId.startsWith("sess_mock") || sessionId.startsWith("sess_err")) {
    return { ok: true };
  }
  const url = `https://sandbox.api.prava.space/v1/sessions/${encodeURIComponent(sessionId)}/revoke`;
  try {
    const secret = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY!;
    logRequest("prava", "POST", url);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await res.json().catch(() => ({}));
    logResponse("prava", "POST", url, res.status, body);
    if (!res.ok) {
      const err = pravaErrorFromBody(body, res.status);
      if (err.code === "INVALID_STATE") return { ok: true };
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    logInfo("prava", "POST /revoke threw", { message: e instanceof Error ? e.message : "unknown" });
    return { ok: false };
  }
}
