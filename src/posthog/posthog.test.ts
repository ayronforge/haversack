import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted } from "effect";

import { PostHogAnalytics } from "./capture.ts";
import { PostHogConfig } from "./config.ts";
import { FeatureFlags } from "./flags.ts";

const withFetch = async <A>(fake: typeof fetch, run: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const configured = PostHogConfig.layer({
  host: "https://ph.test",
  projectToken: Redacted.make("phc_token"),
});

describe("PostHogConfig", () => {
  test("defaults host and treats blank token as absent", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* PostHogConfig;
      }).pipe(
        Effect.provide(PostHogConfig.layer({ projectToken: Redacted.make("  ") })),
      ) as Effect.Effect<Effect.Effect.Success<typeof PostHogConfig>>,
    );
    expect(config.host).toBe("https://us.i.posthog.com");
    expect(config.projectToken).toBeUndefined();
  });
});

describe("PostHogAnalyticsLive", () => {
  test("delivers events to /capture/", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    await withFetch(
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const analytics = yield* PostHogAnalytics;
            yield* analytics.track({
              event: "signup",
              distinctId: "user_1",
              properties: { plan: "pro" },
            });
          }).pipe(
            Effect.provide(PostHogAnalytics.layer.pipe(Layer.provide(configured))),
          ) as Effect.Effect<void>,
        ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://ph.test/capture/");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.event).toBe("signup");
    expect(body.distinct_id).toBe("user_1");
  });

  test("never fails when delivery fails", async () => {
    await withFetch((async () => new Response("nope", { status: 500 })) as typeof fetch, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const analytics = yield* PostHogAnalytics;
          yield* analytics.track({ event: "x", distinctId: "y" });
        }).pipe(
          Effect.provide(PostHogAnalytics.layer.pipe(Layer.provide(configured))),
        ) as Effect.Effect<void>,
      ),
    );
  });

  test("skips delivery without a token", async () => {
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const analytics = yield* PostHogAnalytics;
            yield* analytics.track({ event: "x", distinctId: "y" });
          }).pipe(
            Effect.provide(PostHogAnalytics.layer.pipe(Layer.provide(PostHogConfig.layer()))),
          ) as Effect.Effect<void>,
        ),
    );
    expect(called).toBe(false);
  });
});

describe("FeatureFlags", () => {
  const flag = { key: "new-checkout", fallback: false };

  const evaluate = (fake: typeof fetch) =>
    withFetch(fake, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const flags = yield* FeatureFlags;
          return yield* flags.isEnabled(flag, { distinctId: "user_1" });
        }).pipe(
          Effect.provide(FeatureFlags.layer.pipe(Layer.provide(configured))),
        ) as Effect.Effect<boolean>,
      ),
    );

  test("resolves enabled flags", async () => {
    const enabled = await evaluate(
      (async () =>
        new Response(JSON.stringify({ flags: { "new-checkout": { enabled: true } } }), {
          status: 200,
        })) as typeof fetch,
    );
    expect(enabled).toBe(true);
  });

  test("absent flag resolves to false, not fallback", async () => {
    const enabled = await evaluate(
      (async () => new Response(JSON.stringify({ flags: {} }), { status: 200 })) as typeof fetch,
    );
    expect(enabled).toBe(false);
  });

  test("falls back on http errors", async () => {
    const enabled = await evaluate(
      (async () => new Response("boom", { status: 503 })) as typeof fetch,
    );
    expect(enabled).toBe(false);
  });
});
