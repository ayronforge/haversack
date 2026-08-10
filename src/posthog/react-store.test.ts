import { describe, expect, test } from "bun:test";

import type { PostHog } from "posthog-js";

import {
  makePostHogFeatureFlagStore,
  resolvePostHogFeatureFlag,
  type PostHogFeatureFlagError,
} from "./react-store.ts";

function recordingPostHog() {
  let callback: Parameters<PostHog["onFeatureFlags"]>[0] | undefined;
  let distinctId = "anonymous-1";
  let hasLoadedFlags = false;
  let reloads = 0;
  let resets = 0;
  const identities: Array<string> = [];

  const client = {
    featureFlags: {
      get hasLoadedFlags() {
        return hasLoadedFlags;
      },
    },
    get_distinct_id: () => distinctId,
    identify: (nextDistinctId: string) => {
      distinctId = nextDistinctId;
      identities.push(nextDistinctId);
    },
    onFeatureFlags: (nextCallback: Parameters<PostHog["onFeatureFlags"]>[0]) => {
      callback = nextCallback;
      return () => {
        callback = undefined;
      };
    },
    reloadFeatureFlags: () => {
      reloads += 1;
    },
    reset: () => {
      distinctId = `anonymous-${resets + 2}`;
      resets += 1;
      hasLoadedFlags = false;
    },
  };

  return {
    // SAFETY: the production store consumes only the methods represented by this recording SDK.
    client: client as unknown as PostHog,
    emit: (emittedDistinctId: string, errorsLoading = false) => {
      distinctId = emittedDistinctId;
      hasLoadedFlags = !errorsLoading;
      callback?.([], {}, { errorsLoading });
    },
    identities,
    reloads: () => reloads,
    resets: () => resets,
    subscribed: () => callback !== undefined,
  };
}

describe("PostHog feature flag store", () => {
  test("preserves the initial anonymous identity and resets only after authentication", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagStore(posthog.client, () => undefined);

    store.synchronize({ _tag: "Anonymous" });
    expect(posthog.resets()).toBe(0);
    expect(posthog.reloads()).toBe(1);
    expect(store.getSnapshot()).toEqual({ _tag: "Loading", distinctId: "anonymous-1" });

    store.synchronize({
      _tag: "Authenticated",
      identity: { distinctId: "account-1" },
    });
    expect(posthog.identities).toEqual(["account-1"]);

    store.synchronize({ _tag: "Anonymous" });
    store.synchronize({ _tag: "Anonymous" });
    expect(posthog.resets()).toBe(1);
    expect(store.getSnapshot()).toEqual({ _tag: "Loading", distinctId: "anonymous-2" });
  });

  test("does not reset again when the application already reset on logout", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagStore(posthog.client, () => undefined);

    store.synchronize({
      _tag: "Authenticated",
      identity: { distinctId: "account-1" },
    });
    posthog.client.reset();
    store.synchronize({ _tag: "Anonymous" });

    expect(posthog.resets()).toBe(1);
    expect(store.getSnapshot()).toEqual({ _tag: "Loading", distinctId: "anonymous-2" });
  });

  test("does not identify the same resolved session twice", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagStore(posthog.client, () => undefined);
    const identity = { distinctId: "account-1" } as const;

    store.synchronize({ _tag: "Authenticated", identity });
    store.synchronize({ _tag: "Authenticated", identity });

    expect(posthog.identities).toEqual(["account-1"]);
  });

  test("reports evaluation failure and resolves the configured fallback", () => {
    const posthog = recordingPostHog();
    const errors: Array<PostHogFeatureFlagError> = [];
    const store = makePostHogFeatureFlagStore(posthog.client, (error) => errors.push(error));
    const flag = { key: "new-checkout", fallback: true } as const;

    store.synchronize({
      _tag: "Authenticated",
      identity: { distinctId: "account-1" },
    });
    posthog.emit("account-1", true);

    expect(store.getSnapshot()._tag).toBe("Failed");
    expect(resolvePostHogFeatureFlag(store.getSnapshot(), undefined, flag)).toBe(true);
    expect(errors.map((error) => error.operation)).toEqual(["evaluation"]);
  });

  test("distinguishes loading, absent flags, and disabled flags", () => {
    const flag = { key: "new-checkout", fallback: true } as const;

    expect(
      resolvePostHogFeatureFlag({ _tag: "Loading", distinctId: "account-1" }, true, flag),
    ).toBeUndefined();
    expect(
      resolvePostHogFeatureFlag({ _tag: "Ready", distinctId: "account-1" }, undefined, flag),
    ).toBe(false);
    expect(resolvePostHogFeatureFlag({ _tag: "Ready", distinctId: "account-1" }, false, flag)).toBe(
      false,
    );
  });

  test("releases the SDK subscription", () => {
    const posthog = recordingPostHog();
    const store = makePostHogFeatureFlagStore(posthog.client, () => undefined);
    store.synchronize({ _tag: "Anonymous" });
    expect(posthog.subscribed()).toBe(true);

    store.dispose();
    expect(posthog.subscribed()).toBe(false);
  });
});
