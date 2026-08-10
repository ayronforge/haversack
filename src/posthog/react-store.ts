import type { PostHog, Properties } from "posthog-js";

import type { FeatureFlagDefinition } from "./flags.ts";

/** Authenticated identity used for browser feature-flag evaluation. */
export type PostHogFeatureFlagIdentity = {
  readonly distinctId: string;
  readonly personProperties?: Properties | undefined;
  readonly personPropertiesSetOnce?: Properties | undefined;
};

/** Authentication state observed by the React feature-flag integration. */
export type PostHogFeatureFlagSession =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Anonymous" }
  | { readonly _tag: "Authenticated"; readonly identity: PostHogFeatureFlagIdentity };

/** SDK operation that can fail while coordinating client feature flags. */
export type PostHogFeatureFlagOperation =
  | "evaluation"
  | "identify"
  | "reload"
  | "reset"
  | "subscribe"
  | "unsubscribe";

/** Structured failure reported by the React feature-flag integration. */
export type PostHogFeatureFlagError = {
  readonly _tag: "PostHogFeatureFlagError";
  readonly cause?: unknown | undefined;
  readonly operation: PostHogFeatureFlagOperation;
};

/** Readiness of feature flags for the session currently requested by React. */
export type PostHogFeatureFlagSnapshot =
  | { readonly _tag: "WaitingForIdentity" }
  | { readonly _tag: "Loading"; readonly distinctId: string }
  | { readonly _tag: "Ready"; readonly distinctId: string }
  | {
      readonly _tag: "Failed";
      readonly distinctId: string;
      readonly error: PostHogFeatureFlagError;
    };

type FeatureFlagsCallback = Parameters<PostHog["onFeatureFlags"]>[0];

/** Narrow store consumed by the React provider and hooks. */
export type PostHogFeatureFlagStore = {
  readonly dispose: () => void;
  readonly getSnapshot: () => PostHogFeatureFlagSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: (session: PostHogFeatureFlagSession) => void;
};

/** Creates the session-aware external store over an initialized PostHog SDK. */
export function makePostHogFeatureFlagStore(
  client: PostHog,
  reportError: (error: PostHogFeatureFlagError) => void,
): PostHogFeatureFlagStore {
  const listeners = new Set<() => void>();
  let lastIdentifiedIdentity: PostHogFeatureFlagIdentity | undefined;
  let lastResolvedSession: "Anonymous" | "Authenticated" | undefined;
  let requestedDistinctId: string | undefined;
  let snapshot: PostHogFeatureFlagSnapshot = { _tag: "WaitingForIdentity" };
  let subscriptionError: PostHogFeatureFlagError | undefined;
  let unsubscribe: (() => void) | undefined;

  const publish = (nextSnapshot: PostHogFeatureFlagSnapshot) => {
    snapshot = nextSnapshot;
    for (const listener of listeners) listener();
  };

  const fail = (operation: PostHogFeatureFlagOperation, distinctId: string, cause?: unknown) => {
    const error: PostHogFeatureFlagError = {
      _tag: "PostHogFeatureFlagError",
      cause,
      operation,
    };
    reportError(error);
    publish({ _tag: "Failed", distinctId, error });
    return error;
  };

  const onFeatureFlags: FeatureFlagsCallback = (_flags, _variants, context) => {
    const expectedDistinctId = requestedDistinctId;
    if (!expectedDistinctId) return;

    if (context?.errorsLoading) {
      fail("evaluation", expectedDistinctId);
      return;
    }

    publish({ _tag: "Ready", distinctId: expectedDistinctId });
  };

  const ensureSubscribed = () => {
    if (unsubscribe || subscriptionError) return;
    try {
      unsubscribe = client.onFeatureFlags(onFeatureFlags);
    } catch (cause: unknown) {
      subscriptionError = {
        _tag: "PostHogFeatureFlagError",
        cause,
        operation: "subscribe",
      };
      reportError(subscriptionError);
    }
  };

  const synchronize = (session: PostHogFeatureFlagSession) => {
    ensureSubscribed();

    if (session._tag === "Pending") {
      requestedDistinctId = undefined;
      publish({ _tag: "WaitingForIdentity" });
      return;
    }

    if (session._tag === "Anonymous") {
      const shouldLoadInitialAnonymousFlags = lastResolvedSession !== "Authenticated";
      const currentDistinctId = client.get_distinct_id();
      if (lastResolvedSession === "Authenticated" && currentDistinctId === requestedDistinctId) {
        try {
          client.reset();
        } catch (cause: unknown) {
          const distinctId = client.get_distinct_id();
          requestedDistinctId = distinctId;
          lastResolvedSession = "Anonymous";
          fail("reset", distinctId, cause);
          return;
        }
      }

      const distinctId = client.get_distinct_id();
      requestedDistinctId = distinctId;
      lastIdentifiedIdentity = undefined;
      lastResolvedSession = "Anonymous";
      if (subscriptionError) {
        publish({ _tag: "Failed", distinctId, error: subscriptionError });
        return;
      }
      publish(
        client.featureFlags.hasLoadedFlags
          ? { _tag: "Ready", distinctId }
          : { _tag: "Loading", distinctId },
      );
      if (shouldLoadInitialAnonymousFlags && !client.featureFlags.hasLoadedFlags) {
        try {
          client.reloadFeatureFlags();
        } catch (cause: unknown) {
          fail("reload", distinctId, cause);
        }
      }
      return;
    }

    const { identity } = session;
    const previousDistinctId = client.get_distinct_id();
    requestedDistinctId = identity.distinctId;
    lastResolvedSession = "Authenticated";

    if (subscriptionError) {
      publish({ _tag: "Failed", distinctId: identity.distinctId, error: subscriptionError });
      return;
    }

    if (previousDistinctId !== identity.distinctId || !client.featureFlags.hasLoadedFlags) {
      publish({ _tag: "Loading", distinctId: identity.distinctId });
    }

    if (lastIdentifiedIdentity !== identity) {
      try {
        client.identify(
          identity.distinctId,
          identity.personProperties,
          identity.personPropertiesSetOnce,
        );
        lastIdentifiedIdentity = identity;
      } catch (cause: unknown) {
        fail("identify", identity.distinctId, cause);
        return;
      }
    }

    if (previousDistinctId === identity.distinctId && client.featureFlags.hasLoadedFlags) {
      publish({ _tag: "Ready", distinctId: identity.distinctId });
    }
  };

  return {
    dispose: () => {
      listeners.clear();
      if (!unsubscribe) return;
      try {
        unsubscribe();
      } catch (cause: unknown) {
        reportError({
          _tag: "PostHogFeatureFlagError",
          cause,
          operation: "unsubscribe",
        });
      }
      unsubscribe = undefined;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    synchronize,
  };
}

/** Resolves the public flag value from session readiness and the official hook result. */
export function resolvePostHogFeatureFlag(
  snapshot: PostHogFeatureFlagSnapshot,
  evaluated: boolean | undefined,
  flag: FeatureFlagDefinition,
): boolean | undefined {
  switch (snapshot._tag) {
    case "WaitingForIdentity":
    case "Loading":
      return undefined;
    case "Failed":
      return flag.fallback;
    case "Ready":
      return evaluated === true;
  }
}
