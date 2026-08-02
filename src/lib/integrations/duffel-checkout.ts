import { hasDuffel } from "./config";

/**
 * Order-side Duffel calls — separate from flights.ts (search) because these
 * are the "spend the money" half: a Component Client Key for the PCI-scoped
 * DuffelCardForm iframe, and the Order Create call that actually books the
 * offer once a card has cleared 3D Secure.
 *
 * Duffel never accepts a raw card number/CVC in a JSON request body — card
 * capture happens client-side in DuffelCardForm's iframe (assets.duffel.com /
 * api.duffel.cards), which returns a Card ID; that ID is then used to open a
 * 3DS session, and only the resulting three_d_secure_session_id is sent here.
 * See docs.prava.space's browser-harness page and duffel.com/docs/guides/
 * card-form-component-with-3dsecure.
 */

const DUFFEL_API = "https://api.duffel.com";

function duffelHeaders() {
  return {
    Authorization: `Bearer ${process.env.DUFFEL_API_KEY}`,
    "Duffel-Version": "v2",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * POST /identity/component_client_keys — a short-lived JWT that authenticates
 * the browser-side DuffelCardForm component. Must be minted per checkout
 * session; never reused across users.
 */
export async function createDuffelComponentClientKey(): Promise<string> {
  if (!hasDuffel()) {
    throw new Error("DUFFEL_API_KEY not configured");
  }
  const res = await fetch(`${DUFFEL_API}/identity/component_client_keys`, {
    method: "POST",
    headers: duffelHeaders(),
    body: JSON.stringify({}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      json?.errors?.[0]?.message ||
        `Duffel component_client_key failed (HTTP ${res.status})`,
    );
  }
  const key = json?.data?.component_client_key as string | undefined;
  if (!key) throw new Error("Duffel component_client_key response missing key");
  return key;
}

export interface DuffelOrderPassenger {
  id: string;
  given_name: string;
  family_name: string;
  born_on: string;
  gender: "m" | "f";
  title: "mr" | "ms" | "mrs" | "miss" | "dr";
  email: string;
  phone_number: string;
}

export interface DuffelOrderResult {
  ok: boolean;
  order_id?: string;
  booking_reference?: string;
  total_amount?: string;
  total_currency?: string;
  error?: string;
  raw: unknown;
}

/**
 * POST /air/orders — pays for a previously-searched offer using a card
 * that has already cleared a 3DS session (see createThreeDSecureSession in
 * @duffel/components, called client-side in the checkout page).
 */
export async function createDuffelOrder(input: {
  offerId: string;
  threeDSecureSessionId: string;
  amount: string;
  currency: string;
  passengers: DuffelOrderPassenger[];
}): Promise<DuffelOrderResult> {
  if (!hasDuffel()) {
    return { ok: false, error: "DUFFEL_API_KEY not configured", raw: null };
  }
  const res = await fetch(`${DUFFEL_API}/air/orders`, {
    method: "POST",
    headers: duffelHeaders(),
    body: JSON.stringify({
      data: {
        type: "instant",
        selected_offers: [input.offerId],
        payments: [
          {
            type: "card",
            currency: input.currency,
            amount: input.amount,
            three_d_secure_session_id: input.threeDSecureSessionId,
          },
        ],
        passengers: input.passengers,
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: json?.errors?.[0]?.message || `Duffel order failed (HTTP ${res.status})`,
      raw: json,
    };
  }
  return {
    ok: true,
    order_id: json?.data?.id,
    booking_reference: json?.data?.booking_reference,
    total_amount: json?.data?.total_amount,
    total_currency: json?.data?.total_currency,
    raw: json,
  };
}

/** Fetch a single offer by ID — needed to re-derive the live passenger ID + price right before paying. */
export async function getDuffelOffer(offerId: string): Promise<{
  id: string;
  total_amount: string;
  total_currency: string;
  passengerId: string;
} | null> {
  if (!hasDuffel()) return null;
  const res = await fetch(`${DUFFEL_API}/air/offers/${encodeURIComponent(offerId)}`, {
    headers: duffelHeaders(),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  const data = json?.data;
  const passengerId = data?.passengers?.[0]?.id;
  if (!data?.id || !passengerId) return null;
  return {
    id: data.id,
    total_amount: data.total_amount,
    total_currency: data.total_currency,
    passengerId,
  };
}
