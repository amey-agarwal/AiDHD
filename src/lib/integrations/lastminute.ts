import { logRequest, logResponse, logInfo } from "../checkout/debug-log";

/**
 * lastminute.com — a public, unauthenticated MCP server at mcp.lastminute.com
 * (serverInfo.name "MCP_FLIGHT_HDP"), same shape as maqami.ts's hotel MCP.
 * Verified live (2026-08-02): calls are stateless — no initialize handshake
 * or session id is required, a bare `tools/call` POST works on its own.
 *
 * IMPORTANT — there is no order-creation tool on this server. `search_flights`
 * returns a `deeplink` per fare straight into lastminute's own live checkout
 * (COBRANDED=LMNUK_LLMPROJECTUK, autoclick=true + a price token). That deeplink
 * IS the "direct checkout link" — see docs/lastminute-prava-integration.md §1.
 * There is no sandbox: every deeplink is real production lastminute.com.
 *
 * Responses come back as a single SSE-framed JSON-RPC message
 * ("event: message\r\ndata: {...}\r\n\r\n") even over a plain POST — parseSse
 * below unwraps that.
 */

const MCP_URL = "https://mcp.lastminute.com/mcp";

function parseSseJsonRpc(text: string): unknown {
  const match = text.match(/data:\s*(\{[\s\S]*\})\s*$/);
  const jsonText = match ? match[1] : text;
  return JSON.parse(jsonText);
}

async function callLastminuteTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const reqBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  };
  logRequest("lastminute", "POST", MCP_URL, { tool: name, args });
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  logResponse("lastminute", "POST", MCP_URL, res.status, { tool: name, raw_length: text.length });
  if (!res.ok) {
    throw new Error(`lastminute MCP ${name}: HTTP ${res.status}`);
  }
  const outer = parseSseJsonRpc(text) as {
    error?: { message?: string };
    result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  };
  if (outer.error) {
    throw new Error(`lastminute MCP ${name}: ${outer.error.message || "tool error"}`);
  }
  if (outer.result?.isError) {
    const text0 = outer.result.content?.[0]?.text;
    throw new Error(`lastminute MCP ${name} returned an error: ${text0 || "unknown"}`);
  }
  if (outer.result?.structuredContent !== undefined) {
    return outer.result.structuredContent as T;
  }
  const text0 = outer.result?.content?.[0]?.text;
  if (!text0) throw new Error(`lastminute MCP ${name}: unexpected response shape`);
  return JSON.parse(text0) as T;
}

export interface LastminuteFlightOption {
  flight_number: number;
  airline: string;
  departure: string;
  arrival: string;
  duration: string;
  stops: string;
  /** Exact display text from lastminute — never reformat, per their own tool description ("Display 'price' text EXACTLY as returned"). */
  price: string;
  price_amount: number;
  carrier_id: string;
  is_roundtrip: boolean;
  /**
   * The "direct checkout link" — an affiliate/cobranded deeplink into
   * lastminute's own live results/booking page with this fare auto-selected
   * (autoclick=true). Not a created order; nothing persists on lastminute's
   * side until a human/harness completes their checkout at this URL.
   */
  deeplink: string;
}

export interface LastminuteFlightSearchResult {
  success: boolean;
  flights: LastminuteFlightOption[];
  total_results: number;
  currency: string;
  is_roundtrip: boolean;
}

export async function searchLastminuteFlights(input: {
  departure: string;
  arrival: string;
  start_date: string;
  end_date?: string;
  adults?: number;
  flight_class?: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST_CLASS";
  max_results?: number;
  max_stops?: number;
  max_price_cents?: number;
}): Promise<LastminuteFlightSearchResult> {
  const data = await callLastminuteTool<{
    success?: boolean;
    flights?: LastminuteFlightOption[];
    total_results?: number;
    currency?: string;
    is_roundtrip?: boolean;
  }>("search_flights", {
    departure: input.departure,
    arrival: input.arrival,
    start_date: input.start_date,
    end_date: input.end_date || "",
    adults: input.adults ?? 1,
    flight_class: input.flight_class || "",
    max_results: input.max_results ?? 10,
    max_stops: input.max_stops != null ? String(input.max_stops) : "",
    max_price_cents: input.max_price_cents != null ? String(input.max_price_cents) : "",
  });
  logInfo("lastminute", "search_flights results", {
    total_results: data.total_results,
    currency: data.currency,
  });
  return {
    success: data.success ?? false,
    flights: data.flights || [],
    total_results: data.total_results || 0,
    currency: data.currency || "GBP",
    is_roundtrip: data.is_roundtrip ?? false,
  };
}

export interface LastminuteDestinationResolution {
  success: boolean;
  id?: string;
  name?: string;
  country?: string;
  country_code?: string;
  suggestions?: Array<{ id: string; name: string; country: string; country_code: string }>;
}

/** Needed before search_only_hotel / flight+hotel package searches for a free-text city name. */
export async function resolveLastminuteDestination(
  lang: string,
  cityName: string,
): Promise<LastminuteDestinationResolution> {
  return callLastminuteTool<LastminuteDestinationResolution>("resolve_destination_id", {
    lang,
    city_name: cityName,
  });
}
