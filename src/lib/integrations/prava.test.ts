import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPaymentResult, reportPaymentStatus, revokeSession, PravaApiError, PRAVA_ERROR_INFO } from "./prava";

const LIVE_SESSION_ID = "sess_live_test_fixture_not_real";

describe("PRAVA_ERROR_INFO / PravaApiError", () => {
  it("marks auth/validation/not-found codes as non-retriable", () => {
    for (const code of ["AUTH_1001", "AUTH_1002", "VAL_2001", "NOT_FOUND", "MANDATE_EXPIRED", "THRESHOLD_EXCEEDED"] as const) {
      expect(PRAVA_ERROR_INFO[code].retriable).toBe(false);
    }
  });

  it("marks transient/internal codes as retriable", () => {
    for (const code of ["MERCHANT_LOOKUP_ERROR", "SESSION_CREATE_ERROR", "VISA_CONFIRMATION_FAILED", "REPORT_STATUS_ERROR"] as const) {
      expect(PRAVA_ERROR_INFO[code].retriable).toBe(true);
    }
  });

  it("PravaApiError picks up retriable from the known code, defaulting to false for unknown codes", () => {
    expect(new PravaApiError("SESSION_CREATE_ERROR", "x").retriable).toBe(true);
    expect(new PravaApiError("NOT_FOUND", "x").retriable).toBe(false);
    expect(new PravaApiError("SOME_UNDOCUMENTED_CODE", "x").retriable).toBe(false);
  });
});

describe("getPaymentResult", () => {
  beforeEach(() => {
    vi.stubEnv("PRAVA_SECRET_KEY", "sk_test_fixture_not_real");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries once on a network throw, then succeeds", async () => {
    const mocked = vi.mocked(fetch);
    mocked
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
          transactions: [{ line_items: [{ token: "tok_fixture", dynamic_cvv: "111", expiry_month: "12", expiry_year: "27" }] }],
        }),
      } as Response);

    const result = await getPaymentResult(LIVE_SESSION_ID);
    expect(result.status).toBe("completed");
    expect(result.token).toBe("tok_fixture");
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("fails fast (no retry) on a non-retriable error like NOT_FOUND", async () => {
    const mocked = vi.mocked(fetch);
    mocked.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: "NOT_FOUND", message: "Session not found" }),
    } as Response);

    const result = await getPaymentResult(LIVE_SESSION_ID);
    expect(result.status).toBe("failed");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("returns the mock fixture without calling fetch when PRAVA_SECRET_KEY is absent", async () => {
    vi.unstubAllEnvs();
    const mocked = vi.mocked(fetch);
    const result = await getPaymentResult("sess_mock_whatever");
    expect(result.mode).toBe("mock");
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe("reportPaymentStatus", () => {
  beforeEach(() => {
    vi.stubEnv("PRAVA_SECRET_KEY", "sk_test_fixture_not_real");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("retries a retriable REPORT_STATUS_ERROR and eventually succeeds", async () => {
    const mocked = vi.mocked(fetch);
    mocked
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ code: "REPORT_STATUS_ERROR" }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);

    const result = await reportPaymentStatus(LIVE_SESSION_ID, "APPROVED");
    expect(result.ok).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retriable INVALID_STATE and reports failure", async () => {
    const mocked = vi.mocked(fetch);
    mocked.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "INVALID_STATE" }) } as Response);

    const result = await reportPaymentStatus(LIVE_SESSION_ID, "DECLINED");
    expect(result.ok).toBe(false);
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe("revokeSession", () => {
  beforeEach(() => {
    vi.stubEnv("PRAVA_SECRET_KEY", "sk_test_fixture_not_real");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("treats INVALID_STATE (already completed/expired) as a successful revoke", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: "INVALID_STATE", message: "Session not in a revocable state" }),
    } as Response);

    const result = await revokeSession(LIVE_SESSION_ID);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false on a genuine revoke failure", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: "NOT_FOUND" }),
    } as Response);

    const result = await revokeSession(LIVE_SESSION_ID);
    expect(result.ok).toBe(false);
  });

  it("short-circuits to ok:true for a mock session without calling fetch", async () => {
    vi.unstubAllEnvs();
    const mocked = vi.mocked(fetch);
    const result = await revokeSession("sess_mock_whatever");
    expect(result.ok).toBe(true);
    expect(mocked).not.toHaveBeenCalled();
  });
});
