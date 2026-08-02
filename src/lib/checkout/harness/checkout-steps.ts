import type { Page } from "playwright";
import { LASTMINUTE_SELECTORS } from "./lastminute-selectors";
import type { HarnessPassenger, HarnessTotalCheck } from "./types";

/** Best-effort — absence of a cookie banner is not an error. */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  for (const selector of LASTMINUTE_SELECTORS.cookieBanner.acceptCandidates) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        return true;
      }
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/** Only present when landing on the fare-review page before the cart is created; a no-op if already past it. */
export async function clickFareReviewContinueIfPresent(page: Page): Promise<boolean> {
  try {
    const btn = page.locator(LASTMINUTE_SELECTORS.fareReview.continue).first();
    if (await btn.isVisible({ timeout: 4000 })) {
      await btn.click();
      return true;
    }
  } catch {
    // not on the fare-review page — fine
  }
  return false;
}

export async function fillContactDetails(page: Page, passenger: HarnessPassenger): Promise<void> {
  const s = LASTMINUTE_SELECTORS.contact;
  await page.locator(s.firstName).first().fill(passenger.given_name);
  await page.locator(s.lastName).first().fill(passenger.family_name);
  await page.locator(s.email).first().fill(passenger.email);
  await page.locator(s.phone).first().fill(passenger.phone);
}

export async function fillAddressDetails(page: Page, passenger: HarnessPassenger): Promise<void> {
  const s = LASTMINUTE_SELECTORS.address;
  await page.locator(s.line1).first().fill(passenger.address.line1);
  if (passenger.address.house_number) {
    await page.locator(s.houseNumber).first().fill(passenger.address.house_number).catch(() => {});
  }
  await page.locator(s.postCode).first().fill(passenger.address.postal_code);
  await page.locator(s.city).first().fill(passenger.address.city);
}

/**
 * Fills the primary traveller's name/surname/title. Deliberately does NOT
 * fill date-of-birth — the segmented Day/Month/Year control's exact field
 * scoping wasn't pinned down in the one exploration pass (see
 * lastminute-selectors.ts); guessing it risks silently submitting a wrong
 * DOB. Caller should treat a DOB-fill failure as expected until that gap is
 * closed with a follow-up supervised exploration pass.
 */
export async function fillTravellerDetails(page: Page, passenger: HarnessPassenger): Promise<void> {
  const s = LASTMINUTE_SELECTORS.traveller1;
  await page.locator(s.firstName).first().fill(passenger.given_name);
  await page.locator(s.lastName).first().fill(passenger.family_name);
  const titleSelector = passenger.title === "mr" ? s.titleRadioMale : s.titleRadioFemale;
  // Radix renders the actual <input> visually hidden behind a styled label — force bypasses the visibility check rather than clicking a fragile sibling element.
  await page.locator(titleSelector).first().check({ force: true }).catch(() => {});
}

export type TotalVerificationResult =
  | { ok: true; displayed_amount: number }
  | { ok: false; reason: string; displayed_amount?: number };

const AMOUNT_PATTERN = /[£$€]\s?([\d,]+\.\d{2})/;

/**
 * MANDATORY gate: reads the total price currently displayed on the page and
 * compares it to the Prava session's authorized cap. Never proceeds toward
 * payment on a total that has drifted beyond tolerance — abort and re-quote
 * instead, per docs/lastminute-prava-integration.md §2 row 4.
 */
export async function verifyDisplayedTotal(
  page: Page,
  totalCheck: HarnessTotalCheck,
): Promise<TotalVerificationResult> {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const totalLabelIndex = bodyText.indexOf("Total price");
  const searchWindow = totalLabelIndex >= 0 ? bodyText.slice(totalLabelIndex, totalLabelIndex + 60) : bodyText;
  const match = searchWindow.match(AMOUNT_PATTERN);
  if (!match) {
    return { ok: false, reason: "Could not find a displayed total price on the page" };
  }
  const displayed = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(displayed)) {
    return { ok: false, reason: `Displayed total "${match[0]}" did not parse as a number` };
  }
  if (displayed > totalCheck.authorized_cap + totalCheck.tolerance) {
    return {
      ok: false,
      reason: `Displayed total ${displayed} ${totalCheck.currency} exceeds authorized cap ${totalCheck.authorized_cap} + tolerance ${totalCheck.tolerance}`,
      displayed_amount: displayed,
    };
  }
  return { ok: true, displayed_amount: displayed };
}
