import { useFeatureFlagEnabled, usePostHog } from "@posthog/react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import type { FeatureFlagDefinition } from "./flags.ts";
import type {
  PostHogFeatureFlagError,
  PostHogFeatureFlagSession,
  PostHogFeatureFlagStore,
} from "./react-store.ts";
import { makePostHogFeatureFlagStore, resolvePostHogFeatureFlag } from "./react-store.ts";

export type {
  PostHogFeatureFlagError,
  PostHogFeatureFlagIdentity,
  PostHogFeatureFlagOperation,
  PostHogFeatureFlagSession,
} from "./react-store.ts";

const FeatureFlagsContext = createContext<PostHogFeatureFlagStore | undefined>(undefined);

function defaultReportError(error: PostHogFeatureFlagError) {
  console.warn("posthog_feature_flags_failed", { operation: error.operation });
}

/** Props for the Haversack feature-flag policy over the official PostHog provider. */
export type FeatureFlagsProviderProps = {
  readonly children: ReactNode;
  readonly onError?: ((error: PostHogFeatureFlagError) => void) | undefined;
};

/** Adds session-aware feature-flag policy without creating or configuring another SDK client. */
export function FeatureFlagsProvider({ children, onError }: FeatureFlagsProviderProps) {
  const client = usePostHog();
  const store = useMemo(
    () => makePostHogFeatureFlagStore(client, onError ?? defaultReportError),
    [client, onError],
  );

  useEffect(() => () => store.dispose(), [store]);

  return <FeatureFlagsContext.Provider value={store}>{children}</FeatureFlagsContext.Provider>;
}

/** Props for synchronizing an application authentication state with PostHog flags. */
export type FeatureFlagsSessionSynchronizerProps = {
  readonly session: PostHogFeatureFlagSession;
};

/** Synchronizes identity transitions with the SDK supplied by the official PostHog provider. */
export function FeatureFlagsSessionSynchronizer({ session }: FeatureFlagsSessionSynchronizerProps) {
  const store = useFeatureFlagStore();

  useEffect(() => {
    store.synchronize(session);
  }, [session, store]);

  return null;
}

/** Returns the evaluated flag, or `undefined` while the requested identity is loading. */
export function useFeatureFlag(flag: FeatureFlagDefinition): boolean | undefined {
  const store = useFeatureFlagStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const evaluated = useFeatureFlagEnabled(flag.key);
  return resolvePostHogFeatureFlag(snapshot, evaluated, flag);
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

function useFeatureFlagStore(): PostHogFeatureFlagStore {
  const store = useContext(FeatureFlagsContext);
  if (!store) throw new Error("FeatureFlagsProvider is missing from the React tree.");
  return store;
}
