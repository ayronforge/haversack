import { Cause, Effect, Exit } from "effect";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

import type { BrowserFeatureFlagSession, BrowserFeatureFlagsService } from "./browser.ts";

const FeatureFlagsContext = createContext<BrowserFeatureFlagsService | undefined>(undefined);

export type FeatureFlagsProviderProps = {
  readonly children: ReactNode;
  readonly service: BrowserFeatureFlagsService;
};

/** Exposes the feature flags service built by the app's Effect runtime. */
export function FeatureFlagsProvider({ children, service }: FeatureFlagsProviderProps) {
  return <FeatureFlagsContext.Provider value={service}>{children}</FeatureFlagsContext.Provider>;
}

export type FeatureFlagsSessionSynchronizerProps = {
  readonly session: BrowserFeatureFlagSession;
};

/**
 * Runs the Effect synchronization when the session changes and interrupts the
 * previous evaluation on cleanup or identity change.
 */
export function FeatureFlagsSessionSynchronizer({ session }: FeatureFlagsSessionSynchronizerProps) {
  const service = useFeatureFlagsService();

  useEffect(() => {
    const interrupt = Effect.runCallback(service.synchronize(session), {
      onExit: (exit) => {
        if (Exit.isFailure(exit)) {
          console.error(
            "Unexpected browser feature flag synchronization failure.",
            Cause.pretty(exit.cause),
          );
        }
      },
    });

    return () => interrupt();
  }, [service, session]);

  return null;
}

/** Returns the flag evaluation, or `undefined` while the account is being evaluated. */
export function useFeatureFlag(key: string): boolean | undefined {
  const service = useFeatureFlagsService();
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const flag = service.flags.find((definition) => definition.key === key);
  if (!flag) return undefined;

  switch (snapshot._tag) {
    case "Unavailable":
    case "Failed":
      return snapshot.values.get(flag.key) ?? flag.fallback;
    case "Ready":
      return snapshot.values.get(flag.key) ?? false;
    case "Anonymous":
    case "Loading":
    case "WaitingForIdentity":
      return undefined;
  }
}

export type FeatureGateProps = {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly flag: string;
  readonly pending?: ReactNode;
};

/** Renders `children` only when the flag is enabled. */
export function FeatureGate({ children, fallback = null, flag, pending = null }: FeatureGateProps) {
  const enabled = useFeatureFlag(flag);
  if (enabled === undefined) return pending;
  return enabled ? children : fallback;
}

function useFeatureFlagsService(): BrowserFeatureFlagsService {
  const service = useContext(FeatureFlagsContext);
  if (!service) {
    throw new Error("FeatureFlagsProvider is missing from the React tree.");
  }
  return service;
}
