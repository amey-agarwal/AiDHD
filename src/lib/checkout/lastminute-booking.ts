import { randomUUID } from "crypto";
import { createPravaSession, revokeSession, reportPaymentStatus } from "../integrations/prava";
import type { LastminuteFlightOption } from "../integrations/lastminute";
import { pollForCompletedPayment } from "./poll-payment-result";
import { PlaywrightHarness } from "./harness/playwright-harness";
import { StagehandHarness } from "./harness/stagehand-harness";
import type { CheckoutHarness, HarnessPassenger, Receipt } from "./harness/types";
import { logBookingEvent } from "./debug-log";

/**
 * Wires the full pipeline from docs/lastminute-prava-integration.md §3:
 *   MCP search (caller-supplied, already done — see integrations/lastminute.ts)
 *   → Prava session → user approval (frontend) → poll for one-time card
 *   → CheckoutHarness.complete() against the deeplink, with the mandatory
 *     total-verification gate → report-status, regardless of outcome.
 *
 * Two-phase, same shape as app/api/checkout/execute/route.ts's Duffel flow:
 * createLastminuteBookingSession() runs before the frontend opens Prava's
 * iframe; executeLastminuteBooking() runs after the user approves.
 */

const TOTAL_TOLERANCE_FRACTION = 0.05; // 5% — covers taxes/fees drift between MCP search and live checkout, not a blank check

export async function createLastminuteBookingSession(input: {
  user_id: string;
  user_email: string;
  flight: LastminuteFlightOption;
  currency: string;
  /** ISO2 — defaults to "GB" per the LMNUK cobrand tag observed on deeplinks; override once a real market signal exists. */
  merchant_country?: string;
}) {
  const booking_id = `lm_${randomUUID()}`;
  logBookingEvent({
    booking_id,
    stage: "fare_search",
    event: "flight selected",
    data: {
      flight_number: input.flight.flight_number,
      airline: input.flight.airline,
      price: input.flight.price,
      price_amount: input.flight.price_amount,
    },
  });

  const amount = input.flight.price_amount / 100;
  const session = await createPravaSession({
    user_id: input.user_id,
    user_email: input.user_email,
    merchant: "lastminute.com",
    merchant_url: "https://www.lastminute.com",
    amount,
    currency: input.currency,
    category: "flight",
  });

  logBookingEvent({
    booking_id,
    stage: "prava_session",
    event: session.error ? `session error: ${session.error}` : `session ${session.session_id} created`,
    level: session.error ? "error" : "info",
    data: { session_id: session.session_id, mode: session.mode, expires_at: session.expires_at },
  });

  return { booking_id, session, amount, deeplink: input.flight.deeplink };
}

export type LastminuteBookingOutcome =
  | { ok: true; booking_id: string; booking_reference: string; final_amount: number }
  | { ok: false; booking_id: string; error_code: string; error_message: string; requires_human?: boolean };

async function runHarnessWithFallback(
  booking_id: string,
  harnessInput: Parameters<CheckoutHarness["complete"]>[0],
): Promise<Receipt> {
  const primary = new PlaywrightHarness();
  try {
    return await primary.complete(harnessInput);
  } catch (e) {
    // A thrown exception means the harness itself malfunctioned (e.g. no
    // browser session could be resolved at all) — that's worth trying the
    // alternate implementation for. A clean `{ ok: false }` Receipt is a
    // real business outcome (total drifted, payment step unverified, ...)
    // and must NOT trigger a blind retry with a different tool.
    logBookingEvent({
      booking_id,
      stage: "harness",
      event: `PlaywrightHarness threw, falling back to StagehandHarness: ${e instanceof Error ? e.message : "unknown"}`,
      level: "warn",
    });
    const fallback = new StagehandHarness();
    return fallback.complete(harnessInput);
  }
}

export async function executeLastminuteBooking(input: {
  booking_id: string;
  session_id: string;
  deeplink: string;
  amount: number;
  currency: string;
  passenger: HarnessPassenger;
}): Promise<LastminuteBookingOutcome> {
  const { booking_id } = input;

  // 1. POLL FOR CREDENTIALS ------------------------------------------------
  const polled = await pollForCompletedPayment(input.session_id);
  if (!polled.ok) {
    await reportPaymentStatus(input.session_id, "DECLINED").catch(() => {});
    logBookingEvent({
      booking_id,
      stage: "credential_issuance",
      event: `payment result not ready (${polled.reason}, last status ${polled.last_status})`,
      level: "error",
    });
    return {
      ok: false,
      booking_id,
      error_code: "payment_result_not_ready",
      error_message: `Payment result not ready (${polled.reason}, last status: ${polled.last_status})`,
    };
  }
  const { token, dynamic_cvv, expiry_month, expiry_year } = polled.result;
  if (!token || !dynamic_cvv || !expiry_month || !expiry_year) {
    await reportPaymentStatus(input.session_id, "DECLINED").catch(() => {});
    return {
      ok: false,
      booking_id,
      error_code: "credentials_incomplete",
      error_message: "Payment completed but credentials were incomplete",
    };
  }
  // Presence-only — never the values themselves. Full redaction also happens centrally in debug-log.ts's scrubSecrets.
  logBookingEvent({ booking_id, stage: "credential_issuance", event: "one-time credential issued: token=PRESENT, dynamic_cvv=PRESENT" });

  // 2. RUN THE HARNESS + 3. REPORT THE OUTCOME -----------------------------
  // --- CREDENTIAL-HANDLING BOUNDARY --- token/dynamic_cvv only flow into
  // the harness's `credentials` argument below, then fall out of scope.
  let receipt: Receipt;
  try {
    receipt = await runHarnessWithFallback(booking_id, {
      booking_id,
      checkout_url: input.deeplink,
      credentials: { token, dynamic_cvv, expiry_month, expiry_year },
      passenger: input.passenger,
      total_check: {
        authorized_cap: input.amount,
        currency: input.currency,
        tolerance: input.amount * TOTAL_TOLERANCE_FRACTION,
      },
    });
  } catch (e) {
    await reportPaymentStatus(input.session_id, "DECLINED").catch(() => {});
    return {
      ok: false,
      booking_id,
      error_code: "harness_exception",
      error_message: e instanceof Error ? e.message : "Checkout harness failed unexpectedly",
    };
  }
  // --- END CREDENTIAL-HANDLING BOUNDARY ---

  await reportPaymentStatus(input.session_id, receipt.ok ? "APPROVED" : "DECLINED").catch(() => {});

  if (!receipt.ok) {
    // The one-time token was never spent (we stop before any submit) — free
    // the session rather than leaving it to expire naturally, so a re-quote
    // can open a clean new one immediately if the caller wants to retry.
    if (receipt.stage !== "submit" && receipt.stage !== "confirmation") {
      await revokeSession(input.session_id).catch(() => {});
    }
    logBookingEvent({
      booking_id,
      stage: receipt.stage,
      event: `booking failed: ${receipt.failure_reason}`,
      level: "error",
      data: { requires_human: receipt.requires_human },
    });
    return {
      ok: false,
      booking_id,
      error_code: `lastminute_${receipt.stage}_failed`,
      error_message: receipt.failure_reason,
      requires_human: receipt.requires_human,
    };
  }

  logBookingEvent({
    booking_id,
    stage: "confirmation",
    event: `booking confirmed: ${receipt.booking_reference}`,
    data: { final_amount: receipt.final_amount },
  });
  return {
    ok: true,
    booking_id,
    booking_reference: receipt.booking_reference,
    final_amount: receipt.final_amount,
  };
}
