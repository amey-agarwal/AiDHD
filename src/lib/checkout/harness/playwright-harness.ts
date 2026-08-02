import { resolveBrowserSession } from "./browser-session";
import {
  clickFareReviewContinueIfPresent,
  dismissCookieBanner,
  fillAddressDetails,
  fillContactDetails,
  fillTravellerDetails,
  verifyDisplayedTotal,
} from "./checkout-steps";
import { LASTMINUTE_SELECTORS } from "./lastminute-selectors";
import { runStep, type StepFailure } from "./step-runner";
import type { CheckoutHarness, CheckoutHarnessInput, HarnessStepEvent, Receipt } from "./types";
import { logBookingEvent } from "../debug-log";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // fare holds observed at ~30 min — leave margin
type FailureStage = Extract<Receipt, { ok: false }>["stage"];

/**
 * Deterministic implementation — no AI/act()/extract() anywhere in this
 * file. Every field fill uses page.fill/page.locator against the verified
 * selector pack (lastminute-selectors.ts). This is the primary
 * CheckoutHarness; StagehandHarness (stagehand-harness.ts) only differs in
 * how the cookie-banner/navigation steps are done.
 *
 * Stops cleanly, before touching any payment field, once
 * LASTMINUTE_SELECTORS.payment is filled in with a verified pack — see that
 * file's header for why it's still null.
 */
export class PlaywrightHarness implements CheckoutHarness {
  async complete(input: CheckoutHarnessInput): Promise<Receipt> {
    const { booking_id } = input;
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const steps: HarnessStepEvent[] = [];
    const deadline = Date.now() + timeoutMs;

    const session = await resolveBrowserSession();
    const context = await session.browser.newContext(); // fresh, isolated — no persisted storage
    const page = await context.newPage();

    const record = (e: HarnessStepEvent) => steps.push(e);
    const fail = (stage: FailureStage, reason: string, requires_human = false): Receipt => ({
      ok: false,
      failure_reason: reason,
      stage,
      requires_human,
      steps,
    });

    try {
      if (Date.now() > deadline) return fail("timeout", "Harness run exceeded its wall-clock budget before starting");

      try {
        const { event } = await runStep(page, booking_id, "navigation", `goto ${input.checkout_url}`, () =>
          page.goto(input.checkout_url, { waitUntil: "domcontentloaded", timeout: 30_000 }),
        );
        record(event);
      } catch (e) {
        record(errorToStep(e));
        return fail("navigation", e instanceof Error ? e.message : "Navigation failed");
      }

      const { event: cookieEvent } = await runStep(page, booking_id, "cookie_banner", "dismiss cookie banner if present", () =>
        dismissCookieBanner(page),
      );
      record(cookieEvent);

      const { event: continueEvent } = await runStep(
        page,
        booking_id,
        "fare_review",
        `click ${LASTMINUTE_SELECTORS.fareReview.continue} if present`,
        () => clickFareReviewContinueIfPresent(page),
      );
      record(continueEvent);
      await page.waitForTimeout(2000);

      try {
        const { event } = await runStep(page, booking_id, "contact_details", "fill contact + address fields", async () => {
          await fillContactDetails(page, input.passenger);
          await fillAddressDetails(page, input.passenger);
        });
        record(event);
      } catch (e) {
        record(errorToStep(e));
        return fail("contact_details", e instanceof Error ? e.message : "Filling contact details failed");
      }

      try {
        const { event } = await runStep(page, booking_id, "traveller_details", "fill primary traveller name/surname/title", () =>
          fillTravellerDetails(page, input.passenger),
        );
        record(event);
      } catch (e) {
        record(errorToStep(e));
        return fail("traveller_details", e instanceof Error ? e.message : "Filling traveller details failed");
      }

      const { result: totalResult, event: totalEvent } = await runStep(
        page,
        booking_id,
        "total_verification",
        "read displayed total and compare to authorized cap",
        () => verifyDisplayedTotal(page, input.total_check),
      );
      record(totalEvent);
      logBookingEvent({
        booking_id,
        stage: "total_verification",
        event: "verification result",
        data: {
          authorized_cap: input.total_check.authorized_cap,
          tolerance: input.total_check.tolerance,
          result: totalResult,
        },
      });
      if (!totalResult.ok) {
        return fail("total_verification", totalResult.reason, false);
      }

      if (Date.now() > deadline) return fail("timeout", "Harness run exceeded its wall-clock budget mid-flow");

      // --- Payment step is intentionally not implemented yet ---
      // LASTMINUTE_SELECTORS.payment is null until a supervised exploration
      // pass verifies Step 3 (ancillaries) and Step 4 (the real payment
      // form, very likely a PCI-scoped third-party iframe). Failing clean
      // here rather than guessing selectors against a live payment surface.
      if (!LASTMINUTE_SELECTORS.payment) {
        logBookingEvent({
          booking_id,
          stage: "payment_fields",
          event: "stopping before payment — selector pack not yet verified for Step 3/4",
          level: "warn",
        });
        return fail(
          "payment_fields",
          "Payment-step selectors are not yet verified (see lastminute-selectors.ts) — the harness deliberately stops here rather than guessing against a live payment surface.",
          true,
        );
      }

      // Reachable once LASTMINUTE_SELECTORS.payment is filled in.
      return fail("payment_fields", "Payment step not implemented", true);
    } finally {
      await context.close().catch(() => {});
      await session.browser.close().catch(() => {});
      await session.cleanup().catch(() => {});
    }
  }
}

function errorToStep(e: unknown): HarnessStepEvent {
  const err = e as Partial<StepFailure>;
  return {
    name: err.stage || "unknown",
    instruction: err.instruction || "unknown",
    outcome: "error",
    duration_ms: err.duration_ms ?? 0,
    screenshot_base64: err.screenshot_base64,
    error: err.message,
  };
}
