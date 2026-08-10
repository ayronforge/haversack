import { usePostHog } from "@posthog/react";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";

import { makePostHogFeatureFlagSubscription } from "./feature-flag-subscription.ts";
import type { FeatureFlagDefinition } from "./flags.ts";

/** Returns the evaluated flag, or `undefined` while PostHog is loading flags. */
export function useFeatureFlag(flag: FeatureFlagDefinition): boolean | undefined {
  const client = usePostHog();
  const { fallback, key } = flag;
  const store = useMemo(
    () => makePostHogFeatureFlagSubscription(client, { fallback, key }),
    [client, fallback, key],
  );

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** Props for declarative feature-flag rendering with distinct pending and disabled states. */
export type FeatureGateProps = {
  readonly children: ReactNode;
  readonly fallback?: ReactNode | undefined;
  readonly flag: FeatureFlagDefinition;
  readonly pending?: ReactNode | undefined;
};

/** Renders children only after the requested flag has resolved as enabled. */
export function FeatureGate({ children, fallback = null, flag, pending = null }: FeatureGateProps) {
  const enabled = useFeatureFlag(flag);
  if (enabled === undefined) return pending;
  return enabled ? children : fallback;
}
