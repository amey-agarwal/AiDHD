"use client";

import { useState } from "react";
import {
  DuffelCardForm,
  useDuffelCardFormActions,
  createThreeDSecureSession,
  type CreateCardForTemporaryUseData,
  type CreateCardForTemporaryUseError,
} from "@duffel/components";

type Status =
  | "idle"
  | "creating-card"
  | "card-error"
  | "3ds"
  | "3ds-failed"
  | "ordering"
  | "order-success"
  | "order-error";

/**
 * Demo passenger — this app doesn't collect real traveler details anywhere
 * upstream (search -> pay is the whole flow), so a fixed placeholder stands
 * in for now. Swap for real collected passenger data before this is used
 * for anything beyond sandbox test runs.
 */
function demoPassenger(passengerId: string) {
  return {
    id: passengerId,
    given_name: "Alex",
    family_name: "Traveler",
    born_on: "1990-01-01",
    gender: "m" as const,
    title: "mr" as const,
    email: "traveler@aidhd.app",
    phone_number: "+15555550100",
  };
}

export function CheckoutClient({
  clientKey,
  offerId,
  passengerId,
  amount,
  currency,
}: {
  clientKey: string;
  offerId: string;
  passengerId: string;
  amount: string;
  currency: string;
}) {
  const { ref, createCardForTemporaryUse } = useDuffelCardFormActions();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<unknown>(null);

  async function runOrder(threeDSecureSessionId: string) {
    setStatus("ordering");
    setMessage("Creating Duffel order…");
    try {
      const res = await fetch("/api/duffel/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offerId,
          threeDSecureSessionId,
          passenger: demoPassenger(passengerId),
        }),
      });
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        setStatus("order-success");
        setMessage(`Order ${data.order_id} confirmed.`);
      } else {
        setStatus("order-error");
        setMessage(data.error || "Order failed.");
      }
    } catch (e) {
      setStatus("order-error");
      setMessage(e instanceof Error ? e.message : "Order request failed.");
      setResult({ ok: false, error: message });
    }
  }

  async function onCardSuccess(data: CreateCardForTemporaryUseData) {
    setStatus("3ds");
    setMessage("Starting 3D Secure session…");
    try {
      const session = await createThreeDSecureSession(
        clientKey,
        data.id,
        offerId,
        [],
        true,
      );
      if (session.status === "ready_for_payment") {
        await runOrder(session.id);
      } else if (session.status === "failed" || session.status === "expired") {
        setStatus("3ds-failed");
        setMessage(`3DS session ${session.status}.`);
      } else {
        // client_action_required — the component shows its own challenge
        // modal and resolves this same promise once actioned, so we should
        // not normally land here after awaiting; leave a status just in case.
        setStatus("3ds");
        setMessage(`3DS status: ${session.status}`);
      }
    } catch (e) {
      setStatus("3ds-failed");
      setMessage(e instanceof Error ? e.message : "3DS session failed.");
    }
  }

  function onCardError(err: CreateCardForTemporaryUseError) {
    setStatus("card-error");
    setMessage(err.message || "Card capture failed.");
  }

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>Duffel checkout</h1>
      <p style={{ fontSize: 13, color: "#666" }}>
        Offer {offerId} · {amount} {currency}
      </p>

      <div style={{ marginTop: 16 }}>
        <DuffelCardForm
          ref={ref}
          clientKey={clientKey}
          intent="to-create-card-for-temporary-use"
          onCreateCardForTemporaryUseSuccess={onCardSuccess}
          onCreateCardForTemporaryUseFailure={onCardError}
        />
      </div>

      <button
        type="button"
        onClick={() => {
          setStatus("creating-card");
          setMessage("Submitting card…");
          createCardForTemporaryUse();
        }}
        disabled={status !== "idle" && status !== "card-error"}
        style={{ marginTop: 16, padding: "10px 16px" }}
      >
        Pay
      </button>

      <div
        id="checkout-status"
        data-status={status}
        data-order-result={result ? JSON.stringify(result) : ""}
        style={{ marginTop: 16, fontSize: 13 }}
      >
        {message}
      </div>
    </main>
  );
}
