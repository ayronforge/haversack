import { describe, expect, test } from "bun:test";

import type { PostHog } from "posthog-js";

import { createFeatureFlagStore } from "./feature-flag-store.ts";

function recordingPostHog(initial?: {
  readonly enabled?: boolean;
  readonly evaluationThrows?: boolean;
  readonly featureFlagsDisabled?: boolean;
  readonly hasLoadedFlags?: boolean;
}) {
  let featureFlagsCallback: Parameters<PostHog["onFeatureFlags"]>[0] | undefined;
  let reloadingCallback: (() => void) | undefined;
  let enabled = initial?.enabled;
  const hasLoadedFlags = initial?.hasLoadedFlags ?? false;
  let subscriptions = 0;
  let unsubscriptions = 0;

  const client = {
    config: {
      advanced_disable_feature_flags: initial?.featureFlagsDisabled ?? false,
    },
    featureFlags: { hasLoadedFlags },
    isFeatureEnabled: () => {
      if (initial?.evaluationThrows) throw new Error("evaluation failed");
      return enabled;
    },
    on: (event: string, callback: () => void) => {
      expect(event).toBe("featureFlagsReloading");
      reloadingCallback = callback;
      subscriptions += 1;
      return () => {
        reloadingCallback = undefined;
        unsubscriptions += 1;
      };
    },
    onFeatureFlags: (callback: Parameters<PostHog["onFeatureFlags"]>[0]) => {
      featureFlagsCallback = callback;
      subscriptions += 1;
      if (hasLoadedFlags) callback([], {});
      return () => {
        featureFlagsCallback = undefined;
        unsubscriptions += 1;
      };
    },
  };

  return {
    // SAFETY: the store consumes only the SDK methods represented by this recording client.
    client: client as unknown as PostHog,
    emitFlags: (nextEnabled: boolean | undefined, errorsLoading = false) => {
      enabled = nextEnabled;
      featureFlagsCallback?.([], {}, { errorsLoading });
    },
    emitReloading: () => reloadingCallback?.(),
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
  };
}

const flag = { key: "new-checkout", fallback: true } as const;

describe("PostHog feature flag store", () => {
  test("stays pending until PostHog publishes the flag", () => {
    const posthog = recordingPostHog();
    const store = createFeatureFlagStore(posthog.client, flag);
    const snapshots: Array<boolean | undefined> = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

    expect(store.getSnapshot()).toBeUndefined();
    posthog.emitFlags(false);

    expect(store.getSnapshot()).toBe(false);
    expect(snapshots).toEqual([false]);
    unsubscribe();
  });

  test("treats an absent loaded flag as disabled", () => {
    const posthog = recordingPostHog({ hasLoadedFlags: true });
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  test("uses the definition fallback when PostHog reports a loading failure", () => {
    const posthog = recordingPostHog();
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    posthog.emitFlags(undefined, true);

    expect(store.getSnapshot()).toBe(true);
    unsubscribe();
  });

  test("uses the definition fallback when local evaluation throws", () => {
    const posthog = recordingPostHog({ evaluationThrows: true });
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    posthog.emitFlags(undefined);

    expect(store.getSnapshot()).toBe(true);
    unsubscribe();
  });

  test("uses the definition fallback when feature flag loading is explicitly disabled", () => {
    const posthog = recordingPostHog({ featureFlagsDisabled: true });
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toBe(true);
    unsubscribe();
  });

  test("returns to pending while PostHog reloads flags", () => {
    const posthog = recordingPostHog({ enabled: true, hasLoadedFlags: true });
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toBe(true);
    posthog.emitReloading();
    expect(store.getSnapshot()).toBeUndefined();

    unsubscribe();
  });

  test("lets React own both SDK subscriptions", () => {
    const posthog = recordingPostHog();
    const store = createFeatureFlagStore(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    expect(posthog.subscriptions()).toBe(2);
    unsubscribe();
    expect(posthog.unsubscriptions()).toBe(2);
  });
});
