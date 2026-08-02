import { NextResponse } from "next/server";
import {
  createDuffelOrder,
  getDuffelOffer,
  type DuffelOrderPassenger,
} from "@/lib/integrations/duffel-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Books the offer server-side once the browser has a 3DS session id — amount
 * and currency are re-read from the live offer here rather than trusted from
 * the client, same reasoning as the rest of this app's payment paths.
 */
export async function POST(req: Request) {
  let body: {
    offerId?: string;
    threeDSecureSessionId?: string;
    passenger?: DuffelOrderPassenger;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.offerId || !body.threeDSecureSessionId || !body.passenger) {
    return NextResponse.json(
      { ok: false, error: "offerId, threeDSecureSessionId and passenger are required" },
      { status: 400 },
    );
  }

  const offer = await getDuffelOffer(body.offerId);
  if (!offer) {
    return NextResponse.json({ ok: false, error: "Offer not found or expired" }, { status: 404 });
  }

  const result = await createDuffelOrder({
    offerId: offer.id,
    threeDSecureSessionId: body.threeDSecureSessionId,
    amount: offer.total_amount,
    currency: offer.total_currency,
    passengers: [{ ...body.passenger, id: offer.passengerId }],
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
