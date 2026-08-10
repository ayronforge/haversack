import { Effect } from "effect";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type {
  ClientFeatureFlagsService,
  PostHogClientService,
  PostHogClientSession,
  PostHogEventProperties,
} from "./client.ts";

const PostHogClientContext = createContext<PostHogClientService | undefined>(undefined);
const ClientFeatureFlagsContext = createContext<ClientFeatureFlagsService | undefined>(undefined);

export type PostHogClientProviderProps = {
  readonly children: ReactNode;
  readonly client: PostHogClientService;
  readonly featureFlags?: ClientFeatureFlagsService | undefined;
};

/** Exposes a Haversack PostHog client and optional feature-flag store to React. */
export function PostHogClientProvider({
  children,
  client,
  featureFlags,
}: PostHogClientProviderProps) {
  return (
    <PostHogClientContext.Provider value={client}>
      <ClientFeatureFlagsContext.Provider value={featureFlags}>
        {children}
      </ClientFeatureFlagsContext.Provider>
    </PostHogClientContext.Provider>
  );
}

export type PostHogSessionSynchronizerProps = {
  readonly session: PostHogClientSession;
};

/** Synchronizes capture identity and client feature flags with the current session. */
export function PostHogSessionSynchronizer({ session }: PostHogSessionSynchronizerProps) {
  const client = usePostHogClient();
  const featureFlags = useContext(ClientFeatureFlagsContext);

  useEffect(() => {
    const synchronization = featureFlags
      ? featureFlags.synchronize(session)
      : client.synchronize(session).pipe(
          Effect.catchTag("PostHogClientError", (error) =>
            Effect.logWarning("posthog_client_session_synchronization_failed", {
              operation: error.operation,
            }),
          ),
        );
    const interrupt = Effect.runCallback(synchronization);
    return () => interrupt();
  }, [client, featureFlags, session]);

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
  const service = useClientFeatureFlags();
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

function usePostHogClient(): PostHogClientService {
  const client = useContext(PostHogClientContext);
  if (!client) throw new Error("PostHogClientProvider is missing from the React tree.");
  return client;
}

function useClientFeatureFlags(): ClientFeatureFlagsService {
  const service = useContext(ClientFeatureFlagsContext);
  if (!service) throw new Error("PostHogClientProvider is missing a featureFlags service.");
  return service;
}
