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

/** Minimal SDK port owned by `PostHogClient`. */
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
  readonly initOptions?: Omit<
    PostHogInitOptions,
    "advanced_disable_feature_flags" | "advanced_disable_feature_flags_on_first_load" | "api_host"
  >;
  readonly projectToken: string | undefined;
};

/** Expected PostHog SDK operation failure. */
export class PostHogClientError extends Data.TaggedError("PostHogClientError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

/** Whether the SDK is usable by this client instance. */
export type PostHogClientAvailability = "available" | "initialization-failed" | "not-configured";

/**
 * Stateful PostHog browser-SDK capability. One instance owns initialization,
 * identity, capture, and the SDK seam consumed by client feature flags.
 */
export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    readonly availability: PostHogClientAvailability;
    /** Captures an event fail-open so analytics cannot break application behavior. */
    readonly capture: (event: string, properties?: PostHogEventProperties) => Effect.Effect<void>;
    /** Applies an authentication transition to the shared SDK identity. */
    readonly synchronize: (
      session: PostHogClientSession,
    ) => Effect.Effect<void, PostHogClientError>;
    /** Runs a named synchronous operation against the initialized SDK. */
    readonly use: <A>(
      operation: string,
      f: (client: PostHogClientSdk) => A,
    ) => Effect.Effect<A, PostHogClientError>;
  }
