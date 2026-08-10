import { describe, expect, test } from "bun:test";

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { Effect } from "effect";

import { testStub } from "../testing/test-stub.ts";
import { type RateLimiterRpc, RequestRateLimiter } from "./rate-limit.ts";

describe("RequestRateLimiter.layerMemory", () => {
  test("enforces a caller-supplied policy", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const rateLimiter = yield* RequestRateLimiter;
        const input = {
          key: "account:one",
          policy: { algorithm: "fixed-window", limit: 2, window: "1 minute" },
        } as const;

        yield* rateLimiter.limit(input);
        yield* rateLimiter.limit(input);
        return yield* Effect.flip(rateLimiter.limit(input));
      }).pipe(Effect.provide(RequestRateLimiter.layerMemory)),
    );

    expect(error._tag).toBe("RequestRateLimitExceeded");
    expect(error.limit).toBe(2);
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("RequestRateLimiter.layerDurableObject", () => {
  test("maps a caller-owned Durable Object result to the typed limit error", async () => {
    const received: Array<{ readonly key: string; readonly refillRateMs: number }> = [];
    const namespace = testStub<DurableObjectNamespace<RateLimiterRpc>>({
      getByName: (key: string) => ({
        fixedWindow: async (input: { readonly refillRateMs: number }) => {
          received.push({ key, refillRateMs: input.refillRateMs });
          return [3, 42_000] as const;
        },
        tokenBucket: async () => 0,
      }),
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const rateLimiter = yield* RequestRateLimiter;
        return yield* Effect.flip(
          rateLimiter.limit({
            key: "account:shared",
            policy: { algorithm: "fixed-window", limit: 2, window: "1 minute" },
          }),
        );
      }).pipe(Effect.provide(RequestRateLimiter.layerDurableObject(namespace))),
    );

    expect(error).toMatchObject({
      _tag: "RequestRateLimitExceeded",
      key: "account:shared",
      limit: 2,
      retryAfterMs: 42_000,
    });
    expect(received).toEqual([{ key: "account:shared", refillRateMs: 30_000 }]);
  });

  test("fails open when the Durable Object store is unavailable", async () => {
    const namespace = testStub<DurableObjectNamespace<RateLimiterRpc>>({
      getByName: () => ({
        fixedWindow: async () => {
          throw new Error("store unavailable");
        },
        tokenBucket: async () => {
          throw new Error("store unavailable");
        },
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const rateLimiter = yield* RequestRateLimiter;
        yield* rateLimiter.limit({
          key: "account:two",
          policy: { algorithm: "token-bucket", limit: 1, window: "1 minute" },
        });
      }).pipe(Effect.provide(RequestRateLimiter.layerDurableObject(namespace))),
    );
  });
});
