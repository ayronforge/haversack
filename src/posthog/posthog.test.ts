import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { PostHogAnalytics } from "./capture.ts";
import { PostHogConfig } from "./config.ts";
import { FeatureFlags } from "./flags.ts";

const configured = PostHogConfig.layer({
  host: "https://ph.test",
  projectToken: Redacted.make("phc_token"),
});

const track = (
  fake: typeof fetch,
  config: Layer.Layer<PostHogConfig> = configured,
  input = { event: "x", distinctId: "y" },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* PostHogAnalytics;
      yield* analytics.track(input);
    }).pipe(
      Effect.provide(PostHogAnalytics.layer.pipe(Layer.provide(config))),
      Effect.provideService(FetchHttpClient.Fetch, fake),
    ),
  );

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
    await track(
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      configured,
      { event: "signup", distinctId: "user_1", properties: { plan: "pro" } },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://ph.test/capture/");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.event).toBe("signup");
    expect(body.distinct_id).toBe("user_1");
  });

  test("never fails when delivery fails", async () => {
    await track((async () => new Response("nope", { status: 500 })) as typeof fetch);
  });

  test("skips delivery without a token", async () => {
    let called = false;
    await track(
      (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      PostHogConfig.layer(),
    );
    expect(called).toBe(false);
  });
});

describe("FeatureFlags", () => {
  const flag = { key: "new-checkout", fallback: false };

  const evaluate = (fake: typeof fetch) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const flags = yield* FeatureFlags;
        return yield* flags.isEnabled(flag, { distinctId: "user_1" });
      }).pipe(
        Effect.provide(FeatureFlags.layer.pipe(Layer.provide(configured))),
        Effect.provideService(FetchHttpClient.Fetch, fake),
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
