import { timingSafeEqual } from "crypto";
import { getDebugLogHistory, subscribeDebugLog } from "@/lib/checkout/debug-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events feed of the checkout debug log (see debug-log.ts) —
 * backs the live console at /debug. Sends buffered history immediately on
 * connect, then streams new entries as they're published.
 *
 * Gated by DEBUG_LOGS_ENABLED (default false) + a DEBUG_LOGS_TOKEN query
 * param — this now covers real payment automation internals (lastminute
 * checkout steps, Prava credential-issuance events), not just demo Duffel
 * traces, so it can no longer be left open by default the way the original
 * no-auth Duffel-only version was. See docs/REMOVING_DEBUG_LOGS.md.
 */
function isAuthorized(req: Request): boolean {
  if (process.env.DEBUG_LOGS_ENABLED !== "true") return false;
  const configuredToken = process.env.DEBUG_LOGS_TOKEN;
  if (!configuredToken) return false;
  const provided = new URL(req.url).searchParams.get("token") || "";
  const a = Buffer.from(provided);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    // 404, not 401/403 — don't confirm this route exists to an unauthenticated caller.
    return new Response(null, { status: 404 });
  }

  const bookingId = new URL(req.url).searchParams.get("booking_id");
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (entry: { booking_id?: string }) => {
        if (bookingId && entry.booking_id !== bookingId) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
      };
      for (const entry of getDebugLogHistory()) send(entry);
      unsubscribe = subscribeDebugLog(send);
    },
    cancel() {
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
