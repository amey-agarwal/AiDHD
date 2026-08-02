import type { Page } from "playwright";
import { logBookingEvent } from "../debug-log";
import type { HarnessStepEvent } from "./types";

/** What a failed runStep() throws — carries enough to build a HarnessStepEvent at the catch site. */
export type StepFailure = Error & {
  stage: string;
  instruction: string;
  duration_ms: number;
  screenshot_base64?: string;
};

/** Small (viewport-cropped, low quality) screenshot — kept cheap since one is taken per step. */
async function captureScreenshot(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 40, fullPage: false, timeout: 5000 });
    return buf.toString("base64");
  } catch {
    return undefined;
  }
}

/**
 * Runs one harness step, logging a booking_id-correlated event (name,
 * instruction/selector text, duration, outcome, screenshot) regardless of
 * success or failure — never logs the credential values themselves, only
 * step metadata. `instruction` must be a selector string or a plain-English
 * act() instruction, never a credential — see credential-guard.ts for the
 * AI-call-specific enforcement of that rule.
 */
export async function runStep<T>(
  page: Page,
  bookingId: string,
  stage: string,
  instruction: string,
  fn: () => Promise<T>,
): Promise<{ result: T; event: HarnessStepEvent }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - start;
    const screenshot_base64 = await captureScreenshot(page);
    logBookingEvent({
      booking_id: bookingId,
      stage,
      event: `step ok: ${instruction}`,
      duration_ms,
      screenshot_base64,
    });
    return { result, event: { name: stage, instruction, outcome: "ok", duration_ms, screenshot_base64 } };
  } catch (e) {
    const duration_ms = Date.now() - start;
    const error = e instanceof Error ? e.message : "unknown error";
    const screenshot_base64 = await captureScreenshot(page);
    logBookingEvent({
      booking_id: bookingId,
      stage,
      event: `step failed: ${instruction}`,
      level: "error",
      duration_ms,
      data: { error },
      screenshot_base64,
    });
    throw Object.assign(new Error(error), { stage, instruction, duration_ms, screenshot_base64 }) as StepFailure;
  }
}
