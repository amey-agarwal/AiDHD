import { createCredentialGuard, guardedAiCall } from "./credential-guard";
import {
  fillAddressDetails,
  fillContactDetails,
  fillTravellerDetails,
  verifyDisplayedTotal,
} from "./checkout-steps";
import { LASTMINUTE_SELECTORS } from "./lastminute-selectors";
import { runStep, type StepFailure } from "./step-runner";
import type { CheckoutHarness, CheckoutHarnessInput, HarnessStepEvent, Receipt } from "./types";
import { logBookingEvent } from "../debug-log";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
type FailureStage = Extract<Receipt, { ok: false }>["stage"];

/**
 * AI-assisted variant — identical to PlaywrightHarness except the
 * cookie-banner dismissal and fare-review "Continue" click go through
 * Stagehand's act() (useful when copy/layout drifts from the frozen
 * selector pack) instead of a fixed selector. Every act() call is routed
 * through guardedAiCall so it's structurally impossible for this file to
 * hand a credential string to Stagehand's model — see credential-guard.ts.
 *
 * Form fills, total verification, and the payment-step stop are byte-for-
 * byte the same deterministic functions PlaywrightHarness uses
 * (checkout-steps.ts), operating on stagehand.context.pages()[0], which is
 * a real Playwright Page — Stagehand never touches those steps.
 *
 * API surface verified against docs.stagehand.dev/v3 (2026-08-02):
 * `new Stagehand({ env: "BROWSERBASE" })`, `await stagehand.init()`,
 * `stagehand.context.pages()[0]`, `await stagehand.act(instruction, opts)`.
 * NOT smoke-tested live in this environment — run one real session before
 * trusting this against an actual booking.
 */
export class StagehandHarness implements CheckoutHarness {
  async complete(input: CheckoutHarnessInput): Promise<Receipt> {
    const { booking_id } = input;
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const steps: HarnessStepEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    const guard = createCredentialGuard(input.credentials);

    const { Stagehand } = await import("@browserbasehq/stagehand");
    const stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();
    // Stagehand v3 ships its own lightweight "understudy" Page type (CDP-backed),
    // structurally narrower than playwright-core's Page in its .d.ts — confirmed
    // via `tsc`, not a guess. It's commonly treated as runtime-compatible with
    // real Playwright page methods (fill/locator/evaluate/screenshot, all used
    // below), but that is UNVERIFIED here — no live Stagehand session was run in
    // this environment. Smoke-test this cast against a real Browserbase session
    // before trusting StagehandHarness for anything beyond the AI-assisted
    // cookie-banner/continue-button steps it was written for.
    const page = stagehand.context.pages()[0] as unknown as import("playwright").Page;

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

      const cookieInstruction = "if a cookie consent banner is visible, accept/dismiss it; otherwise do nothing";
      try {
        const { event } = await runStep(page, booking_id, "cookie_banner", cookieInstruction, () =>
          guardedAiCall(guard, cookieInstruction, () => stagehand.act(cookieInstruction)),
        );
        record(event);
      } catch (e) {
        // Best-effort — a missing/unclickable cookie banner isn't fatal.
        record(errorToStep(e));
      }

      const continueInstruction = 'click the "Continue" button to proceed past the fare review, if this page has one';
      const { event: continueEvent } = await runStep(page, booking_id, "fare_review", continueInstruction, () =>
        guardedAiCall(guard, continueInstruction, () => stagehand.act(continueInstruction)).catch(() => null),
      );
      record(continueEvent);
      await page.waitForTimeout(2000);

      try {
        const { event } = await runStep(page, booking_id, "contact_details", "fill contact + address fields (deterministic)", async () => {
          await fillContactDetails(page, input.passenger);
          await fillAddressDetails(page, input.passenger);
        });
        record(event);
      } catch (e) {
        record(errorToStep(e));
        return fail("contact_details", e instanceof Error ? e.message : "Filling contact details failed");
      }

      try {
        const { event } = await runStep(
          page,
          booking_id,
          "traveller_details",
          "fill primary traveller name/surname/title (deterministic)",
          () => fillTravellerDetails(page, input.passenger),
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
        "read displayed total and compare to authorized cap (deterministic)",
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

      if (!LASTMINUTE_SELECTORS.payment) {
        logBookingEvent({
          booking_id,
          stage: "payment_fields",
          event: "stopping before payment — selector pack not yet verified for Step 3/4",
          level: "warn",
        });
        return fail(
          "payment_fields",
          "Payment-step selectors are not yet verified — see lastminute-selectors.ts. Deliberately stopping rather than letting an AI-driven act() anywhere near a payment field.",
          true,
        );
      }

      return fail("payment_fields", "Payment step not implemented", true);
    } finally {
      await stagehand.close().catch(() => {});
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
