import { Context, Data, Effect, Layer, Redacted } from "effect";

import { PostHogConfig } from "./config.ts";

export type TrackInput = {
  readonly event: string;
  readonly distinctId: string;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
};

class PostHogCaptureError extends Data.TaggedError("PostHogCaptureError")<{
  readonly reason: string;
  readonly status?: number | undefined;
}> {}

/**
 * Server-side event capture against PostHog's `/capture/` endpoint via fetch.
 * Fail-open: delivery failures are logged, never raised, so tracking can never
 * break a request.
 */
export class PostHogAnalytics extends Context.Service<
  PostHogAnalytics,
  {
    readonly track: (input: TrackInput) => Effect.Effect<void>;
  }
>()("@ayronforge/haversack/posthog/PostHogAnalytics") {
  static readonly layer: Layer.Layer<PostHogAnalytics, never, PostHogConfig> = Layer.effect(
    PostHogAnalytics,
    Effect.gen(function* () {
      const config = yield* PostHogConfig;

      const deliver = (input: TrackInput) =>
        Effect.gen(function* () {
          const projectToken = config.projectToken;
          if (!projectToken) return;

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.host}/capture/`, {
                body: JSON.stringify({
                  api_key: Redacted.value(projectToken),
                  distinct_id: input.distinctId,
                  event: input.event,
                  properties: input.properties ?? {},
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
                signal: AbortSignal.timeout(2_000),
              }),
            catch: (cause) =>
              new PostHogCaptureError({
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          });

          if (!response.ok) {
            return yield* new PostHogCaptureError({
              reason: `PostHog returned ${response.status}`,
              status: response.status,
            });
          }
        });

      const track = Effect.fn("PostHogAnalytics.track")(function* (input: TrackInput) {
        yield* Effect.catchTag(deliver(input), "PostHogCaptureError", (error) =>
          Effect.logWarning("posthog_capture_dropped", {
            analyticsEvent: input.event,
            reason: error.reason,
            status: error.status,
          }),
        );
      });

      return PostHogAnalytics.of({ track });
    }),
  );

  /** Discards every event. Useful for tests and disabled environments. */
  static readonly noop: Layer.Layer<PostHogAnalytics> = Layer.succeed(
    PostHogAnalytics,
    PostHogAnalytics.of({ track: () => Effect.void }),
  );
}
