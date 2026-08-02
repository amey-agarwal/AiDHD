"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

declare global {
  interface Window {
    LiteAPIPayment?: new (config: {
      publicKey: string;
      secretKey: string;
      targetElement: string;
      returnUrl: string;
      amount: number;
      currency: string;
      submitButton?: { text: string };
    }) => { handlePayment: () => Promise<void> };
  }
}

const WRAPPER_SCRIPT_URL = "https://payment-wrapper.liteapi.travel/dist/liteAPIPayment.js?v=a1";

export function CheckoutHotelClient({
  prebookId,
  secretKey,
  amount,
  currency,
}: {
  prebookId: string;
  secretKey: string;
  amount: number;
  currency: string;
}) {
  const searchParams = useSearchParams();
  const redirectStatus = searchParams.get("redirect_status");
  const [status, setStatus] = useState(redirectStatus ? `redirected:${redirectStatus}` : "loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (redirectStatus) return; // Already back from Stripe — nothing to mount.

    let cancelled = false;
    const script = document.createElement("script");
    script.src = WRAPPER_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (cancelled) return;
      try {
        if (!window.LiteAPIPayment) throw new Error("LiteAPIPayment failed to load");
        const returnUrl = window.location.href;
        const payment = new window.LiteAPIPayment({
          publicKey: "sandbox", // Stripe TEST mode — verified against payment-wrapper.liteapi.travel/config.
          secretKey,
          targetElement: "#payment-element",
          returnUrl,
          amount,
          currency,
          submitButton: { text: "Pay" },
        });
        payment.handlePayment().then(() => setStatus("ready"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to init payment widget");
        setStatus("error");
      }
    };
    script.onerror = () => {
      setError("Failed to load LiteAPI payment script");
      setStatus("error");
    };
    document.body.appendChild(script);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>MAQAMI hotel checkout</h1>
      <p style={{ fontSize: 13, color: "#666" }}>
        Prebook {prebookId} · {amount} {currency}
      </p>

      {redirectStatus ? (
        <p style={{ marginTop: 16 }}>Stripe redirect status: {redirectStatus}</p>
      ) : (
        <div id="payment-element" style={{ marginTop: 16 }} />
      )}
      {error && <p style={{ color: "red", marginTop: 8 }}>{error}</p>}

      <div id="checkout-status" data-status={status} style={{ marginTop: 16, fontSize: 13 }} />
    </main>
  );
}
