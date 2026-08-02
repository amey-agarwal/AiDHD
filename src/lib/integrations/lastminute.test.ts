import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchLastminuteFlights, resolveLastminuteDestination } from "./lastminute";

function sseFrame(payload: unknown) {
  return `event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
}

describe("searchLastminuteFlights", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a real-shaped structuredContent response into typed flights", async () => {
    const mocked = vi.mocked(fetch);
    mocked.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        sseFrame({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              success: true,
              flights: [
                {
                  flight_number: 1,
                  airline: "EasyJet",
                  departure: "LGW 18:00",
                  arrival: "CDG 20:20",
                  duration: "1 hour and 20 min",
                  stops: "Direct",
                  price: "82.20 £",
                  price_amount: 8220,
                  carrier_id: "U2",
                  is_roundtrip: false,
                  deeplink: "https://www.lastminute.com/msr/route/searching.do?foo=bar",
                },
              ],
              total_results: 1,
              currency: "GBP",
              is_roundtrip: false,
            },
          },
        }),
    } as Response);

    const result = await searchLastminuteFlights({
      departure: "LON",
      arrival: "PAR",
      start_date: "2026-09-01",
    });

    expect(result.success).toBe(true);
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].deeplink).toContain("lastminute.com/msr/route/searching.do");
    expect(result.currency).toBe("GBP");

    const [, requestInit] = mocked.mock.calls[0];
    expect(JSON.parse((requestInit as RequestInit).body as string)).toMatchObject({
      method: "tools/call",
      params: { name: "search_flights" },
    });
  });

  it("falls back to parsing content[0].text when structuredContent is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        sseFrame({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ success: true, flights: [], total_results: 0, currency: "EUR" }) }],
          },
        }),
    } as Response);

    const result = await searchLastminuteFlights({ departure: "LON", arrival: "PAR", start_date: "2026-09-01" });
    expect(result.currency).toBe("EUR");
    expect(result.flights).toEqual([]);
  });

  it("throws with the tool's error message when the MCP call reports isError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        sseFrame({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "invalid IATA code" }] },
        }),
    } as Response);

    await expect(
      searchLastminuteFlights({ departure: "XXX", arrival: "PAR", start_date: "2026-09-01" }),
    ).rejects.toThrow(/invalid IATA code/);
  });

  it("throws on a non-2xx HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" } as Response);
    await expect(
      searchLastminuteFlights({ departure: "LON", arrival: "PAR", start_date: "2026-09-01" }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("resolveLastminuteDestination", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns suggestions on a non-exact match", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        sseFrame({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              success: false,
              message: "No exact match found. Suggestions returned.",
              suggestions: [{ id: "141660", name: "London", country: "United Kingdom", country_code: "GB" }],
            },
          },
        }),
    } as Response);

    const result = await resolveLastminuteDestination("en", "Londn");
    expect(result.success).toBe(false);
    expect(result.suggestions?.[0].name).toBe("London");
  });
});
