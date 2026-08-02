import { NextResponse } from "next/server";
import { createLastminuteBookingSession } from "@/lib/checkout/lastminute-booking";
import type { LastminuteFlightOption } from "@/lib/integrations/lastminute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionRequestBody = {
  user_id?: string;
  user_email?: string;
  currency?: string;
  flight?: LastminuteFlightOption;
};

/**
 * Phase 1 of the lastminute.com booking flow — creates the Prava session for
 * a flight already chosen from integrations/lastminute.ts's searchLastminuteFlights().
 * The frontend opens the returned iframe_url for the user's passkey/card
 * approval, then calls POST /api/lastminute/execute once that completes.
 */
export async function POST(req: Request) {
  let body: SessionRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { user_id, user_email, currency, flight } = body;
  if (!user_id || !user_email || !currency || !flight?.deeplink || flight.price_amount == null) {
    return NextResponse.json(
      { ok: false, error: "user_id, user_email, currency, and flight (with deeplink + price_amount) are required" },
      { status: 400 },
    );
  }

  const { booking_id, session, amount, deeplink } = await createLastminuteBookingSession({
    user_id,
    user_email,
    flight,
    currency,
  });

  if (session.error) {
    return NextResponse.json(
      { ok: false, booking_id, error: session.error },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    booking_id,
    session_id: session.session_id,
    iframe_url: session.iframe_url,
    expires_at: session.expires_at,
    mode: session.mode,
    amount,
    currency,
    deeplink,
  });
}
