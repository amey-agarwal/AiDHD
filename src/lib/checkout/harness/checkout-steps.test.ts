import { describe, it, expect } from "vitest";
import { verifyDisplayedTotal } from "./checkout-steps";
import type { Page } from "playwright";

function fakePage(bodyText: string): Page {
  return { evaluate: async () => bodyText } as unknown as Page;
}

describe("verifyDisplayedTotal", () => {
  it("passes when the displayed total is within the authorized cap", async () => {
    const page = fakePage("Total price\n£68.45\nTime remaining: 29:44");
    const result = await verifyDisplayedTotal(page, { authorized_cap: 68.45, currency: "GBP", tolerance: 1 });
    expect(result).toEqual({ ok: true, displayed_amount: 68.45 });
  });

  it("passes when the displayed total is within tolerance but above the exact cap", async () => {
    const page = fakePage("Total price\n£70.00\n");
    const result = await verifyDisplayedTotal(page, { authorized_cap: 68.45, currency: "GBP", tolerance: 2 });
    expect(result.ok).toBe(true);
  });

  it("fails when the displayed total exceeds the cap beyond tolerance — the mandatory abort gate", async () => {
    const page = fakePage("Total price\n£95.00\n");
    const result = await verifyDisplayedTotal(page, { authorized_cap: 68.45, currency: "GBP", tolerance: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.displayed_amount).toBe(95);
      expect(result.reason).toContain("exceeds authorized cap");
    }
  });

  it("fails cleanly when no total can be found on the page, rather than assuming success", async () => {
    const page = fakePage("Something went wrong loading this page");
    const result = await verifyDisplayedTotal(page, { authorized_cap: 68.45, currency: "GBP", tolerance: 1 });
    expect(result.ok).toBe(false);
  });

  it("supports $ and € prefixed totals", async () => {
    const eur = fakePage("Total price\n€68.45\n");
    expect((await verifyDisplayedTotal(eur, { authorized_cap: 68.45, currency: "EUR", tolerance: 0.5 })).ok).toBe(true);
    const usd = fakePage("Total price\n$68.45\n");
    expect((await verifyDisplayedTotal(usd, { authorized_cap: 68.45, currency: "USD", tolerance: 0.5 })).ok).toBe(true);
  });
});
