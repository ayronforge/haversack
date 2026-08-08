import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

import { PostHogConfig } from "./config.ts";

export type FeatureFlagDefinition = {
  /** Flag key as configured in PostHog. */
  readonly key: string;
  /** Value used when PostHog is not configured or evaluation fails. */
  readonly fallback: boolean;
};

export type FeatureFlagEvaluationContext = {
  readonly distinctId: string;
  readonly personProperties?: Readonly<Record<string, string>> | undefined;
};

const PostHogFlagSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

const PostHogFlagsResponseSchema = Schema.Struct({
  flags: Schema.optional(Schema.Record(Schema.String, PostHogFlagSchema)),
});

class FeatureFlagEvaluationError extends Data.TaggedError("FeatureFlagEvaluationError")<{
  readonly reason: string;
  readonly status?: number | undefined;
}> {}

const asEvaluationError = (cause: unknown) =>
  new FeatureFlagEvaluationError({
    reason: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Server-side feature flag evaluation against PostHog's `/flags?v=2` endpoint.
 * Fail-open: evaluation errors log a warning and resolve to the fallback.
 */
export class FeatureFlags extends Context.Service<
  FeatureFlags,
  {
    readonly isEnabled: (
      flag: FeatureFlagDefinition,
      context: FeatureFlagEvaluationContext,
    ) => Effect.Effect<boolean>;
  }
>()("@ayronforge/haversack/posthog/FeatureFlags") {
  static readonly layer: Layer.Layer<FeatureFlags, never, PostHogConfig> = Layer.effect(
    FeatureFlags,
    Effect.gen(function* () {
      const config = yield* PostHogConfig;

      const evaluate = (flag: FeatureFlagDefinition, context: FeatureFlagEvaluationContext) =>
        Effect.gen(function* () {
          const projectToken = config.projectToken;
          if (!projectToken) return flag.fallback;

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.host}/flags?v=2`, {
                body: JSON.stringify({
                  distinct_id: context.distinctId,
                  groups: {},
                  person_properties: context.personProperties,
                  token: Redacted.value(projectToken),
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
                signal: AbortSignal.timeout(2_000),
              }),
            catch: asEvaluationError,
          });

          if (!response.ok) {
            return yield* new FeatureFlagEvaluationError({
              reason: `PostHog returned ${response.status}`,
              status: response.status,
            });
          }

          const rawBody = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: asEvaluationError,
          });
          const body = yield* Schema.decodeUnknownEffect(PostHogFlagsResponseSchema)(rawBody).pipe(
            Effect.mapError(asEvaluationError),
          );

          // A flag absent from the response is inactive in PostHog, not a failure.
          return body.flags?.[flag.key]?.enabled === true;
        });

      const isEnabled = Effect.fn("FeatureFlags.isEnabled")(function* (
        flag: FeatureFlagDefinition,
        context: FeatureFlagEvaluationContext,
      ) {
        return yield* Effect.catchTag(
          evaluate(flag, context),
          "FeatureFlagEvaluationError",
          (error) =>
            Effect.logWarning("feature_flag_evaluation_failed", {
              flag: flag.key,
              reason: error.reason,
              status: error.status,
            }).pipe(Effect.as(flag.fallback)),
        );
      });

      return FeatureFlags.of({ isEnabled });
    }),
  );
}
