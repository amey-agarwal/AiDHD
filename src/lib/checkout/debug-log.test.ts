import { describe, it, expect } from "vitest";
import { scrubSecrets } from "./debug-log";

describe("scrubSecrets", () => {
  it("redacts a full PAN embedded in a string to last-4 only", () => {
    const out = JSON.stringify(scrubSecrets("charged card 4622943123137789 for the order"));
    expect(out).not.toContain("4622943123137789");
    expect(out).toContain("7789");
  });

  it("redacts a full PAN with space separators", () => {
    const out = JSON.stringify(scrubSecrets("card 4622 9431 2313 7789 approved"));
    expect(out).not.toContain("4622 9431 2313 7789");
  });

  it("redacts a cvc/cvv field regardless of key naming", () => {
    for (const key of ["cvc", "cvv", "dynamic_cvv", "security_code"]) {
      const out = scrubSecrets({ [key]: "757" }) as Record<string, string>;
      expect(out[key]).not.toBe("757");
      expect(JSON.stringify(out)).not.toContain("757");
    }
  });

  it("redacts a token/pan/card_number field to last-4", () => {
    const out = scrubSecrets({ token: "4622943123137789", card_number: "4622943123137789" }) as Record<
      string,
      string
    >;
    expect(out.token).not.toBe("4622943123137789");
    expect(out.token).toContain("7789");
    expect(out.card_number).toContain("7789");
  });

  it("redacts expiry fields entirely", () => {
    const out = scrubSecrets({ expiry_month: "12", expiry_year: "27" }) as Record<string, string>;
    expect(out.expiry_month).toBe("[REDACTED]");
    expect(out.expiry_year).toBe("[REDACTED]");
  });

  it("redacts sk_* API keys embedded anywhere in a string", () => {
    const out = JSON.stringify(scrubSecrets(`Authorization: Bearer sk_live_abcdef123456xyz`));
    expect(out).not.toContain("sk_live_abcdef123456xyz");
  });

  it("redacts JWT-shaped strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abc123";
    const out = JSON.stringify(scrubSecrets({ session_token: jwt, note: `token was ${jwt}` }));
    expect(out).not.toContain(jwt);
  });

  it("redacts passenger passport/DOB fields by key name", () => {
    const out = scrubSecrets({
      passport_number: "X1234567",
      date_of_birth: "1990-01-01",
      dob: "1990-01-01",
      born_on: "1990-01-01",
    }) as Record<string, string>;
    expect(out.passport_number).toBe("[REDACTED]");
    expect(out.date_of_birth).toBe("[REDACTED]");
    expect(out.dob).toBe("[REDACTED]");
    expect(out.born_on).toBe("[REDACTED]");
  });

  it("recurses into nested objects and arrays (e.g. Prava's transactions[].line_items[] shape)", () => {
    const out = JSON.stringify(
      scrubSecrets({
        transactions: [
          {
            line_items: [
              { token: "4622943123137789", dynamic_cvv: "757", expiry_month: "12", expiry_year: "27" },
            ],
          },
        ],
      }),
    );
    expect(out).not.toContain("4622943123137789");
    expect(out).not.toContain("757");
    expect(out).not.toContain('"12"');
  });

  it("leaves ordinary short numeric fields (e.g. a flight number) untouched", () => {
    const out = scrubSecrets({ flight_number: 1, adults: 2 }) as Record<string, number>;
    expect(out.flight_number).toBe(1);
    expect(out.adults).toBe(2);
  });
});
