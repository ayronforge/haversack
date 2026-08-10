import { describe, expect, test } from "bun:test";

import type { PostHog } from "posthog-js";

import { makePostHogFeatureFlagSubscription } from "./feature-flag-subscription.ts";

function recordingPostHog(initial?: {
  readonly enabled?: boolean;
  readonly hasLoadedFlags?: boolean;
}) {
  let callback: Parameters<PostHog["onFeatureFlags"]>[0] | undefined;
  let enabled = initial?.enabled;
  let hasLoadedFlags = initial?.hasLoadedFlags ?? false;
  let subscriptions = 0;
  let unsubscriptions = 0;

  const client = {
    featureFlags: {
      get hasLoadedFlags() {
        return hasLoadedFlags;
      },
    },
    isFeatureEnabled: () => enabled,
    onFeatureFlags: (nextCallback: Parameters<PostHog["onFeatureFlags"]>[0]) => {
      callback = nextCallback;
      subscriptions += 1;
      if (hasLoadedFlags) callback([], {});
      return () => {
        callback = undefined;
        unsubscriptions += 1;
      };
    },
  };

  return {
    // SAFETY: the subscription consumes only the SDK methods represented by this recording client.
    client: client as unknown as PostHog,
    emit: (nextEnabled: boolean | undefined, errorsLoading = false) => {
      enabled = nextEnabled;
      hasLoadedFlags = !errorsLoading;
      callback?.([], {}, { errorsLoading });
    },
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
  };
}

const flag = { key: "new-checkout", fallback: true } as const;

describe("PostHog feature flag subscription", () => {
  test("stays pending until PostHog publishes the flag", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagSubscription(posthog.client, flag);
    const snapshots: Array<boolean | undefined> = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));

    expect(store.getSnapshot()).toBeUndefined();
    posthog.emit(false);

    expect(store.getSnapshot()).toBe(false);
    expect(snapshots).toEqual([false]);
    unsubscribe();
  });

  test("treats an absent loaded flag as disabled", () => {
    const posthog = recordingPostHog({ hasLoadedFlags: true });
    const store = makePostHogFeatureFlagSubscription(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });

  test("uses the typed definition fallback when evaluation fails", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagSubscription(posthog.client, flag);
    const unsubscribe = store.subscribe(() => undefined);

    posthog.emit(undefined, true);

    expect(store.getSnapshot()).toBe(true);
    unsubscribe();
  });

  test("lets React own the SDK subscription lifecycle", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagSubscription(posthog.client, flag);
    const unsubscribeFirst = store.subscribe(() => undefined);
    const unsubscribeSecond = store.subscribe(() => undefined);

    expect(posthog.subscriptions()).toBe(1);
    unsubscribeFirst();
    expect(posthog.unsubscriptions()).toBe(0);
    unsubscribeSecond();
    expect(posthog.unsubscriptions()).toBe(1);
  });
});
