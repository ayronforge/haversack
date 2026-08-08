import { Context, Effect, Layer, Redacted } from "effect";
import Stripe from "stripe";

import { StripeConfig, type StripeConfigOptions } from "./config.ts";
import { StripeClientError, StripeConfigError, StripeWebhookError } from "./errors.ts";

/** Suggested Stripe SDK operation names for autocomplete. */
export type StripeClientOperation =
  | "billing.meterEvents.create"
  | "billingPortal.sessions.create"
  | "checkout.sessions.create"
  | "checkout.sessions.listLineItems"
  | "customers.create"
  | "customers.retrieve"
  | "invoices.createPreview"
  | "invoices.retrieve"
  | "paymentMethods.retrieve"
  | "prices.list"
  | "subscriptions.list"
  | "subscriptions.retrieve"
  | "subscriptions.update"
  | "webhooks.constructEventAsync";

/** Suggested operations plus any SDK operation supplied by a consumer. */
export type StripeClientOperationName = StripeClientOperation | (string & {});

type StripeClientService = {
  readonly use: <A>(
    operation: StripeClientOperationName,
    request: (client: Stripe) => Promise<A>,
  ) => Effect.Effect<A, StripeClientError>;
  readonly verifyWebhook: (
    payload: string,
    signature: string,
  ) => Effect.Effect<Stripe.Event, StripeWebhookError | StripeConfigError>;
};

export class StripeClient extends Context.Service<StripeClient, StripeClientService>()(
  "@ayronforge/haversack/stripe/StripeClient",
) {
  static readonly layer: Layer.Layer<StripeClient, never, StripeConfig> = Layer.effect(
    StripeClient,
    Effect.map(StripeConfig, makeStripeClient),
  ).pipe(Layer.withSpan("StripeClient"));
}

/** Construct the wrapped client from redacted configuration. */
export function makeStripeClient(config: StripeConfigOptions): StripeClient["Service"] {
  const sdkConfig =
    config.apiVersion === undefined
      ? undefined
      : { apiVersion: config.apiVersion as Stripe.LatestApiVersion };
  const sdk = new Stripe(Redacted.value(config.secretKey), sdkConfig);
  return makeStripeClientService(sdk, config.webhookSecret);
}

/** Wrap an existing Stripe SDK client for explicit test and tool composition seams. */
export function makeStripeClientFromSdk(client: Stripe): StripeClient["Service"] {
  return makeStripeClientService(client, undefined);
}

function makeStripeClientService(
  client: Stripe,
  webhookSecret: Redacted.Redacted<string> | undefined,
): StripeClient["Service"] {
  const use = <A>(
    operation: StripeClientOperationName,
    request: (client: Stripe) => Promise<A>,
  ): Effect.Effect<A, StripeClientError> =>
    Effect.fn(`stripe.${operation}`)(() =>
      Effect.tryPromise({
        try: () => request(client),
        catch: (cause) => new StripeClientError({ cause, operation }),
      }),
    )();

  const verifyWebhook = Effect.fn("StripeClient.verifyWebhook")(function* (
    payload: string,
    signature: string,
  ) {
    if (webhookSecret === undefined) {
      return yield* new StripeConfigError({
        message: "Stripe webhook secret is not configured.",
      });
    }

    return yield* use("webhooks.constructEventAsync", (sdk) =>
      sdk.webhooks.constructEventAsync(payload, signature, Redacted.value(webhookSecret)),
    ).pipe(Effect.mapError((error) => new StripeWebhookError({ cause: error.cause })));
  });

  return StripeClient.of({ use, verifyWebhook });
}
