/**
 * lastminute.com checkout selector pack.
 *
 * Captured 2026-08-02 via a one-time, read-only Playwright exploration of a
 * real cart at secure.lastminute.com/hdp/checkout/carts/<id> (reached from a
 * live search_flights deeplink, LON→PAR). Only fake placeholder data was
 * typed in ("Test Traveler" / example.com email) — nothing was submitted,
 * and payment fields were never reached. See
 * docs/lastminute-prava-integration.md §"Not yet built" for status.
 *
 * The checkout is a 5-step React/Radix UI stepper: Search → Details and
 * Luggage → Flexibility & Security → Review and Pay → Done. A ~30 minute
 * countdown ("Time remaining: 29:44") holds the fare — the whole harness run
 * must fit inside that window.
 *
 * Radix generates a fresh `id` (e.g. "radix-:r9:") per render — NEVER stable
 * across sessions. Every selector below is scoped by `name` or
 * `data-testid` instead, both of which come from the form's schema and were
 * stable across two separate live runs.
 */

export const LASTMINUTE_SELECTORS = {
  cookieBanner: {
    // Multiple candidate texts observed/plausible across locales — try in order, first match wins.
    acceptCandidates: [
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      "#onetrust-accept-btn-handler",
    ],
  },
  fareReview: {
    /** Step 1→2 transition, off the fare review page. */
    continue: '[data-testid="lmn-ds-btn"]:has-text("Continue")',
  },
  contact: {
    firstName: 'input[name="name"]',
    lastName: 'input[name="surname"]',
    email: 'input[name="email"]',
    phone: 'input[name="phone"]',
  },
  address: {
    line1: 'input[name="address"]',
    houseNumber: 'input[name="houseNumber"]',
    postCode: 'input[name="postCode"]',
    city: 'input[name="city"]',
  },
  traveller1: {
    /** Visually-hidden custom radio (Radix) — click the parent label, or `.check({ force: true })`; a bare `.click()` times out on the "not visible" check. */
    titleRadioMale: 'input[name="groups.1.travellers.1.title"][value="MALE"]',
    titleRadioFemale: 'input[name="groups.1.travellers.1.title"][value="FEMALE"]',
    firstName: 'input[name="groups.1.travellers.1.name"]',
    lastName: 'input[name="groups.1.travellers.1.surname"]',
    /**
     * Segmented DOB: two <input type="tel"> sharing name
     * "groups.1.travellers.1.dateOfBirth" (day, year) with one <select
     * data-testid="select-field-input"> (month) between them, under a
     * container whose text reads "Date of birth / Day / Month / Month / Year".
     * Exact nth()/select-option scoping was NOT pinned down in the one
     * exploration pass — verify with `.nth(0)` = day, dropdown = month,
     * `.nth(1)` = year before relying on this in the harness.
     */
    dobDayYearInputs: 'input[name="groups.1.travellers.1.dateOfBirth"]',
    dobMonthSelect: '[data-testid="select-field-input"]',
  },
  /**
   * UNVERIFIED — Step 3 "Flexibility & Security" (ancillary upsells: seats,
   * bags, insurance) and Step 4 "Review and Pay" (the actual payment form)
   * were deliberately not explored. Reaching them means progressing further
   * into a real, live, money-bearing cart, and the payment form is the
   * single highest-stakes unknown in this whole integration — very likely a
   * PCI-scoped iframe from a third-party provider (Adyen/Checkout.com/
   * Braintree are common for large EU OTAs), which would mean
   * `page.frameLocator(...)`, not `page.locator(...)` — same shape as this
   * repo's existing Duffel harness (duffel-checkout-bot.ts).
   *
   * DO NOT fill this in by guessing. It needs one more supervised
   * exploration pass — ideally with a human watching, given how close it is
   * to a real payment surface — using the same fake-data-only, no-submit
   * method as the pass that produced everything above.
   */
  payment: null as null | {
    iframeSelector: string;
    cardNumber: string;
    expiry: string;
    cvc: string;
    submit: string;
    confirmationBookingRef: string;
    threeDsChallengeIndicator: string;
  },
};
