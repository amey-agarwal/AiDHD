import { describe, it, expect } from "vitest";
import { createCredentialGuard, CredentialLeakError, guardedAiCall } from "./credential-guard";

const credentials = {
  token: "4622943123137789",
  dynamic_cvv: "757",
  expiry_month: "12",
  expiry_year: "27",
};

describe("createCredentialGuard", () => {
  it("throws when the exact PAN is passed", () => {
    const guard = createCredentialGuard(credentials);
    expect(() => guard(`type the card number 4622943123137789 into the field`)).toThrow(CredentialLeakError);
  });

  it("throws when the exact CVV is passed", () => {
    const guard = createCredentialGuard(credentials);
    expect(() => guard(`cvv is 757`)).toThrow(CredentialLeakError);
  });

  it("throws when the expiry MM/YY is passed", () => {
    const guard = createCredentialGuard(credentials);
    expect(() => guard(`set expiry to 12/27`)).toThrow(CredentialLeakError);
  });

  it("throws when a credential is nested inside an object payload", () => {
    const guard = createCredentialGuard(credentials);
    expect(() => guard({ instruction: "fill card", value: "4622943123137789" })).toThrow(CredentialLeakError);
  });

  it("does not throw for an unrelated instruction string", () => {
    const guard = createCredentialGuard(credentials);
    expect(() => guard("click the accept cookies button")).not.toThrow();
    expect(() => guard("fill the passenger's first name field")).not.toThrow();
  });

  it("does not false-positive on short, coincidentally-matching substrings", () => {
    // "27" (expiry_year) alone must not blanket-block ordinary instructions.
    const guard = createCredentialGuard(credentials);
    expect(() => guard("there are 27 seats available")).not.toThrow();
  });
});

describe("guardedAiCall", () => {
  it("never invokes the wrapped call when the instruction carries a credential", async () => {
    const guard = createCredentialGuard(credentials);
    let called = false;
    await expect(
      guardedAiCall(guard, "card number: 4622943123137789", async () => {
        called = true;
      }),
    ).rejects.toThrow(CredentialLeakError);
    expect(called).toBe(false);
  });

  it("invokes the wrapped call for a safe instruction", async () => {
    const guard = createCredentialGuard(credentials);
    let called = false;
    await guardedAiCall(guard, "click continue", async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
