import { notFound } from "next/navigation";
import { CheckoutHotelClient } from "./CheckoutHotelClient";

export const dynamic = "force-dynamic";

/**
 * Headless checkout surface for the Prava one-time-card -> MAQAMI (LiteAPI)
 * hotel booking flow — driven by Playwright (maqami-checkout-bot.ts), same
 * shape as /checkout/[offerId] for Duffel. secretKey is a Stripe PaymentIntent
 * client_secret from post_rates_prebook; it's safe client-side by design
 * (that's what "client secret" means to Stripe) but only confirms this one
 * PaymentIntent, nothing account-wide.
 */
export default async function CheckoutHotelPage({
  params,
  searchParams,
}: {
  params: Promise<{ prebookId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { prebookId } = await params;
  const sp = await searchParams;
  const secretKey = str(sp.secretKey);
  const amount = str(sp.amount);
  const currency = str(sp.currency);
  if (!secretKey || !amount || !currency) notFound();

  return (
    <CheckoutHotelClient
      prebookId={prebookId}
      secretKey={secretKey}
      amount={Number(amount)}
      currency={currency}
    />
  );
}

function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] || "" : v || "";
}
