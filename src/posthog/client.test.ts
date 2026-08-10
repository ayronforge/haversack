import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { PostHogClient, type PostHogClientSdk } from "./client.ts";

type FakePostHog = {
  readonly sdk: PostHogClientSdk;
  readonly captures: Array<{ readonly event: string; readonly properties: unknown }>;
  readonly identities: Array<string>;
  readonly emitFlags: (context?: { readonly errorsLoading?: boolean }) => void;
  readonly initCalls: () => number;
  readonly reloadCalls: () => number;
  readonly resetCalls: () => number;
  readonly unsubscribeCalls: () => number;
};

const makeFakePostHog = (options?: { readonly captureFails?: boolean }): FakePostHog => {
  const captures: Array<{ readonly event: string; readonly properties: unknown }> = [];
  const identities: Array<string> = [];
  let distinctId = "anonymous";
  let featureFlagsCallback:
    | ((
        flags: ReadonlyArray<string>,
        variants: Readonly<Record<string, string | boolean>>,
        context?: { readonly errorsLoading?: boolean },
      ) => void)
    | undefined;
  let initialized = 0;
  let reloaded = 0;
  let reset = 0;
  let unsubscribed = 0;

  const sdk: PostHogClientSdk = {
    capture: (event, properties) => {
      if (options?.captureFails) throw new Error("capture unavailable");
      captures.push({ event, properties });
    },
    get_distinct_id: () => distinctId,
    identify: (nextDistinctId) => {
      distinctId = nextDistinctId;
      identities.push(nextDistinctId);
    },
    init: () => {
      initialized += 1;
    },
    isFeatureEnabled: (key) => key === "new-checkout",
    onFeatureFlags: (callback) => {
      featureFlagsCallback = callback;
      return () => {
        unsubscribed += 1;
      };
    },
    reloadFeatureFlags: () => {
      reloaded += 1;
    },
    reset: () => {
      distinctId = "anonymous";
      reset += 1;
    },
  };

  return {
    sdk,
    captures,
    identities,
    emitFlags: (context) => featureFlagsCallback?.([], {}, context),
    initCalls: () => initialized,
    reloadCalls: () => reloaded,
    resetCalls: () => reset,
    unsubscribeCalls: () => unsubscribed,
  };
};

describe("PostHogClient", () => {
  test("shares one initialized SDK across capture, identity, and feature flags", async () => {
    const fake = makeFakePostHog();
    const layer = PostHogClient.layer({
      apiHost: "/ingest",
      client: fake.sdk,
      flags: [
        { key: "new-checkout", fallback: false },
        { key: "missing", fallback: true },
      ],
      projectToken: "project_token",
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* PostHogClient;

        yield* client.capture("checkout_opened", { source: "pricing" });
        yield* client.synchronize({
          _tag: "Authenticated",
          identity: { distinctId: "user_123", personProperties: { plan: "pro" } },
        });

        expect(client.getFeatureFlagSnapshot()).toEqual({
          _tag: "Loading",
          distinctId: "user_123",
        });
        yield* Effect.sync(() => fake.emitFlags());

        const snapshot = client.getFeatureFlagSnapshot();
        expect(snapshot._tag).toBe("Ready");
        if (snapshot._tag === "Ready") {
          expect(snapshot.distinctId).toBe("user_123");
          expect(snapshot.values.get("new-checkout")).toBe(true);
          expect(snapshot.values.get("missing")).toBe(false);
        }

        yield* client.synchronize({ _tag: "Anonymous" });
        expect(client.getFeatureFlagSnapshot()).toEqual({ _tag: "Anonymous" });
      }).pipe(Effect.provide(layer)),
    );

    expect(fake.initCalls()).toBe(1);
    expect(fake.captures).toEqual([
      { event: "checkout_opened", properties: { source: "pricing" } },
    ]);
    expect(fake.identities).toEqual(["user_123"]);
    expect(fake.reloadCalls()).toBe(1);
    expect(fake.resetCalls()).toBe(1);
    expect(fake.unsubscribeCalls()).toBe(1);
  });

  test("capture remains fail-open when the SDK throws", async () => {
    const fake = makeFakePostHog({ captureFails: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* PostHogClient;
        yield* client.capture("broken_capture");
      }).pipe(
        Effect.provide(
          PostHogClient.layer({
            apiHost: "/ingest",
            client: fake.sdk,
            projectToken: "project_token",
          }),
        ),
      ),
    );

    expect(fake.captures).toEqual([]);
  });

  test("synchronizes identity without requiring a feature-flag catalog", async () => {
    const fake = makeFakePostHog();

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* PostHogClient;
        yield* client.synchronize({
          _tag: "Authenticated",
          identity: { distinctId: "user_456", personProperties: undefined },
        });
      }).pipe(
        Effect.provide(
          PostHogClient.layer({
            apiHost: "/ingest",
            client: fake.sdk,
            projectToken: "project_token",
          }),
        ),
      ),
    );

    expect(fake.identities).toEqual(["user_456"]);
    expect(fake.reloadCalls()).toBe(0);
  });

  test("uses static fallbacks when no project token is configured", async () => {
    const fake = makeFakePostHog();
    const layer = PostHogClient.layer({
      apiHost: "/ingest",
      client: fake.sdk,
      flags: [{ key: "new-checkout", fallback: true }],
      projectToken: undefined,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* PostHogClient;
        yield* client.capture("ignored");
        yield* client.synchronize({
          _tag: "Authenticated",
          identity: { distinctId: "user_123", personProperties: undefined },
        });

        expect(client.availability).toBe("not-configured");
        expect(client.getFeatureFlagSnapshot()).toEqual({
          _tag: "Unavailable",
          reason: "not-configured",
          values: new Map([["new-checkout", true]]),
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(fake.initCalls()).toBe(0);
    expect(fake.captures).toEqual([]);
  });
});
