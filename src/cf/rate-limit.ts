import type { DurableObjectNamespace, Rpc } from "@cloudflare/workers-types";
import { Context, Data, Duration, Effect, Layer } from "effect";
import { RateLimiter as EffectRateLimiter } from "effect/unstable/persistence";

/** Caller-owned rate-limit policy. */
export type RateLimitPolicy = {
  readonly algorithm: "fixed-window" | "token-bucket";
  readonly limit: number;
  readonly window: Duration.Input;
};

/** Input for one request-rate-limit decision. */
export type RequestRateLimitInput = {
  readonly key: string;
  readonly policy: RateLimitPolicy;
  readonly tokens?: number | undefined;
};

/** DTO accepted by the rate-limit Durable Object fixed-window RPC. */
export type RateLimitFixedWindowInput = {
  readonly limit: number | undefined;
  readonly refillRateMs: number;
  readonly tokens: number;
};

/** DTO accepted by the rate-limit Durable Object token-bucket RPC. */
export type RateLimitTokenBucketInput = {
  readonly allowOverflow: boolean;
  readonly limit: number;
  readonly refillRateMs: number;
  readonly tokens: number;
};

/** Expected failure when a request exceeds its caller-supplied policy. */
export class RequestRateLimitExceeded extends Data.TaggedError("RequestRateLimitExceeded")<{
  readonly key: string;
  readonly limit: number;
  readonly retryAfterMs: number;
}> {}

/**
 * RPC surface a caller-owned Durable Object must implement for
 * {@link RequestRateLimiter}.
 *
 * The methods mirror the fixed-window and token-bucket store semantics from
 * `effect/unstable/persistence`. Implementations own persistence, migrations,
 * cleanup, and concurrency control.
 */
export interface RateLimiterRpc extends Rpc.DurableObjectBranded {
  /**
   * Returns the count after consuming `tokens` and the remaining TTL in
   * milliseconds. When `limit` would be exceeded, return a count greater than
   * the limit without extending the stored TTL.
   */
  fixedWindow(input: RateLimitFixedWindowInput): Promise<readonly [count: number, ttl: number]>;

  /**
   * Returns the remaining token count after consumption. Without overflow, a
   * negative result reports rejection but must not persist a negative balance.
   */
  tokenBucket(input: RateLimitTokenBucketInput): Promise<number>;
}

/** Generic request rate limiter with fail-open backing-store semantics. */
export class RequestRateLimiter extends Context.Service<
  RequestRateLimiter,
  {
    readonly limit: (input: RequestRateLimitInput) => Effect.Effect<void, RequestRateLimitExceeded>;
  }
>()("@ayronforge/haversack/cf/RequestRateLimiter") {
  /** Builds the service from an Effect persistence RateLimiter. */
  static readonly layer: Layer.Layer<RequestRateLimiter, never, EffectRateLimiter.RateLimiter> =
    Layer.effect(
      RequestRateLimiter,
      Effect.gen(function* () {
        const limiter = yield* EffectRateLimiter.RateLimiter;

        const limit = Effect.fn("RequestRateLimiter.limit")(function* (
          input: RequestRateLimitInput,
        ) {
          yield* limiter
            .consume({
              algorithm: input.policy.algorithm,
              key: input.key,
              limit: input.policy.limit,
              onExceeded: "fail",
              tokens: input.tokens,
              window: input.policy.window,
            })
            .pipe(
              Effect.asVoid,
              Effect.catch((error) => handleRateLimitError(input, error)),
            );
        });

        return RequestRateLimiter.of({ limit });
      }),
    );

  /** Process-local in-memory implementation, useful for tests and one isolate. */
  static readonly layerMemory: Layer.Layer<RequestRateLimiter> = RequestRateLimiter.layer.pipe(
    Layer.provide(EffectRateLimiter.layer),
    Layer.provide(EffectRateLimiter.layerStoreMemory),
  );

  /**
   * Shared implementation backed by a caller-owned Durable Object satisfying
   * {@link RateLimiterRpc}.
   */
  static layerDurableObject(
    namespace: DurableObjectNamespace<RateLimiterRpc>,
  ): Layer.Layer<RequestRateLimiter> {
    return RequestRateLimiter.layer.pipe(
      Layer.provide(EffectRateLimiter.layer),
      Layer.provide(makeDurableObjectStoreLayer(namespace)),
    );
  }
}

function makeDurableObjectStoreLayer(
  namespace: DurableObjectNamespace<RateLimiterRpc>,
): Layer.Layer<EffectRateLimiter.RateLimiterStore> {
  return Layer.succeed(
    EffectRateLimiter.RateLimiterStore,
    EffectRateLimiter.RateLimiterStore.of({
      fixedWindow: (options) =>
        callRateLimiter(namespace, options.key, async (limiter) => {
          // The RPC boundary widens the tuple to `number[]`; restore its shape.
          const [count = 0, ttl = 0] = await limiter.fixedWindow({
            limit: options.limit,
            refillRateMs: Duration.toMillis(options.refillRate),
            tokens: options.tokens,
          });
          return [count, ttl] as const;
        }),
      tokenBucket: (options) =>
        callRateLimiter(namespace, options.key, (limiter) =>
          limiter.tokenBucket({
            allowOverflow: options.allowOverflow,
            limit: options.limit,
            refillRateMs: Duration.toMillis(options.refillRate),
            tokens: options.tokens,
          }),
        ),
      adaptiveConsume: () => unsupportedAdaptiveOperation("adaptiveConsume"),
      adaptiveFeedback: () => unsupportedAdaptiveOperation("adaptiveFeedback"),
    }),
  );
}

function unsupportedAdaptiveOperation(operation: string) {
  return Effect.fail(
    new EffectRateLimiter.RateLimiterError({
      reason: new EffectRateLimiter.RateLimitStoreError({
        message: `Durable Object rate limiting store does not support ${operation}`,
      }),
    }),
  );
}

function callRateLimiter<A>(
  namespace: DurableObjectNamespace<RateLimiterRpc>,
  key: string,
  call: (limiter: ReturnType<DurableObjectNamespace<RateLimiterRpc>["getByName"]>) => Promise<A>,
) {
  return Effect.tryPromise({
    try: () => call(namespace.getByName(key)),
    catch: (cause) =>
      new EffectRateLimiter.RateLimiterError({
        reason: new EffectRateLimiter.RateLimitStoreError({
          cause,
          message: "Failed to execute Durable Object rate limiting store command",
        }),
      }),
  });
}

function handleRateLimitError(
  input: RequestRateLimitInput,
  error: EffectRateLimiter.RateLimiterError,
): Effect.Effect<void, RequestRateLimitExceeded> {
  if (error.reason._tag === "RateLimitExceeded") {
    return Effect.fail(
      new RequestRateLimitExceeded({
        key: input.key,
        limit: error.reason.limit,
        retryAfterMs: Duration.toMillis(error.reason.retryAfter),
      }),
    );
  }

  return Effect.logWarning("rate_limit_store_failed_open", {
    errorType: error.reason.cause instanceof Error ? error.reason.cause.name : "unknown",
    message: error.reason.message,
  });
}
