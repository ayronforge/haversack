import { Context, Data, Effect, Layer } from "effect";
import type { PostHog } from "posthog-js";

import type { FeatureFlagDefinition } from "./flags.ts";

type PostHogInitOptions = NonNullable<Parameters<PostHog["init"]>[1]>;
type FeatureFlagsCallback = (
  flags: ReadonlyArray<string>,
  variants: Readonly<Record<string, string | boolean>>,
  context?: { readonly errorsLoading?: boolean },
) => void;

/** Properties accepted by the PostHog browser SDK capture method. */
export type PostHogEventProperties = NonNullable<Parameters<PostHog["capture"]>[1]>;

/** Authenticated identity shared by client capture and feature flags. */
export type PostHogClientIdentity = {
  readonly distinctId: string;
  readonly personProperties: Readonly<Record<string, string>> | undefined;
};

/** Session state synchronized with the PostHog client SDK. */
export type PostHogClientSession =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Anonymous" }
  | { readonly _tag: "Authenticated"; readonly identity: PostHogClientIdentity };

/** Minimal browser SDK port required by `PostHogClient`. */
export type PostHogClientSdk = {
  readonly capture: (event: string, properties?: PostHogEventProperties) => unknown;
  readonly get_distinct_id: () => string;
  readonly identify: (
    distinctId: string,
    properties: Readonly<Record<string, string>> | undefined,
  ) => void;
  readonly init: (token: string, options: PostHogInitOptions) => unknown;
  readonly isFeatureEnabled: (
    key: string,
    options: { readonly fresh: true },
  ) => boolean | undefined;
  readonly onFeatureFlags: (callback: FeatureFlagsCallback) => () => void;
  readonly reloadFeatureFlags: () => void;
  readonly reset: () => void;
};

/** Configuration and injected SDK instance for the client runtime. */
export type PostHogClientLayerOptions = {
  readonly apiHost: string;
  readonly client: PostHogClientSdk;
  readonly flags?: ReadonlyArray<FeatureFlagDefinition> | undefined;
  readonly initOptions?: Omit<
    PostHogInitOptions,
    "advanced_disable_feature_flags" | "advanced_disable_feature_flags_on_first_load" | "api_host"
  >;
  readonly projectToken: string | undefined;
};

/** Expected PostHog SDK operation failure. */
export type PostHogClientOperation =
  | "capture"
  | "featureFlags.read"
  | "featureFlags.subscribe"
  | "featureFlags.unsubscribe"
  | "identify"
  | "initialize"
  | "reset";

export class PostHogClientError extends Data.TaggedError("PostHogClientError")<{
  readonly cause: unknown;
  readonly operation: PostHogClientOperation;
}> {}

/** Whether the SDK is usable by this client instance. */
export type PostHogClientAvailability = "available" | "initialization-failed" | "not-configured";

type FeatureFlagValues = ReadonlyMap<string, boolean>;

/** Immutable feature-flag state published by `PostHogClient`. */
export type PostHogFeatureFlagSnapshot =
  | {
      readonly _tag: "Unavailable";
      readonly reason: "initialization-failed" | "not-configured" | "subscription-failed";
      readonly values: FeatureFlagValues;
    }
  | { readonly _tag: "WaitingForIdentity" }
  | { readonly _tag: "Anonymous" }
  | { readonly _tag: "Loading"; readonly distinctId: string }
  | {
      readonly _tag: "Ready";
      readonly distinctId: string;
      readonly values: FeatureFlagValues;
    }
  | {
      readonly _tag: "Failed";
      readonly distinctId: string;
      readonly reason: "evaluation" | PostHogClientOperation;
      readonly values: FeatureFlagValues;
    };

function fallbackValues(flags: ReadonlyArray<FeatureFlagDefinition>): FeatureFlagValues {
  const values = new Map<string, boolean>();
  for (const flag of flags) values.set(flag.key, flag.fallback);
  return values;
}

