import { Effect } from "effect";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type {
  PostHogClientService,
  PostHogClientSession,
  PostHogEventProperties,
} from "./client.ts";

const PostHogClientContext = createContext<PostHogClientService | undefined>(undefined);

export type PostHogClientProviderProps = {
  readonly children: ReactNode;
  readonly client: PostHogClientService;
};

/** Exposes one Haversack PostHog client to React. */
export function PostHogClientProvider({ children, client }: PostHogClientProviderProps) {
  return <PostHogClientContext.Provider value={client}>{children}</PostHogClientContext.Provider>;
}

export type PostHogSessionSynchronizerProps = {
  readonly session: PostHogClientSession;
};

/** Synchronizes capture identity and client feature flags with the current session. */
export function PostHogSessionSynchronizer({ session }: PostHogSessionSynchronizerProps) {
  const client = usePostHogClient();

  useEffect(() => {
    const synchronization = client.synchronize(session).pipe(
      Effect.catchTag("PostHogClientError", (error) =>
        Effect.logWarning("posthog_client_session_synchronization_failed", {
          operation: error.operation,
        }),
      ),
    );
    const interrupt = Effect.runCallback(synchronization);
    return () => interrupt();
  }, [client, session]);

  return null;
}

/** Returns a stable fail-open event capture callback. */
export function usePostHogCapture(): (event: string, properties?: PostHogEventProperties) => void {
  const client = usePostHogClient();
  return useCallback(
    (event: string, properties?: PostHogEventProperties) => {
      Effect.runSync(client.capture(event, properties));
    },
    [client],
  );
}

/** Returns the flag evaluation, or `undefined` while identity is being evaluated. */
export function useFeatureFlag(key: string): boolean | undefined {
  const client = usePostHogClient();
  const snapshot = useSyncExternalStore(
    client.subscribeFeatureFlags,
    client.getFeatureFlagSnapshot,
    client.getFeatureFlagSnapshot,
  );
  const flag = client.flags.find((definition) => definition.key === key);
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

function usePostHogClient(): PostHogClientService {
  const client = useContext(PostHogClientContext);
  if (!client) throw new Error("PostHogClientProvider is missing from the React tree.");
  return client;
}
