import type { DuffelOrderResult } from "./duffel-checkout";

/**
 * Drives our own /checkout/[offerId] page (which hosts Duffel's PCI-scoped
 * DuffelCardForm iframe) with the one-time Prava card, so the credentials
 * obtained from GET /v1/sessions/:id/payment-result actually get spent on
 * the specific Duffel offer the traveler picked.
 *
 * Selectors below were captured by rendering the real card-form iframe
 * (assets.duffel.com / api.duffel.cards) in a live browser — see the
 * "Card Payment Form" iframe's own <label for=...> / <input id=...> pairs.
 * That fill + our page's own "Pay" button click were verified end-to-end
 * against a live Duffel sandbox account and correctly reach Duffel's API —
 * the only thing blocking a full run in this environment's Duffel test
 * account is a 403 "This feature is unavailable. Contact help@duffel.com" on
 * card capture, which is an account permission gate, not a code issue. The
 * 3DS-challenge branch below (Duffel docs: sandbox OTP "111-111") could not
 * be exercised for the same reason and should be re-verified once that
 * account flag is enabled.
 */

const BASE_URL = process.env.AIDHD_BASE_URL || "http://localhost:3000";

export interface DuffelCheckoutCredentials {
  token: string;
  dynamic_cvv: string;
  expiry_month: string;
  expiry_year: string;
}

export type DuffelCheckoutRunResult = DuffelOrderResult | { ok: false; error: string; raw: null };

export async function runDuffelCheckout(
  offerId: string,
  credentials: DuffelCheckoutCredentials,
): Promise<DuffelCheckoutRunResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/checkout/${encodeURIComponent(offerId)}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const cardFrame = page.frameLocator('iframe[src*="duffel.cards/vault"]');
    await cardFrame.locator("#card-number").waitFor({ state: "visible", timeout: 20000 });

    const expiry = `${credentials.expiry_month.padStart(2, "0")}/${credentials.expiry_year.slice(-2)}`;
    await cardFrame.locator("#card-number").fill(credentials.token.replace(/\s/g, ""));
    await cardFrame.locator("#expiry").fill(expiry);
    await cardFrame.locator("#cvc").fill(credentials.dynamic_cvv);
    // Billing fields aren't part of the Prava credential — this app doesn't
    // collect real traveler billing details anywhere upstream, same
    // simplification as the demo passenger in duffel-checkout.ts.
    await cardFrame.locator("#card-holder").fill("AiDHD Traveler");
    await cardFrame.locator("#country").selectOption("US");
    await cardFrame.locator("#address").fill("1 Market St");
    await cardFrame.locator("#city").fill("San Francisco");
    await cardFrame.locator("#zipcode").fill("94105");
    await cardFrame.locator("#state").fill("CA");

    await page.getByRole("button", { name: "Pay" }).click();

    // Unverified branch (see file header) — Duffel's SDK auto-opens a modal
    // for a 3DS challenge; sandbox mode accepts the fixed OTP "111-111".
    try {
      const otpInput = page.locator('input[inputmode="numeric"], input[type="tel"], input[autocomplete="one-time-code"]').last();
      await otpInput.waitFor({ state: "visible", timeout: 8000 });
      await otpInput.fill("111-111");
      const submit = page.getByRole("button", { name: /submit|confirm|continue|verify/i });
      if (await submit.count()) await submit.first().click();
    } catch {
      // No challenge shown — card/supplier didn't require 3DS, proceed.
    }

    const status = page.locator("#checkout-status");
    for (let i = 0; i < 25; i++) {
      const st = await status.getAttribute("data-status");
      if (st === "order-success" || st === "order-error") {
        const raw = await status.getAttribute("data-order-result");
        if (raw) return JSON.parse(raw) as DuffelOrderResult;
        return { ok: false, error: "Missing order result payload", raw: null };
      }
      if (st === "card-error" || st === "3ds-failed") {
        const text = await status.innerText();
        return { ok: false, error: text, raw: null };
      }
      await page.waitForTimeout(1000);
    }
    return { ok: false, error: "Timed out waiting for Duffel order result", raw: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Checkout automation failed", raw: null };
  } finally {
    await browser.close();
  }
}
