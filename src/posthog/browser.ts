import { Context, Effect, Layer, Schema } from "effect";
import type { PostHog } from "posthog-js";

import type { FeatureFlagDefinition } from "./flags.ts";

type PostHogInitOptions = NonNullable<Parameters<PostHog["init"]>[1]>;
type FeatureFlagsCallback = (
  flags: ReadonlyArray<string>,
  variants: Readonly<Record<string, string | boolean>>,
  context?: { readonly errorsLoading?: boolean },
) => void;

/** Authenticated identity used to evaluate flags in the browser. */
export type BrowserFeatureFlagIdentity = {
  readonly distinctId: string;
  readonly personProperties: Readonly<Record<string, string>> | undefined;
};

/** Session state observed by the React integration. */
export type BrowserFeatureFlagSession =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Anonymous" }
  | {
      readonly _tag: "Authenticated";
      readonly identity: BrowserFeatureFlagIdentity;
    };

type FeatureFlagValues = ReadonlyMap<string, boolean>;

/** Immutable snapshot published by the browser feature flags service. */
export type BrowserFeatureFlagSnapshot =
  | {
      readonly _tag: "Unavailable";
      readonly reason: "initialization-failed" | "not-configured";
      readonly values: FeatureFlagValues;
    }
  | { readonly _tag: "WaitingForIdentity" }
  | { readonly _tag: "Anonymous" }
  | {
      readonly _tag: "Loading";
      readonly distinctId: string;
    }
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

