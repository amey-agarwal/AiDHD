# lastminute.com + Prava Payments — verified integration plan

Status: **research complete (STEP 1/2), no code written yet.** Waiting on go-ahead.

This document supersedes the original task brief's assumptions about the lastminute.com
integration (which assumed a private partner/XML account) and about Duffel (excluded per
explicit instruction — the existing `duffel-checkout*.ts` files are untouched and out of
scope). Everything below was verified live against docs.prava.space, lastminute.com's
public pages, and lastminute's MCP server — nothing here is guessed.

---

## 1. What "direct checkout link" actually is — CORRECTED

The brief assumed one of: a prefilled-cart URL tied to a created order, an affiliate
deeplink, or a whitelabel handoff. Verified answer: **it's an affiliate/cobranded
metasearch deeplink — there is no order-creation step at all.**

lastminute.com runs a public, unauthenticated MCP server at `mcp.lastminute.com/mcp`
(`serverInfo.name = "MCP_FLIGHT_HDP"`, v2.13.0.2) — same shape as this repo's existing
`maqami.ts` MCP integration, no API key required. Confirmed live by calling it:

- `search_flights` and `search_flight_and_hotel_package` return, per result, a `deeplink`
  such as:
  `https://www.lastminute.com/msr/route/searching.do?departureAirport=LON&arrivalAirport=PAR&outboundDay=16&outboundMonthYear=082026&adults=1&...&COBRANDED=LMNUK_LLMPROJECTUK&currency=GBP&...&autoclick=true&j=82201&jC=82201_GBP&cp=0`
- For hotel/package flows there's a `generate_booking_link` tool with the same shape,
  called after `select_hotel_options`.
- **No `create_order`, `confirm_booking`, or any tool that returns an order ID exists**
  in the tool list (`tools/list` returned 8 tools total: `search_flight_and_hotel_package`,
  `search_only_hotel`, `select_hotel_options`, `get_alternative_flights`, `change_flight`,
  `generate_booking_link`, `resolve_destination_id`, `search_flights`).

The `COBRANDED=LMNUK_LLMPROJECTUK` / `utm_source=LMNUK_LLMPROJECTUK` tag indicates
lastminute built this MCP server specifically to be called by AI agents — but it's a
generic public cobrand, **not an account of ours**, and the deeplink is a live,
production, real-money lastminute.com URL. `autoclick=true` plus the `j`/`jC` price
tokens auto-select the specific fare on landing; from there checkout proceeds entirely
inside lastminute's own consumer flow (passenger details, then payment).

**Practical consequence:** the pipeline is `MCP search → deeplink → browser harness drives
lastminute's own live checkout page end-to-end (passenger form + payment)`. There is no
API step where we "create" anything on lastminute's side before the browser runs.

### Partner/legal channel — checked, nothing more formal exists
- `/help/partners` → hotel-supply partner onboarding only ("become a partner *hotel*").
- `/en/partnerships` → bespoke co-brand/loyalty deals, contact-sales, not technical.
- `/help/affiliates` → standard AWIN/CJ CPA marketing-link programme (banners, deep-link
  creator) — commission-per-booking for referring a human, not an automated-checkout
  agreement.

**No XML API, no whitelabel program, no formal automated-booking partner agreement is
discoverable.** Per your note, the hackathon organizers suggested lastminute.com for this
integration, which addresses "is this an endorsed target" — but it does **not** change the
fact that every automated run hits live production infrastructure with no sandbox. Keep
runs to test-scale amounts and stop before the final payment submit until you explicitly
say to let one complete.

---

## 2. Prava assumptions — verified against docs.prava.space

