import type { PostHog } from "posthog-js";

import type { FeatureFlagDefinition } from "./flags.ts";

type FeatureFlagValue = boolean | undefined;

type FeatureFlagOperation = "evaluation" | "subscribe" | "unsubscribe";

type FeatureFlagError = {
  readonly _tag: "PostHogFeatureFlagError";
  readonly cause?: unknown | undefined;
  readonly operation: FeatureFlagOperation;
};

type FeatureFlagSubscription = {
  readonly getServerSnapshot: () => FeatureFlagValue;
  readonly getSnapshot: () => FeatureFlagValue;
  readonly subscribe: (listener: () => void) => () => void;
};

function reportError(error: FeatureFlagError) {
  console.warn("posthog_feature_flag_failed", { operation: error.operation });
}

/** Creates one lazily subscribed external store for a single PostHog flag. */
export function makePostHogFeatureFlagSubscription(
  client: PostHog,
  flag: FeatureFlagDefinition,
): FeatureFlagSubscription {
  const listeners = new Set<() => void>();
  let snapshot: FeatureFlagValue;
  let unsubscribe: (() => void) | undefined;

  const publish = (nextSnapshot: FeatureFlagValue) => {
    if (Object.is(snapshot, nextSnapshot)) return;
    snapshot = nextSnapshot;
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    if (listeners.size === 1) {
      try {
        unsubscribe = client.onFeatureFlags((_flags, _variants, context) => {
          if (context?.errorsLoading) {
            reportError({ _tag: "PostHogFeatureFlagError", operation: "evaluation" });
            publish(flag.fallback);
            return;
          }

          publish(client.isFeatureEnabled(flag.key) === true);
        });
      } catch (cause: unknown) {
        reportError({ _tag: "PostHogFeatureFlagError", cause, operation: "subscribe" });
        snapshot = flag.fallback;
      }
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size > 0 || !unsubscribe) return;

      try {
        unsubscribe();
      } catch (cause: unknown) {
        reportError({ _tag: "PostHogFeatureFlagError", cause, operation: "unsubscribe" });
      } finally {
        unsubscribe = undefined;
      }
    };
  };

  return {
    getServerSnapshot: () => undefined,
    getSnapshot: () => snapshot,
    subscribe,
  };
}
