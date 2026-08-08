import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted } from "effect";

import { testStub } from "../testing/test-stub.ts";
import {
  ClerkClient,
  ClerkClientLive,
  ClerkConfig,
  ClerkError,
  type ClerkSdkClient,
  type ClerkWebhookEvent,
  ClerkWebhookError,
} from "./clerk.ts";

// SAFETY: Operations in these tests only compare the injected value by identity;
// no Clerk SDK members are read from this deliberately minimal fake.
const fakeClient = testStub<ClerkSdkClient>({ kind: "fake-clerk" });

const fakeEvent: ClerkWebhookEvent<{ readonly id: string }, "user.created"> = {
  type: "user.created",
  data: { id: "user_1" },
};

const fakeClerkLayer = (verify: (request: Request) => Promise<ClerkWebhookEvent>) =>
  Layer.succeed(
    ClerkClient,
    ClerkClient.of({
      client: fakeClient,
      use: (fn) =>
        Effect.tryPromise({
          try: () => fn(fakeClient),
          catch: (cause) => new ClerkError({ cause }),
        }).pipe(Effect.withSpan("clerk.use")),
      useWebhook: (fn) =>
        Effect.tryPromise({
          try: () => fn({ verifyWebhook: verify }),
          catch: (cause) => new ClerkWebhookError({ cause }),
        }).pipe(Effect.withSpan("clerk.webhook")),
    }),
  );

describe("ClerkClient", () => {
  test("uses an SDK client injected through a test Layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const clerk = yield* ClerkClient;
        return yield* clerk.use(async (client) => client === fakeClient);
      }).pipe(Effect.provide(fakeClerkLayer(async () => fakeEvent))),
    );

    expect(result).toBe(true);
  });

  test("maps rejected SDK operations to ClerkError", async () => {
    const cause = new Error("Clerk unavailable");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const clerk = yield* ClerkClient;
        return yield* clerk.use(() => Promise.reject(cause));
      }).pipe(Effect.provide(fakeClerkLayer(async () => fakeEvent)), Effect.flip),
    );

    expect(error).toBeInstanceOf(ClerkError);
    expect(error.cause).toBe(cause);
  });

  test("uses the webhook SDK injected through a test Layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const clerk = yield* ClerkClient;
        return yield* clerk.useWebhook((sdk) =>
          sdk.verifyWebhook(new Request("https://example.test/webhooks/clerk")),
        );
      }).pipe(Effect.provide(fakeClerkLayer(async () => fakeEvent))),
    );

    expect(result).toEqual(fakeEvent);
  });

  test("maps rejected webhook operations to ClerkWebhookError", async () => {
    const cause = new Error("Invalid webhook signature");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const clerk = yield* ClerkClient;
        return yield* clerk.useWebhook((sdk) =>
          sdk.verifyWebhook(new Request("https://example.test/webhooks/clerk")),
        );
      }).pipe(Effect.provide(fakeClerkLayer(() => Promise.reject(cause))), Effect.flip),
    );

    expect(error).toBeInstanceOf(ClerkWebhookError);
    expect(error.cause).toBe(cause);
  });

  test("live Layer constructs the SDK client from redacted config", async () => {
    const config = ClerkConfig.layer({ secretKey: Redacted.make("sk_test") });
    const client = await Effect.runPromise(
      Effect.gen(function* () {
        const clerk = yield* ClerkClient;
        return clerk.client;
      }).pipe(Effect.provide(ClerkClientLive.pipe(Layer.provide(config)))),
    );

    expect(client.users).toBeDefined();
    expect(client.invitations).toBeDefined();
  });
});
