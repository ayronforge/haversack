import { describe, expect, test } from "bun:test";

import { Effect, Layer, Tracer } from "effect";
import type Stripe from "stripe";

import { testStub } from "../testing/test-stub.ts";
import { StripeClientError, StripeConfigError } from "./errors.ts";
import { makeStripeClientFromSdk, StripeClient } from "./service.ts";

const fakeStripeLayer = (sdk: Stripe) => Layer.succeed(StripeClient, makeStripeClientFromSdk(sdk));

const runWith = <A, E>(effect: Effect.Effect<A, E, StripeClient>, sdk: Stripe) =>
  Effect.runPromise(effect.pipe(Effect.provide(fakeStripeLayer(sdk))) as Effect.Effect<A, E>);

describe("StripeClient", () => {
  test("uses the injected SDK through the test seam", async () => {
    const sdk = testStub<Stripe>({ marker: "fake-sdk" });

    const result = await runWith(
      Effect.gen(function* () {
        const stripe = yield* StripeClient;
        return yield* stripe.use("custom.resource.retrieve", async (client) =>
          client === sdk ? "ok" : "wrong client",
        );
      }),
      sdk,
    );

    expect(result).toBe("ok");
  });

  test("records arbitrary operation names in the span and error metadata", async () => {
    const sdk = {} as Stripe;
    const cause = new Error("request failed");
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });

    const error = await Effect.runPromise(
      makeStripeClientFromSdk(sdk)
        .use("custom.resource.create", async () => {
          throw cause;
        })
        .pipe(Effect.flip, Effect.provideService(Tracer.Tracer, tracer)),
    );

    expect(error).toBeInstanceOf(StripeClientError);
    expect(error.cause).toBe(cause);
    expect(error.operation).toBe("custom.resource.create");
    expect(spans.some((span) => span.name === "stripe.custom.resource.create")).toBe(true);
  });

  test("fails webhook verification when the secret is not configured", async () => {
    let verificationCalls = 0;
    const sdk = testStub<Stripe>({
      webhooks: {
        constructEventAsync: async () => {
          verificationCalls += 1;
          throw new Error("should not be called");
        },
      },
    });

    const error = await runWith(
      Effect.gen(function* () {
        const stripe = yield* StripeClient;
        return yield* stripe.verifyWebhook("payload", "signature").pipe(Effect.flip);
      }),
      sdk,
    );

    expect(error).toBeInstanceOf(StripeConfigError);
    expect(error.message).toBe("Stripe webhook secret is not configured.");
    expect(verificationCalls).toBe(0);
  });
});