| # | Original assumption | Verdict |
|---|---|---|
| 1 | Prava's own Browser Harness is Shopify/UCP-only, Travel "coming soon" | **CORRECTED, more restrictive than assumed.** The harness docs (`integration/browser-harness.md`) mention **only Shopify** — no "Travel coming soon" language at all, no OTA mention whatsoever. It "fills the merchant's checkout (contact, shipping address, delivery option) and submits payment with the one-time token" — that's the Shopify field set, not a travel/passenger field set. **We must build our own harness — confirmed, but for a stronger reason than expected.** Separately, `integration/travel.md` *does* say travel-specific dedicated tooling is "coming soon," but also: *"Agents can already pay travel merchants that accept standard card checkout using a payment session for a known total."* — i.e. the generic session→iframe→token→report-status flow (already implemented in `prava.ts`) is explicitly sanctioned for travel merchants today. |
| 2 | `iframe_url` is the user's card-collection+passkey surface, never automated | **CONFIRMED.** `concepts/checkout-flow.md`: "open iframe_url (hosted) / mount collectPAN (embedded)" is step 2 of 5, cardholder-facing only. Backend never navigates it. |
| 3 | `purchase_context.merchant_details` = lastminute.com, not our app; currency EUR/GBP | **CONFIRMED**, schema verified: `merchant_details.name` (required, Visa-safe sanitized display name), `.url` (required, HTTPS), `.country_code_iso2` (required), plus optional `.category_code` (MCC) / `.category`. It identifies "the destination merchant... not your platform." Supported currency list (ISO 4217) includes both **EUR and GBP** among ~48 currencies (also USD, CAD, AUD, CHF, etc.) — confirmed exact list in the fetched doc. |
| 4 | `total_amount` is the authorized cap; need a recovery path for checkout-total drift | **CONFIRMED as hard cap**, doc: "this value becomes the authorized amount cap." **Recovery path is NOT documented for travel specifically** — Prava's travel page defers this to `support@prava.space`. What *is* documented (mandate cap enforcement: "an over-cap charge is declined... no fallback or partial authorization") tells us attempting the one-time token against a higher total would just fail at the network and burn the single-use credential. **Our design decision** (not a Prava recommendation, since none exists): read the final payable total on lastminute's page before submitting payment; if it exceeds `total_amount` + tolerance, abort without spending the token and open a **new session** with the corrected total (re-quote), never attempt-then-hope. This matches the brief's own "MANDATORY total verification" requirement. |
| 5 (new) | PSD2/SCA — is the network token frictionless or does it need human-in-the-loop? | **Partially confirmed, partially still open — flagging prominently per your instruction.** Prava's own flow embeds SCA *at tokenization*: step 2 of checkout-flow.md — new device gets issuer OTP ("the same 3-D Secure–style step-up your bank does when it texts you a code") then passkey registration; returning device gets one biometric prompt. Docs state this satisfies SCA. **What is NOT documented:** whether the resulting one-time network token is subsequently exempt from a *second*, merchant-side 3DS challenge when lastminute's own checkout page submits the transaction. Network-tokenized, already-SCA'd credentials commonly do get frictionless/exemption treatment at the acquirer level, but Prava's docs don't state this explicitly for this token. **Design for both outcomes**, as originally instructed: harness must detect a 3DS/OTP interstitial on lastminute's checkout page itself and pause for human-in-the-loop rather than guess or blindly retry. |

### Test cards / sandbox (verified, `api-reference/test-cards.md` + `testing.md`)
- 11 sandbox Visa numbers, common prefix `4622 9431 2313`, each with its own CVV, all
  expiring `12/27`. Only valid on `sandbox.api.prava.space` / `sandbox.collect.prava.space`
  — declined anywhere else.