/** Minimal PostHog SDK port used by the service. */
export type BrowserFeatureFlagsPostHogClient = {
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

/** Dependencies and configuration provided at browser bootstrap. */
export type BrowserFeatureFlagsLayerOptions = {
  readonly apiHost: string;
  readonly client: BrowserFeatureFlagsPostHogClient;
  /** Every flag the app evaluates in the browser, with fallbacks. */
  readonly flags: ReadonlyArray<FeatureFlagDefinition>;
  readonly initOptions?: Omit<
    PostHogInitOptions,
    "advanced_disable_feature_flags" | "advanced_disable_feature_flags_on_first_load" | "api_host"
  >;
  readonly projectToken: string | undefined;
};

class BrowserFeatureFlagError extends Schema.TaggedError<BrowserFeatureFlagError>()(
  "BrowserFeatureFlagError",
  {
    cause: Schema.optional(Schema.Unknown),
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

function fallbackValues(flags: ReadonlyArray<FeatureFlagDefinition>): FeatureFlagValues {
  const values = new Map<string, boolean>();
  for (const flag of flags) {
    values.set(flag.key, flag.fallback);
  }
  return values;
}

function evaluationError(operation: string, cause: unknown) {
  return new BrowserFeatureFlagError({
    cause,
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}

/**
 * Effect service owning identity, evaluation, fallback, and the reactive store
 * for feature flags in the browser (compatible with `useSyncExternalStore`).
 */
export class BrowserFeatureFlags extends Context.Service<
  BrowserFeatureFlags,
  {
    /** Synchronous snapshot required by `useSyncExternalStore`. */
    readonly getSnapshot: () => BrowserFeatureFlagSnapshot;
    /** Flag catalog this instance evaluates. */
    readonly flags: ReadonlyArray<FeatureFlagDefinition>;
    /** Synchronizes a session transition and evaluates all account flags. */
    readonly synchronize: (session: BrowserFeatureFlagSession) => Effect.Effect<void>;
    /** Subscribes to snapshot changes; returns the unsubscribe callback. */
    readonly subscribe: (listener: () => void) => () => void;
  }
>()("@ayronforge/haversack/posthog/BrowserFeatureFlags") {
  /** Builds a single scoped instance of the service for the browser runtime. */
  static layer(options: BrowserFeatureFlagsLayerOptions): Layer.Layer<BrowserFeatureFlags> {
    return Layer.effect(
      BrowserFeatureFlags,
      Effect.gen(function* () {
        const effectContext = yield* Effect.context<never>();
        const catalog = options.flags;
        const projectToken = options.projectToken?.trim();
        const listeners = new Set<() => void>();
        let evaluatedDistinctId: string | undefined;
        let initialized = false;
        let requestedDistinctId: string | undefined;
        let snapshot: BrowserFeatureFlagSnapshot = projectToken
          ? { _tag: "WaitingForIdentity" }
          : {
              _tag: "Unavailable",
              reason: "not-configured",
              values: fallbackValues(catalog),
            };

        const publish = (nextSnapshot: BrowserFeatureFlagSnapshot) => {
          snapshot = nextSnapshot;
          for (const listener of listeners) listener();
        };

        const readEvaluation = Effect.fn("BrowserFeatureFlags.readEvaluation")(function* (
          context: { readonly errorsLoading?: boolean } | undefined,
        ) {
          const distinctId = options.client.get_distinct_id();
          if (!requestedDistinctId || distinctId !== requestedDistinctId) return;

          if (context?.errorsLoading) {
            evaluatedDistinctId = distinctId;
            publish({
              _tag: "Failed",
              distinctId,
              reason: "evaluation",
              values: fallbackValues(catalog),
            });
            return;
          }

          const values = yield* Effect.try({
            try: () => {
              const evaluated = new Map<string, boolean>();
              for (const flag of catalog) {
                evaluated.set(
                  flag.key,
                  options.client.isFeatureEnabled(flag.key, { fresh: true }) === true,
                );
              }
              return evaluated;
            },
            catch: (cause) => evaluationError("read", cause),
          });

          evaluatedDistinctId = distinctId;
          publish({
            _tag: "Ready",
            distinctId,
            values,
          });
        });

        if (projectToken) {
          initialized = yield* Effect.try({
            try: () => {
              options.client.init(projectToken, {
                ...options.initOptions,
                advanced_disable_feature_flags_on_first_load: true,
                api_host: options.apiHost,
              });
              return true;
            },
            catch: (cause) => evaluationError("initialize", cause),
          }).pipe(
            Effect.catchTag("BrowserFeatureFlagError", (error) =>
              Effect.logWarning("browser_feature_flags_initialization_failed", {
                operation: error.operation,
              }).pipe(Effect.as(false)),
            ),
          );

          if (!initialized) {
            snapshot = {
              _tag: "Unavailable",
              reason: "initialization-failed",
              values: fallbackValues(catalog),
            };
          }
        }

        if (initialized) {
          const onFeatureFlags: FeatureFlagsCallback = (_flags, _variants, evaluationContext) => {
            Effect.runSyncWith(effectContext)(
              readEvaluation(evaluationContext).pipe(
                Effect.catchTag("BrowserFeatureFlagError", (error) =>
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
            Effect.try({
              try: () => options.client.onFeatureFlags(onFeatureFlags),
              catch: (cause) => evaluationError("subscribe", cause),
            }).pipe(
              Effect.catchTag("BrowserFeatureFlagError", (error) =>
                Effect.gen(function* () {
                  initialized = false;
                  snapshot = {
                    _tag: "Unavailable",
                    reason: "initialization-failed",
                    values: fallbackValues(catalog),
                  };
                  yield* Effect.logWarning("browser_feature_flags_subscription_failed", {
                    operation: error.operation,
                  });
                  return () => undefined;
                }),
              ),
            ),
            (unsubscribe) =>
              Effect.try({
                try: unsubscribe,
                catch: (cause) => evaluationError("unsubscribe", cause),
              }).pipe(
                Effect.catchTag("BrowserFeatureFlagError", (error) =>
                  Effect.logWarning("browser_feature_flags_unsubscribe_failed", {
                    operation: error.operation,
                  }),
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    listeners.clear();
                  }),
                ),
              ),
          );
        }

        const reset = Effect.fn("BrowserFeatureFlags.reset")(function* () {
          if (!initialized) return;

          requestedDistinctId = undefined;
          evaluatedDistinctId = undefined;
          publish({ _tag: "Anonymous" });
          yield* Effect.try({
            try: () => options.client.reset(),
            catch: (cause) => evaluationError("reset", cause),
          }).pipe(
            Effect.catchTag("BrowserFeatureFlagError", (error) =>
              Effect.logWarning("browser_feature_flags_reset_failed", {
                operation: error.operation,
              }),
            ),
          );
        });

        const identify = Effect.fn("BrowserFeatureFlags.identify")(function* (
          identity: BrowserFeatureFlagIdentity,
        ) {
          if (!initialized) return;

          requestedDistinctId = identity.distinctId;
          if (evaluatedDistinctId !== identity.distinctId) {
            publish({
              _tag: "Loading",
              distinctId: identity.distinctId,
            });
          }

          yield* Effect.try({
            try: () => {
              options.client.identify(identity.distinctId, identity.personProperties);
              options.client.reloadFeatureFlags();
            },
            catch: (cause) => evaluationError("identify", cause),
          }).pipe(
            Effect.catchTag("BrowserFeatureFlagError", (error) =>
              Effect.sync(() => {
                evaluatedDistinctId = identity.distinctId;
                publish({
                  _tag: "Failed",
                  distinctId: identity.distinctId,
                  reason: error.operation,
                  values: fallbackValues(catalog),
                });
              }),
            ),
          );
        });

        const synchronize = Effect.fn("BrowserFeatureFlags.synchronize")(function* (
          session: BrowserFeatureFlagSession,
        ) {
          switch (session._tag) {
            case "Pending":
              if (initialized) {
                requestedDistinctId = undefined;
                evaluatedDistinctId = undefined;
                publish({ _tag: "WaitingForIdentity" });
              }
              return;
            case "Anonymous":
              return yield* reset();
            case "Authenticated":
              return yield* identify(session.identity);
          }
        });

        return BrowserFeatureFlags.of({
          getSnapshot: () => snapshot,
          flags: catalog,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          synchronize,
        });
      }),
    );
  }
}

/** Concrete implementation stored behind the `BrowserFeatureFlags` tag. */
export type BrowserFeatureFlagsService = Context.Service.Shape<typeof BrowserFeatureFlags>;

/** Inert service serving static fallbacks, for when the layer fails to build. */
export function unavailableBrowserFeatureFlags(
  flags: ReadonlyArray<FeatureFlagDefinition>,
): BrowserFeatureFlagsService {
  const snapshot: BrowserFeatureFlagSnapshot = {
    _tag: "Unavailable",
    reason: "initialization-failed",
    values: fallbackValues(flags),
  };
  return BrowserFeatureFlags.of({
    getSnapshot: () => snapshot,
    flags,
    subscribe: () => () => undefined,
    synchronize: () => Effect.void,
  });
}