>()("@ayronforge/haversack/posthog/PostHogClient") {
  /** Builds one client instance from an injected PostHog SDK object. */
  static layer(options: PostHogClientLayerOptions): Layer.Layer<PostHogClient> {
    return Layer.effect(
      PostHogClient,
      Effect.gen(function* () {
        const projectToken = options.projectToken?.trim();
        let availability: PostHogClientAvailability = projectToken ? "available" : "not-configured";

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

        const use = Effect.fn("PostHogClient.use")(function* <A>(
          operation: string,
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

        const synchronize = Effect.fn("PostHogClient.synchronize")(function* (
          session: PostHogClientSession,
        ) {
          switch (session._tag) {
            case "Pending":
              return;
            case "Anonymous":
              return yield* use("reset", (client) => client.reset());
            case "Authenticated":
              return yield* use("identify", (client) => {
                client.identify(session.identity.distinctId, session.identity.personProperties);
                client.reloadFeatureFlags();
              });
          }
        });

        return PostHogClient.of({ availability, capture, synchronize, use });
      }),
    );
  }
}

/** Concrete implementation stored behind the `PostHogClient` tag. */
export type PostHogClientService = Context.Service.Shape<typeof PostHogClient>;

type FeatureFlagValues = ReadonlyMap<string, boolean>;

/** Immutable snapshot published by client feature flags. */
export type ClientFeatureFlagSnapshot =
  | {
      readonly _tag: "Unavailable";
      readonly reason: "initialization-failed" | "not-configured";
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
      readonly reason: string;
      readonly values: FeatureFlagValues;
    };

/** Flag catalog supplied when building `ClientFeatureFlags`. */
export type ClientFeatureFlagsLayerOptions = {
  readonly flags: ReadonlyArray<FeatureFlagDefinition>;
};

function fallbackValues(flags: ReadonlyArray<FeatureFlagDefinition>): FeatureFlagValues {
  const values = new Map<string, boolean>();
  for (const flag of flags) values.set(flag.key, flag.fallback);
  return values;
}

/**
 * Reactive feature-flag store backed by the shared `PostHogClient` instance
 * and compatible with React's `useSyncExternalStore`.
 */
export class ClientFeatureFlags extends Context.Service<
  ClientFeatureFlags,
  {
    /** Synchronous snapshot required by `useSyncExternalStore`. */
    readonly getSnapshot: () => ClientFeatureFlagSnapshot;
    /** Flag catalog this instance evaluates. */
    readonly flags: ReadonlyArray<FeatureFlagDefinition>;
    /** Synchronizes SDK identity and evaluates all configured client flags. */
    readonly synchronize: (session: PostHogClientSession) => Effect.Effect<void>;
    /** Subscribes to snapshot changes; returns the unsubscribe callback. */
    readonly subscribe: (listener: () => void) => () => void;
  }
>()("@ayronforge/haversack/posthog/ClientFeatureFlags") {
  /** Builds a scoped reactive store over `PostHogClient`. */
  static layer(
    options: ClientFeatureFlagsLayerOptions,
  ): Layer.Layer<ClientFeatureFlags, never, PostHogClient> {
    return Layer.effect(
      ClientFeatureFlags,
      Effect.gen(function* () {
        const client = yield* PostHogClient;
        const effectContext = yield* Effect.context<never>();
        const catalog = options.flags;
        const listeners = new Set<() => void>();
        let evaluatedDistinctId: string | undefined;
        let requestedDistinctId: string | undefined;
        let snapshot: ClientFeatureFlagSnapshot =
          client.availability === "available"
            ? { _tag: "WaitingForIdentity" }
            : {
                _tag: "Unavailable",
                reason: client.availability,
                values: fallbackValues(catalog),
              };

        const publish = (nextSnapshot: ClientFeatureFlagSnapshot) => {
          snapshot = nextSnapshot;
          for (const listener of listeners) listener();
        };

        const readEvaluation = Effect.fn("ClientFeatureFlags.readEvaluation")(function* () {
          const evaluation = yield* client.use("featureFlags.read", (sdk) => {
            const distinctId = sdk.get_distinct_id();
            const values = new Map<string, boolean>();
            for (const flag of catalog) {
              values.set(flag.key, sdk.isFeatureEnabled(flag.key, { fresh: true }) === true);
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

        if (client.availability === "available") {
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
            client
              .use("featureFlags.subscribe", (sdk) => sdk.onFeatureFlags(onFeatureFlags))
              .pipe(
                Effect.catchTag("PostHogClientError", (error) =>
                  Effect.gen(function* () {
                    snapshot = {
                      _tag: "Unavailable",
                      reason: "initialization-failed",
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

        const synchronize = Effect.fn("ClientFeatureFlags.synchronize")(function* (
          session: PostHogClientSession,
        ) {
          if (client.availability !== "available") return;

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
              break;
            case "Authenticated":
              requestedDistinctId = session.identity.distinctId;
              if (evaluatedDistinctId !== session.identity.distinctId) {
                publish({ _tag: "Loading", distinctId: session.identity.distinctId });
              }
              break;
          }

          yield* client.synchronize(session).pipe(
            Effect.catchTag("PostHogClientError", (error) =>
              Effect.gen(function* () {
                if (session._tag === "Authenticated") {
                  evaluatedDistinctId = session.identity.distinctId;
                  publish({
                    _tag: "Failed",
                    distinctId: session.identity.distinctId,
                    reason: error.operation,
                    values: fallbackValues(catalog),
                  });
                }
                yield* Effect.logWarning("posthog_client_session_synchronization_failed", {
                  operation: error.operation,
                });
              }),
            ),
          );
        });

        return ClientFeatureFlags.of({
          getSnapshot: () => snapshot,
          flags: catalog,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          synchronize,
        });
      }),
    );
  }
}

/** Concrete implementation stored behind the `ClientFeatureFlags` tag. */
export type ClientFeatureFlagsService = Context.Service.Shape<typeof ClientFeatureFlags>;

/** Inert client feature flags serving static fallbacks. */
export function unavailableClientFeatureFlags(
  flags: ReadonlyArray<FeatureFlagDefinition>,
): ClientFeatureFlagsService {
  const snapshot: ClientFeatureFlagSnapshot = {
    _tag: "Unavailable",
    reason: "initialization-failed",
    values: fallbackValues(flags),
  };
  return ClientFeatureFlags.of({
    getSnapshot: () => snapshot,
    flags,
    subscribe: () => () => undefined,
    synchronize: () => Effect.void,
  });
}
