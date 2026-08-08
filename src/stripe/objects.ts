import type Stripe from "stripe";

export function stripeCustomerIdFrom(
  customer: Stripe.Customer | Stripe.DeletedCustomer | string | null | undefined,
) {
  if (typeof customer === "string") return customer;
  return customer?.id ?? null;
}

export function stripeCustomerEmailFrom(
  customer: Stripe.Customer | Stripe.DeletedCustomer | string | null | undefined,
) {
  if (!customer || typeof customer === "string") return null;
  if ("deleted" in customer && customer.deleted) return null;
  return typeof customer.email === "string" ? customer.email : null;
}

export function stripeCustomerEmailFromSession(session: Stripe.Checkout.Session) {
  return (
    session.customer_details?.email ??
    session.customer_email ??
    stripeCustomerEmailFrom(session.customer) ??
    null
  );
}

/** Whether Stripe has scheduled the subscription to stop renewing. */
export function stripeSubscriptionWillNotRenew(subscription: Stripe.Subscription) {
  return subscription.cancel_at_period_end || typeof subscription.cancel_at === "number";
}

/** The non-metered subscription item, when one exists. */
export function stripeLicensedSubscriptionItem(subscription: Stripe.Subscription) {
  return subscription.items.data.find((item) => item.price?.recurring?.usage_type !== "metered");
}

/** The licensed item, falling back to the first item for read-model derivation. */
export function stripeBaseSubscriptionItem(subscription: Stripe.Subscription) {
  return stripeLicensedSubscriptionItem(subscription) ?? subscription.items.data[0];
}

/** Provider identifiers and status suitable for a generic subscription read model. */
export function stripeSubscriptionProviderMetadata(subscription: Stripe.Subscription) {
  const price = stripeBaseSubscriptionItem(subscription)?.price;
  return {
    currency: price?.currency?.toUpperCase() ?? null,
    priceId: price?.id ?? null,
    rawStatus: subscription.status,
    subscriptionId: subscription.id,
  };
}
