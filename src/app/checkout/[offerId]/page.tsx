import { notFound } from "next/navigation";
import {
  createDuffelComponentClientKey,
  getDuffelOffer,
} from "@/lib/integrations/duffel-checkout";
import { CheckoutClient } from "./CheckoutClient";

export const dynamic = "force-dynamic";

/**
 * Headless checkout surface for the Prava one-time-card -> Duffel order flow.
 * Not meant for a human traveler to browse to directly — it's driven by the
 * Playwright automation in duffel-checkout-bot.ts, which fills DuffelCardForm
 * with the one-time token/dynamic_cvv/expiry obtained from Prava's
 * payment-result, then lets @duffel/components run the 3DS session and posts
 * to /api/duffel/create-order to actually book the offer.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ offerId: string }>;
}) {
  const { offerId } = await params;
  const offer = await getDuffelOffer(offerId);
  if (!offer) notFound();

  const clientKey = await createDuffelComponentClientKey();

  return (
    <CheckoutClient
      clientKey={clientKey}
      offerId={offer.id}
      passengerId={offer.passengerId}
      amount={offer.total_amount}
      currency={offer.total_currency}
    />
  );
}
