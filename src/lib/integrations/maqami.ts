/**
 * MAQAMI (mcp.maqami.co) — a public MCP server wrapping LiteAPI's hotel
 * inventory. No API key needed to call it. Payment goes through LiteAPI's
 * own hosted Stripe wrapper (payment-wrapper.liteapi.travel) — the prebook
 * call returns a genuine Stripe PaymentIntent client_secret ("secretKey"),
 * confirmed via a real Stripe Payment Element on our own checkout page.
 *
 * publicKey "sandbox" (not "live") routes to a Stripe TEST-mode publishable
 * key — verified by calling payment-wrapper.liteapi.travel/config directly.
 * Real card data never has to touch our servers; the Prava one-time card is
 * typed into Stripe's own PCI-scoped iframe by Playwright, same shape as the
 * Duffel flow.
 */

const MCP_URL = "https://mcp.maqami.co/";

async function callMaqamiTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const match = text.match(/data:\s*(\{[\s\S]*\})\s*$/);
  if (!match) throw new Error(`MAQAMI ${name}: unexpected response shape`);
  const outer = JSON.parse(match[1]);
  if (outer.error) throw new Error(`MAQAMI ${name}: ${outer.error.message || "tool error"}`);
  const inner = JSON.parse(outer.result.content[0].text);
  if (inner.error) throw new Error(`MAQAMI ${name}: ${inner.error.message || JSON.stringify(inner.error)}`);
  return (inner.data ?? inner) as T;
}

export interface MaqamiRoomOffer {
  offerId: string;
  hotelId: string;
  roomName: string;
  amount: number;
  currency: string;
}

/** Search + flatten to the single cheapest bookable room — kept deliberately narrow for a one-shot demo booking. */
export async function findCheapestMaqamiHotel(input: {
  cityName?: string;
  countryCode?: string;
  checkin?: string;
  checkout?: string;
  currency?: string;
  guestNationality?: string;
}): Promise<MaqamiRoomOffer | null> {
  const data = await callMaqamiTool<{
    data: Array<{
      hotelId: string;
      roomTypes: Array<{
        offerId: string;
        rates: Array<{
          name: string;
          retailRate: { total: Array<{ amount: number; currency: string }> };
        }>;
      }>;
    }>;
  }>("post_hotels_rates", {
    cityName: input.cityName || "Dubai",
    countryCode: input.countryCode || "AE",
    checkin: input.checkin || "2026-09-15",
    checkout: input.checkout || "2026-09-16",
    currency: input.currency || "USD",
    guestNationality: input.guestNationality || "US",
    occupancies: [{ adults: 1 }],
    limit: 10,
  });

  let cheapest: MaqamiRoomOffer | null = null;
  for (const hotel of data.data) {
    for (const rt of hotel.roomTypes) {
      const rate = rt.rates[0];
      if (!rate) continue;
      const total = rate.retailRate.total[0];
      if (!total) continue;
      if (!cheapest || total.amount < cheapest.amount) {
        cheapest = {
          offerId: rt.offerId,
          hotelId: hotel.hotelId,
          roomName: rate.name,
          amount: total.amount,
          currency: total.currency,
        };
      }
    }
  }
  return cheapest;
}

export interface MaqamiPrebookResult {
  prebookId: string;
  transactionId: string;
  secretKey: string;
  amount: number;
  currency: string;
  hotelId: string;
  checkin: string;
  checkout: string;
}

export async function prebookMaqamiOffer(offerId: string): Promise<MaqamiPrebookResult> {
  const data = await callMaqamiTool<{
    prebookId: string;
    transactionId: string;
    secretKey: string;
    price: number;
    currency: string;
    hotelId: string;
    checkin: string;
    checkout: string;
  }>("post_rates_prebook", { offerId, usePaymentSdk: true });
  return {
    prebookId: data.prebookId,
    transactionId: data.transactionId,
    secretKey: data.secretKey,
    amount: data.price,
    currency: data.currency,
    hotelId: data.hotelId,
    checkin: data.checkin,
    checkout: data.checkout,
  };
}

export interface MaqamiBookResult {
  ok: boolean;
  bookingId?: string;
  confirmationCode?: string;
  error?: string;
  raw: unknown;
}

export async function bookMaqamiPrebook(input: {
  prebookId: string;
  transactionId: string;
  holder: { firstName: string; lastName: string; email: string; phone: string };
}): Promise<MaqamiBookResult> {
  try {
    const data = await callMaqamiTool<{
      bookingId?: string;
      status?: string;
      hotelConfirmationCode?: string;
    }>("post_rates_book", {
      prebookId: input.prebookId,
      holder: input.holder,
      guests: [
        {
          occupancyNumber: 1,
          firstName: input.holder.firstName,
          lastName: input.holder.lastName,
          email: input.holder.email,
        },
      ],
      payment: { method: "TRANSACTION_ID", transactionId: input.transactionId },
    });
    return {
      ok: true,
      bookingId: data.bookingId,
      confirmationCode: data.hotelConfirmationCode,
      raw: data,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "MAQAMI booking failed", raw: null };
  }
}