- Test OTP: `456789`.
- Sessions expire after 15 minutes (sandbox matches production).
- Documented flow: create session (`sk_test_*`) → open iframe, enter test card → passkey
  step → poll `get-payment-result` until it exposes `token`/`dynamic_cvv` → `report-status`
  with `APPROVED`/`DECLINED` → result becomes `completed`/`failed`. No documented polling
  interval/backoff — we set our own (existing `prava.ts` doesn't currently retry/backoff on
  `awaiting_result`; that's a gap to close in the typed client).

### Error codes (verified, `api-reference/errors.md`) — full table pulled into the client
Grouped by endpoint: session auth (`AUTH_1001-1004`), session create (`TRIES_EXHAUSTED`,
`MERCHANT_LOOKUP_ERROR`, `CONFIG_ERROR`, `CARD_NOT_FOUND`, `CARD_INACTIVE`,
`SESSION_CREATE_ERROR`), payment-result (`NOT_FOUND`), report-status (`NOT_FOUND`,
`INVALID_STATE`, `MANDATE_EXPIRED`, `PRODUCT_NOT_FOUND`, `VISA_CONFIRMATION_FAILED`,
`REPORT_STATUS_ERROR`), cards (`CUSTOMER_NOT_FOUND`, `NETWORK_DELETE_FAILED`), revoke
(`NOT_FOUND`, `INVALID_STATE`), mandates (`AUTH_REQUIRED`, `MANDATE_FORBIDDEN`,
`MANDATE_MERCHANT_NOT_ALLOWED`, `MANDATE_NOT_FOUND`, `MANDATE_NOT_ACTIVE`,
`MANDATE_INVALID_TRANSITION`, `NO_INSTRUCTION`/`NO_ORDER`, `NO_TOKEN`,
`CHARGE_NOT_FOUND`, `CHARGE_NOT_REPORTABLE`/`CHARGE_NO_TLI`,
`MANDATE_CHARGE_REPORT_DB_FAILED`). Plus `THRESHOLD_EXCEEDED` — a Visa-level decline (over
cap), surfaced in a failed charge's `errorCode`, not the Prava error envelope.

The existing `prava.ts` handles the happy path and a couple of failure strings loosely
(`data.message || data.error || data.detail`) but has **no typed switch over these specific
codes** — that's real work for deliverable #2, not something already done.

---

## 3. Verified end-to-end call sequence

```
1. MCP search_flights (mcp.lastminute.com, no auth)      → candidate fares + deeplink
2. [user/agent selects a fare]
3. POST /v1/sessions (Prava, sk_*)                         → session_id, iframe_url, expires_at
     purchase_context.merchant_details = { name: "lastminute.com", url: "https://www.lastminute.com", country_code_iso2: <derived from deeplink market, e.g. "GB"> }
     total_amount = quoted fare total (decimal string), currency = quoted currency (GBP/EUR/...)
4. Frontend opens iframe_url                                → user passkey/OTP approval (Prava-hosted, never automated)
5. Poll GET /v1/sessions/:id/payment-result                 → status → token, dynamic_cvv, expiry once ready
6. CheckoutHarness.complete(deeplink, {token, dynamic_cvv, expiry}, passenger)
     - browser navigates deeplink (autoclick lands on the priced fare)
     - AI-assisted (act/extract) ONLY for: cookie banner, navigation, passenger-detail form
     - deterministic Playwright locators ONLY for: card number ← token, CVV ← dynamic_cvv, expiry
     - MANDATORY: read displayed total on lastminute's page; abort (no submit) if it exceeds
       total_amount + tolerance → go re-quote a new session instead of submitting
     - detect 3DS/OTP interstitial on lastminute's page → pause, surface to human, do not guess
     - capture booking reference / confirmation on success
7. POST /v1/sessions/:id/report-status  (APPROVED | DECLINED) → mandatory regardless of harness outcome
```

---

## 4. Browser automation platforms — verified capabilities (keys now present in `.env.local`)

Checked current SDK surfaces directly rather than assuming all three platforms are
interchangeable — they are **not**, and that matters for where the "never let credentials
reach an LLM prompt" rule can actually be enforced.

| Platform | Access model | Usable for the **payment-typing step**? |
|---|---|---|
| **Browserbase + Stagehand** (`@browserbasehq/stagehand` 3.7.1, `@browserbasehq/sdk` 2.16.0) | Real remote Chromium session; `act()`/`extract()` are opt-in per call, deterministic `page.fill`/`page.locator` fully available in the same session. | **Yes.** This is the primary harness target — same pattern the repo already uses for Duffel's card iframe, just pointed at lastminute's page instead. |
| **browser-use Cloud** (`browser-use-sdk`, API v3, key prefix `bu_`) | **Two distinct modes.** (a) Agent-based: natural-language task, fully hosted, no field-level control. (b) **Raw CDP**: get a WebSocket CDP URL, connect with Playwright/Puppeteer yourself, drive it with deterministic commands. Also has a "Secrets" mechanism (domain-scoped credential autofill where "the agent never sees your actual credentials"). | **Mode (b) only** — CDP mode gives us the same low-level control as Browserbase, so it's a legitimate fallback for the harness. **Mode (a) must never touch payment fields** — full task delegation means we can't guarantee the card token/CVV stay out of their model's loop. |
| **Yutori** (Navigator n1.5 API + separate Browsing API, `docs.yutori.com`) | **Navigator**: caller runs their own browser, calls Navigator per-step with a screenshot, gets back one predicted action, executes it themselves — interleaving with our own deterministic actions in the same session is explicitly supported. **Browsing API**: fully hosted, Yutori runs and controls the browser end-to-end (task delegation), no field-level access documented. | **Navigator only**, and only for nav/cookie-banner/passenger-detail steps, same rule as Stagehand's `act()`. **Browsing API is exploration-only** (same role the brief already carved out for browser-use's dev-only exploration mode), never the payment path. |

