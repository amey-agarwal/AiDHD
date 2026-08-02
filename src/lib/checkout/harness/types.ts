/**
 * CheckoutHarness — browser automation that spends a Prava one-time card on
 * a merchant's own live checkout page (no server-to-server payment API).
 * See docs/lastminute-prava-integration.md for why this exists for
 * lastminute.com specifically (no order-creation API, no sandbox).
 *
 * Card number, CVV, and expiry must NEVER be placed in an LLM prompt —
 * see credential-guard.ts, which every implementation must route AI-assisted
 * (act/extract) calls through.
 */

export interface HarnessCredentials {
  /** One-time, merchant-scoped virtual PAN from Prava's payment-result. */
  token: string;
  dynamic_cvv: string;
  expiry_month: string;
  expiry_year: string;
}

export interface HarnessPassenger {
  given_name: string;
  family_name: string;
  email: string;
  phone: string;
  /** YYYY-MM-DD */
  born_on: string;
  title: "mr" | "ms" | "mrs" | "miss";
  address: {
    line1: string;
    house_number?: string;
    postal_code: string;
    city: string;
  };
}

export interface HarnessTotalCheck {
  /** Prava session's total_amount — the hard authorization cap. */
  authorized_cap: number;
  currency: string;
  /** Absolute amount above the cap still considered acceptable (fees/rounding drift). */
  tolerance: number;
}

export interface HarnessStepEvent {
  name: string;
  /** The literal selector, or the act()/extract() instruction string — never a credential value. */
  instruction: string;
  outcome: "ok" | "error";
  duration_ms: number;
  screenshot_base64?: string;
  error?: string;
}

export type Receipt =
  | {
      ok: true;
      booking_reference: string;
      confirmation_text: string;
      final_amount: number;
      steps: HarnessStepEvent[];
    }
  | {
      ok: false;
      failure_reason: string;
      /** Which part of the flow failed — lets the orchestrator decide whether to re-quote vs. surface to a human. */
      stage:
        | "navigation"
        | "cookie_banner"
        | "fare_review"
        | "contact_details"
        | "traveller_details"
        | "ancillaries"
        | "total_verification"
        | "payment_fields"
        | "3ds_challenge"
        | "submit"
        | "confirmation"
        | "timeout";
      /** True when a human needs to look at this (e.g. an unrecognized 3DS/OTP interstitial) rather than retry automatically. */
      requires_human?: boolean;
      steps: HarnessStepEvent[];
    };

export interface CheckoutHarnessInput {
  /** Correlation id for debug-logs — see src/lib/checkout/debug-log.ts. */
  booking_id: string;
  /** The lastminute.com deeplink from search_flights — see integrations/lastminute.ts. */
  checkout_url: string;
  credentials: HarnessCredentials;
  passenger: HarnessPassenger;
  total_check: HarnessTotalCheck;
  /** Hard wall-clock budget for the whole run — fare holds expire (~30 min observed). */
  timeout_ms?: number;
}

export interface CheckoutHarness {
  complete(input: CheckoutHarnessInput): Promise<Receipt>;
}
