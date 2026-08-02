import { NextResponse } from "next/server";
import { executeLastminuteBooking } from "@/lib/checkout/lastminute-booking";
import type { HarnessPassenger } from "@/lib/checkout/harness/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExecuteRequestBody = {
  booking_id?: string;
  session_id?: string;
  deeplink?: string;
  amount?: number;
  currency?: string;
  passenger?: HarnessPassenger;
};

/**
 * Phase 2 — fires after the frontend's Prava iframe approval completes.
 * Polls for the one-time card, runs CheckoutHarness against the lastminute
 * deeplink, and reports the outcome back to Prava either way. Currently
 * always ends at the total-verification/payment_fields stage with
 * requires_human: true — see harness/lastminute-selectors.ts for why the
 * payment-step selectors aren't filled in yet.
 */
export async function POST(req: Request) {
  let body: ExecuteRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { booking_id, session_id, deeplink, amount, currency, passenger } = body;
  if (!booking_id || !session_id || !deeplink || amount == null || !currency || !passenger) {
    return NextResponse.json(
      { ok: false, error: "booking_id, session_id, deeplink, amount, currency, passenger required" },
      { status: 400 },
    );
  }

  const outcome = await executeLastminuteBooking({
    booking_id,
    session_id,
    deeplink,
    amount,
    currency,
    passenger,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        ok: false,
        booking_id,
        error_code: outcome.error_code,
        error: outcome.error_message,
        requires_human: outcome.requires_human,
      },
      { status: outcome.requires_human ? 409 : 402 },
    );
  }

  return NextResponse.json({
    ok: true,
    booking_id,
    booking_reference: outcome.booking_reference,
    confirmation_id: outcome.booking_reference,
    summary: `lastminute.com booking ${outcome.booking_reference} confirmed for ${currency} ${outcome.final_amount.toFixed(2)}.`,
  });
}