/**
 * Stateful PostHog browser capability. One instance owns SDK initialization,
 * capture, identity transitions, and reactive feature-flag evaluation.
 */
export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    readonly availability: PostHogClientAvailability;
    /** Captures an event fail-open so analytics cannot break application behavior. */
    readonly capture: (event: string, properties?: PostHogEventProperties) => Effect.Effect<void>;
    /** Synchronous feature-flag snapshot for `useSyncExternalStore`. */
    readonly getFeatureFlagSnapshot: () => PostHogFeatureFlagSnapshot;
    /** Flag catalog evaluated by this client instance. */
    readonly flags: ReadonlyArray<FeatureFlagDefinition>;
    /** Applies an authentication transition and refreshes flags for that identity. */
    readonly synchronize: (
      session: PostHogClientSession,
    ) => Effect.Effect<void, PostHogClientError>;
    /** Subscribes to feature-flag snapshot changes. */
    readonly subscribeFeatureFlags: (listener: () => void) => () => void;
  }
>()("@ayronforge/haversack/posthog/PostHogClient") {
  /** Builds one scoped capability from an injected PostHog SDK object. */
  static layer(options: PostHogClientLayerOptions): Layer.Layer<PostHogClient> {
    return Layer.effect(
      PostHogClient,
      Effect.gen(function* () {
        const projectToken = options.projectToken?.trim();
        const catalog = options.flags ?? [];
        const listeners = new Set<() => void>();
        let availability: PostHogClientAvailability = projectToken ? "available" : "not-configured";
        let evaluatedDistinctId: string | undefined;
        let requestedDistinctId: string | undefined;

        if (projectToken) {
          const initialized = yield* Effect.try({
            try: () => {
              options.client.init(projectToken, {
                ...options.initOptions,
                advanced_disable_feature_flags_on_first_load: true,
                api_host: options.apiHost,
              });
              return true;
            },
            catch: (cause) => new PostHogClientError({ cause, operation: "initialize" }),
          }).pipe(
            Effect.catchTag("PostHogClientError", (error) =>
              Effect.logWarning("posthog_client_initialization_failed", {
                operation: error.operation,
              }).pipe(Effect.as(false)),
            ),
          );
          if (!initialized) availability = "initialization-failed";
        }

        let snapshot: PostHogFeatureFlagSnapshot =
          availability === "available"
            ? { _tag: "WaitingForIdentity" }
            : {
                _tag: "Unavailable",
                reason: availability,
                values: fallbackValues(catalog),
              };

        const publish = (nextSnapshot: PostHogFeatureFlagSnapshot) => {
          snapshot = nextSnapshot;
          for (const listener of listeners) listener();
        };

        const use = Effect.fn("PostHogClient.use")(function* <A>(
          operation: PostHogClientOperation,
          f: (client: PostHogClientSdk) => A,
        ) {
          if (availability !== "available") {
            return yield* new PostHogClientError({ cause: undefined, operation });
          }
          return yield* Effect.try({
            try: () => f(options.client),
            catch: (cause) => new PostHogClientError({ cause, operation }),
          });
        });

        const capture = Effect.fn("PostHogClient.capture")(function* (
          event: string,
          properties?: PostHogEventProperties,
        ) {
          if (availability !== "available") return;
          yield* use("capture", (client) => client.capture(event, properties)).pipe(
            Effect.catchTag("PostHogClientError", (error) =>
              Effect.logWarning("posthog_client_capture_dropped", {
                analyticsEvent: event,
                operation: error.operation,
              }),
            ),
          );
        });

        const readEvaluation = Effect.fn("PostHogClient.readFeatureFlags")(function* () {
          const evaluation = yield* use("featureFlags.read", (client) => {
            const distinctId = client.get_distinct_id();
            const values = new Map<string, boolean>();
            for (const flag of catalog) {
              values.set(flag.key, client.isFeatureEnabled(flag.key, { fresh: true }) === true);
            }
            return { distinctId, values };
          });

          if (!requestedDistinctId || evaluation.distinctId !== requestedDistinctId) return;
          evaluatedDistinctId = evaluation.distinctId;
          publish({
            _tag: "Ready",
            distinctId: evaluation.distinctId,
            values: evaluation.values,
          });
        });

        if (availability === "available" && catalog.length > 0) {
          const effectContext = yield* Effect.context<never>();
          const onFeatureFlags: FeatureFlagsCallback = (_flags, _variants, context) => {
            if (context?.errorsLoading) {
              if (!requestedDistinctId) return;
              evaluatedDistinctId = requestedDistinctId;
              publish({
                _tag: "Failed",
                distinctId: requestedDistinctId,
                reason: "evaluation",
                values: fallbackValues(catalog),
              });
              return;
            }

            Effect.runSyncWith(effectContext)(
              readEvaluation().pipe(
                Effect.catchTag("PostHogClientError", (error) =>
                  Effect.sync(() => {
                    if (!requestedDistinctId) return;
                    evaluatedDistinctId = requestedDistinctId;
                    publish({
                      _tag: "Failed",
                      distinctId: requestedDistinctId,
                      reason: error.operation,
                      values: fallbackValues(catalog),
                    });
                  }),
                ),
              ),
            );
          };

          yield* Effect.acquireRelease(
            use("featureFlags.subscribe", (client) => client.onFeatureFlags(onFeatureFlags)).pipe(
              Effect.catchTag("PostHogClientError", (error) =>
                Effect.gen(function* () {
                  snapshot = {
                    _tag: "Unavailable",
                    reason: "subscription-failed",
                    values: fallbackValues(catalog),
                  };
                  yield* Effect.logWarning("posthog_client_feature_flags_subscription_failed", {
                    operation: error.operation,
                  });
                  return () => undefined;
                }),
              ),
            ),
            (unsubscribe) =>
              Effect.try({
                try: unsubscribe,
                catch: (cause) =>
                  new PostHogClientError({ cause, operation: "featureFlags.unsubscribe" }),
              }).pipe(
                Effect.catchTag("PostHogClientError", (error) =>
                  Effect.logWarning("posthog_client_feature_flags_unsubscribe_failed", {
                    operation: error.operation,
                  }),
                ),
                Effect.andThen(Effect.sync(() => listeners.clear())),
              ),
          );
        }

        const synchronize = Effect.fn("PostHogClient.synchronize")(function* (
          session: PostHogClientSession,
        ) {
          if (availability !== "available") return;

          switch (session._tag) {
            case "Pending":
              requestedDistinctId = undefined;
              evaluatedDistinctId = undefined;
              publish({ _tag: "WaitingForIdentity" });
              return;
            case "Anonymous":
              requestedDistinctId = undefined;
              evaluatedDistinctId = undefined;
              publish({ _tag: "Anonymous" });
              return yield* use("reset", (client) => client.reset());
            case "Authenticated": {
              requestedDistinctId = session.identity.distinctId;
              if (evaluatedDistinctId !== session.identity.distinctId) {
                publish({ _tag: "Loading", distinctId: session.identity.distinctId });
              }

              return yield* use("identify", (client) => {
                client.identify(session.identity.distinctId, session.identity.personProperties);
                if (catalog.length > 0) client.reloadFeatureFlags();
              }).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    evaluatedDistinctId = session.identity.distinctId;
                    publish({
                      _tag: "Failed",
                      distinctId: session.identity.distinctId,
                      reason: error.operation,
                      values: fallbackValues(catalog),
                    });
                  }),
                ),
              );
            }
          }
        });

        return PostHogClient.of({
          availability,
          capture,
          flags: catalog,
          getFeatureFlagSnapshot: () => snapshot,
          subscribeFeatureFlags: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          synchronize,
        });
      }),
    );
  }
}

/** Concrete implementation stored behind the `PostHogClient` tag. */
export type PostHogClientService = Context.Service.Shape<typeof PostHogClient>;
