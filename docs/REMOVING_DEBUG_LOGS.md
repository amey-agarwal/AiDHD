# Removing the debug-logs scaffolding

The STEP 4 task brief asked for a fully separate, trivially-deletable
`src/debug-logs/` module. That's not what this ended up as: this repo
already had a working debug console (`src/lib/checkout/debug-log.ts`,
`src/app/api/checkout/debug-stream/route.ts`, `src/app/debug/page.tsx`)
covering the pre-existing Duffel/Prava flow before this integration started.
Building a second, parallel logging system next to it would mean two
inconsistent debug UIs for the same checkout pipeline — so this integration
extended the existing one instead: `booking_id`/`stage`/`level` fields,
`logBookingEvent()`, screenshot support, gating, and a hardened central
`scrubSecrets()` were added to the same files, and lastminute/harness code
logs through them.

Practical effect: **you can't delete "just the lastminute debug logging"
without touching files the Duffel flow also depends on.** Pick one:

## Option A — remove the debug console entirely (Duffel's too)

1. Delete `src/lib/checkout/debug-log.ts`.
2. Delete `src/app/api/checkout/debug-stream/route.ts`.
3. Delete `src/app/debug/page.tsx` (and the directory if empty).
4. Delete `src/lib/checkout/debug-log.test.ts`.
5. Remove every `import { log... } from "../checkout/debug-log"` /
   `"@/lib/checkout/debug-log"` and the calls that use it — grep:
   `grep -rl "checkout/debug-log" src`. Current call sites: `prava.ts`,
   `duffel-payment.ts`, `poll-payment-result.ts`, `lastminute.ts`,
   `lastminute-booking.ts`, `harness/step-runner.ts`,
   `harness/browser-session.ts`, `app/api/checkout/execute/route.ts`.
6. Remove `DEBUG_LOGS_ENABLED` / `DEBUG_LOGS_TOKEN` from `.env.example` and
   your `.env.local`.

This is a bigger diff than the original brief implied, but it's the only
way to get to zero debug-logging code.

## Option B — keep Duffel's debug console, drop only the lastminute additions

Lower-risk, smaller diff — reverts `debug-log.ts` to its pre-integration
shape and stops sending lastminute/harness events into it, but keeps the
`/debug` console working for the Duffel flow exactly as it did before.

1. In `src/lib/checkout/debug-log.ts`, remove: `logBookingEvent`,
   `getBookingLogHistory`, the `booking_id`/`stage`/`level`/`duration_ms`/
   `screenshot_base64` fields on `DebugLogEntry`, and `scrubSecrets` (revert
   `publish()` to call `redactCard`/`redactPaymentResult` at call sites the
   way it did originally, or keep `scrubSecrets` — it's strictly safer and
   has no lastminute-specific behavior, so keeping it is fine even under
   this option).
2. Revert `src/app/api/checkout/debug-stream/route.ts`'s gating
   (`isAuthorized`) if you want the console open again — or keep the
   gating, since it's a strict improvement over the original's
   documented "no auth" posture regardless of which merchant it's tracing.
3. Revert `src/app/debug/page.tsx` to the single-EventSource, no-token,
   no-filter version (`git log` has the pre-integration version).
4. Delete `src/lib/checkout/harness/`, `src/lib/integrations/lastminute.ts`,
   `src/lib/checkout/lastminute-booking.ts`,
   `src/app/api/lastminute/`, and `src/lib/checkout/debug-log.test.ts`'s
   lastminute-specific assertions (the PAN/CVV/sk_*/JWT scrubbing tests are
   general-purpose and worth keeping regardless).

## Either way

- `DEBUG_LOGS_ENABLED` defaults to unset/false — nothing new is exposed
  until you explicitly turn it on.
- No logs are shipped to any third-party service; they only ever live in
  the in-memory bus (`getBus()` in `debug-log.ts`), which is cleared on
  process restart. There is no persistence to purge.