**Resulting architecture:** `CheckoutHarness` implementations run on a real Playwright/CDP
session (Browserbase primary, browser-use CDP mode as fallback) that *we* fully control.
Stagehand's `act()`/`extract()` and/or Yutori Navigator are optional per-step helpers for
nav/cookie-banner/passenger-detail steps only, gated by the same wrapper that refuses to
pass credential strings into any AI call. Payment fields always go through
`page.fill`/`page.locator`, full stop, regardless of which platform is driving the session.
browser-use's Agent mode and Yutori's Browsing API are reserved for the STEP 3 "dev-only,
explore lastminute checkout once, freeze a selector pack" role — never in the live payment
path.

**Gap:** `.env.local` has `BROWSERBASE_API_KEY` but no `BROWSERBASE_PROJECT_ID`, which
Browserbase session creation typically also requires — flagging so you can add it before
we wire this up, rather than guessing a default.

---

## 5. Highest risk, unchanged from the brief, now sharpened

1. **No sandbox exists on lastminute's side.** Every harness run — even a "test" one —
   hits live production lastminute.com. There is no test-mode deeplink. This is the
   single biggest departure from the Prava side (which has a full sandbox). Any code we
   write must stop before the final payment submission until you explicitly authorize a
   real run, and even then should be capped to a trivial/cancellable fare.
2. **3DS on lastminute's own checkout page is unverified** (see §2 row 5). Must build the
   pause-and-surface path regardless of how likely frictionless success is.
3. **No formal automated-checkout agreement with lastminute** — organizer endorsement
   covers "is this an OK thing to build for the hackathon," not "does lastminute's ToS
   contemplate this." Worth a one-line acknowledgment in the demo/README, not a blocker.

---

## 6. Open questions (would go to lastminute if we had an account contact — we don't)
- Whether the MCP server's deeplinks are rate-limited or fingerprint-gated for repeated
  automated access (we didn't stress-test this).
- Whether `country_code_iso2` for `merchant_details` should vary by the deeplink's market
  cobrand (`LMNUK` implies UK) or stay fixed — defaulting to the market implied by the
  cobrand tag unless told otherwise.
- Confirmed no XML/affiliate technical docs exist beyond the consumer affiliate program —
  if you have an existing lastminute business relationship beyond what the organizers
  pointed at, that would change this section.

---

## 7. Not yet built (waiting on go-ahead per your working method)
Everything in STEP 5 deliverables 2–8 of the original brief: typed Prava client with the
error table above, lastminute MCP client, booking orchestrator with the total-verification
gate, `CheckoutHarness` + Stagehand/browser-use/Yutori-assisted implementations, the
debug-logs module, `.env.example` additions, and tests. None of it is written yet.
