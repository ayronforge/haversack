import type { PostHog } from "posthog-js";

import type { FeatureFlagDefinition } from "./flags.ts";

type FeatureFlagValue = boolean | undefined;

type FeatureFlagStore = {
  readonly getServerSnapshot: () => FeatureFlagValue;
  readonly getSnapshot: () => FeatureFlagValue;
  readonly subscribe: (listener: () => void) => () => void;
};

/** Internal adapter from PostHog events to React's external-store contract. */
export function createFeatureFlagStore(
  client: PostHog,
  flag: FeatureFlagDefinition,
): FeatureFlagStore {
  let snapshot: FeatureFlagValue =
    client.config.advanced_disable_feature_flags && !client.featureFlags?.hasLoadedFlags
      ? flag.fallback
      : undefined;

  return {
    getServerSnapshot: () => undefined,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      const unsubscribeReloading = client.on("featureFlagsReloading", () => {
        snapshot = undefined;
        listener();
      });
      const unsubscribeFlags = client.onFeatureFlags((_flags, _variants, context) => {
        snapshot = context?.errorsLoading ? flag.fallback : evaluateFeatureFlag(client, flag);
        listener();
      });

      return () => {
        unsubscribeFlags();
        unsubscribeReloading();
      };
    },
  };
}

function evaluateFeatureFlag(client: PostHog, flag: FeatureFlagDefinition): boolean {
  try {
    return client.isFeatureEnabled(flag.key) === true;
  } catch {
    return flag.fallback;
  }
}
