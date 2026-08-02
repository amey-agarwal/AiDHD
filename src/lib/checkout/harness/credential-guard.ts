/**
 * Runtime enforcement of the harness's hard rule: card number, CVV, and
 * expiry must never be placed in an LLM prompt. Every AI-assisted call
 * (Stagehand's act()/extract(), a Yutori Navigator step, etc.) must go
 * through guard(...) first — it throws before the string ever leaves this
 * process if it contains a live credential value.
 *
 * This is a runtime backstop, not a substitute for keeping AI calls scoped
 * to navigation/cookie-banner/passenger-detail steps only (see
 * harness/types.ts and the Playwright/Stagehand implementations) — payment
 * fields should never call through here at all, deterministic
 * page.fill/page.locator only.
 */

import type { HarnessCredentials } from "./types";

export class CredentialLeakError extends Error {
  constructor(message = "Refused: a payment credential value was about to be passed into an AI-assisted call") {
    super(message);
    this.name = "CredentialLeakError";
  }
}

export type CredentialGuard = (...values: unknown[]) => void;

/** Secrets shorter than this are ignored (avoids false positives on e.g. a 2-digit month matching by coincidence). */
const MIN_SECRET_LENGTH = 3;

export function createCredentialGuard(credentials: HarnessCredentials): CredentialGuard {
  const secrets = [
    credentials.token,
    credentials.token?.replace(/\s/g, ""),
    credentials.dynamic_cvv,
    `${credentials.expiry_month}/${credentials.expiry_year}`,
    `${credentials.expiry_month}${credentials.expiry_year}`,
  ].filter((s): s is string => Boolean(s) && s.length >= MIN_SECRET_LENGTH);

  return function assertSafe(...values: unknown[]) {
    for (const value of values) {
      const str = typeof value === "string" ? value : safeStringify(value);
      if (!str) continue;
      for (const secret of secrets) {
        if (str.includes(secret)) {
          throw new CredentialLeakError();
        }
      }
    }
  };
}

function safeStringify(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Wraps an AI-assisted call (Stagehand act/extract, Yutori Navigator step, ...) so it can never carry a credential. */
export async function guardedAiCall<T>(
  guard: CredentialGuard,
  instructionOrPayload: unknown,
  run: () => Promise<T>,
): Promise<T> {
  guard(instructionOrPayload);
  return run();
}
