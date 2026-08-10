import type { DurableObjectNamespace, Rpc } from "@cloudflare/workers-types";
import { Context, Data, Effect, Layer } from "effect";

const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1_000;

/**
 * RPC surface a caller-owned Durable Object must implement for
 * {@link DistributedLock}.
 *
 * `acquire` must wait until the lease is free or expired. `release` must only
 * release a lease owned by the supplied owner and should otherwise be
 * idempotent.
 */
export interface DistributedLockRpc extends Rpc.DurableObjectBranded {
  acquire(owner: string, ttlMs: number): Promise<void>;
  release(owner: string): Promise<void>;
}

/** Options for the Durable Object-backed distributed lock layer. */
export type DistributedLockLayerOptions = {
  /** Lease duration. Expiration prevents abandoned owners from blocking forever. */
  readonly ttlMs?: number | undefined;
};

/** Expected failure while acquiring a distributed lock. */
export class DistributedLockError extends Data.TaggedError("DistributedLockError")<{
  readonly cause: unknown;
  readonly key: string;
  readonly operation: "acquire";
}> {}

/** Effect service providing a keyed distributed mutex. */
export class DistributedLock extends Context.Service<
  DistributedLock,
  {
    readonly withLock: <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DistributedLockError, R>;
  }
>()("@ayronforge/haversack/cf/DistributedLock") {
  /** Builds the lock service from a Durable Object namespace binding. */
  static layer(
    namespace: DurableObjectNamespace<DistributedLockRpc>,
    options: DistributedLockLayerOptions = {},
  ): Layer.Layer<DistributedLock> {
    const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;

    return Layer.succeed(
      DistributedLock,
      DistributedLock.of({
        withLock: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: async () => {
                const owner = crypto.randomUUID();
                const stub = namespace.getByName(key);
                await stub.acquire(owner, ttlMs);
                return { owner, stub };
              },
              catch: (cause) => new DistributedLockError({ cause, key, operation: "acquire" }),
            }),
            () => effect,
            ({ owner, stub }) =>
              Effect.tryPromise({
                try: () => stub.release(owner),
                catch: (cause) => cause,
              }).pipe(Effect.orDie),
          ),
      }),
    );
  }
}

/** Runs an effect while holding the distributed lock identified by `key`. */
export function withLock<A, E, R>(
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DistributedLockError, R | DistributedLock> {
  return Effect.flatMap(DistributedLock, (locks) => locks.withLock(key, effect));
}
