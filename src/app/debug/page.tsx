"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DebugLogEntry } from "@/lib/checkout/debug-log";

const TAG_COLORS: Record<string, string> = {
  prava: "text-amber-300",
  duffel: "text-sky-300",
  lastminute: "text-fuchsia-300",
  harness: "text-orange-300",
  poll: "text-violet-300",
  "checkout execute": "text-emerald-300",
  "prava complete": "text-emerald-300",
  fare_search: "text-fuchsia-300",
  prava_session: "text-amber-300",
  credential_issuance: "text-amber-300",
  navigation: "text-orange-300",
  cookie_banner: "text-orange-300",
  fare_review: "text-orange-300",
  contact_details: "text-orange-300",
  traveller_details: "text-orange-300",
  total_verification: "text-red-300",
  payment_fields: "text-red-300",
  confirmation: "text-emerald-300",
};

const LEVEL_COLORS: Record<string, string> = {
  info: "text-white/40",
  warn: "text-yellow-400",
  error: "text-red-400",
};

/** This whole page is scaffolding — see docs/REMOVING_DEBUG_LOGS.md to remove it and its API route cleanly. */
export default function DebugPage() {
  const [token, setToken] = useState("");
  const [tokenSubmitted, setTokenSubmitted] = useState(false);
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [bookingFilter, setBookingFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Convenience: `/debug?token=...` skips the manual entry step.
    const fromQuery = new URLSearchParams(window.location.search).get("token");
    if (fromQuery) {
      setToken(fromQuery);
      setTokenSubmitted(true);
    }
  }, []);

  useEffect(() => {
    if (!tokenSubmitted) return;
    const es = new EventSource(`/api/checkout/debug-stream?token=${encodeURIComponent(token)}`);
    es.onopen = () => {
      setConnected(true);
      setUnauthorized(false);
    };
    es.onerror = () => {
      setConnected(false);
      // EventSource can't read the HTTP status directly — a 404 (gated off / bad token) never opens, so treat "never connected" as unauthorized.
      setUnauthorized((wasConnected) => wasConnected || true);
    };
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data) as DebugLogEntry;
        setEntries((prev) => [...prev, entry].slice(-1000));
      } catch {
        // Ignore malformed frames rather than break the stream.
      }
    };
    return () => es.close();
  }, [tokenSubmitted, token]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, autoScroll]);

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (bookingFilter && !(e.booking_id || "").includes(bookingFilter)) return false;
        if (stageFilter && e.stage !== stageFilter && e.tag !== stageFilter) return false;
        if (levelFilter && (e.level || "info") !== levelFilter) return false;
        return true;
      }),
    [entries, bookingFilter, stageFilter, levelFilter],
  );

  const bookingIds = useMemo(
    () => [...new Set(entries.map((e) => e.booking_id).filter((b): b is string => Boolean(b)))],
    [entries],
  );

  function copyAsJson(entry: DebugLogEntry) {
    navigator.clipboard?.writeText(JSON.stringify(entry, null, 2)).catch(() => {});
  }

  function downloadBookingJson(bookingId: string) {
    const bookingEntries = entries.filter((e) => e.booking_id === bookingId);
    const blob = new Blob([JSON.stringify(bookingEntries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bookingId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!tokenSubmitted) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4 bg-[#0b0f14] text-white/90">
        <h1 className="font-display text-sm font-semibold">Checkout debug console</h1>
        <p className="max-w-sm text-center text-xs text-white/50">
          Requires DEBUG_LOGS_ENABLED=true on the server and a matching DEBUG_LOGS_TOKEN. Scaffolding — see
          docs/REMOVING_DEBUG_LOGS.md.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTokenSubmitted(true);
          }}
        >
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="DEBUG_LOGS_TOKEN"
            className="rounded-md border border-white/15 bg-transparent px-2 py-1 text-xs text-white/90"
          />
          <button type="submit" className="rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/5">
            Connect
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-[#0b0f14] text-white/90">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/agent" className="text-xs text-white/50 hover:text-white/80">
            ← Concierge
          </Link>
          <h1 className="font-display text-sm font-semibold">Checkout debug console</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={connected ? "text-emerald-400" : "text-red-400"}>
            {connected ? "● live" : unauthorized ? "● unauthorized / disabled" : "● disconnected"}
          </span>
          <input
            value={bookingFilter}
            onChange={(e) => setBookingFilter(e.target.value)}
            placeholder="filter booking_id"
            className="rounded-md border border-white/15 bg-transparent px-2 py-1 text-white/80"
          />
          <input
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            placeholder="filter stage/tag"
            className="rounded-md border border-white/15 bg-transparent px-2 py-1 text-white/80"
          />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="rounded-md border border-white/15 bg-[#0b0f14] px-2 py-1 text-white/80"
          >
            <option value="">all levels</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          {bookingIds.length > 0 && (
            <select
              onChange={(e) => e.target.value && downloadBookingJson(e.target.value)}
              defaultValue=""
              className="rounded-md border border-white/15 bg-[#0b0f14] px-2 py-1 text-white/80"
            >
              <option value="" disabled>
                download booking…
              </option>
              {bookingIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-white/60">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            autoscroll
          </label>
          <button
            type="button"
            onClick={() => setEntries([])}
            className="rounded-md border border-white/15 px-2 py-1 text-white/70 hover:bg-white/5"
          >
            Clear
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed">
        {filtered.length === 0 && (
          <p className="text-white/40">Waiting for checkout activity — start a booking or approve a Prava payment to see it here.</p>
        )}
        {filtered.map((e) => (
          <div key={e.id} className="mb-1.5 group">
            <span className="text-white/35">{e.ts.slice(11, 23)}</span>{" "}
            <span className={TAG_COLORS[e.stage || e.tag] || "text-white/70"}>[{e.stage || e.tag}]</span>{" "}
            {e.booking_id && <span className="text-white/30">{e.booking_id.slice(0, 14)} </span>}
            <span className={LEVEL_COLORS[e.level || "info"]}>{e.message}</span>
            {e.duration_ms != null && <span className="text-white/25"> ({e.duration_ms}ms)</span>}
            <button
              type="button"
              onClick={() => copyAsJson(e)}
              className="ml-2 hidden text-white/30 hover:text-white/60 group-hover:inline"
            >
              copy JSON
            </button>
            {e.data !== undefined && (
              <pre className="mt-0.5 ml-4 whitespace-pre-wrap break-all text-white/45">{JSON.stringify(e.data, null, 2)}</pre>
            )}
            {e.screenshot_base64 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/jpeg;base64,${e.screenshot_base64}`}
                alt={`${e.stage || e.tag} screenshot`}
                className="mt-1 ml-4 max-w-xs rounded border border-white/10"
              />
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </main>
  );
}
