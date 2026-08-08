import { DurableObject } from "cloudflare:workers";

import type { RateLimitFixedWindowInput, RateLimitTokenBucketInput } from "./rate-limit.ts";

type FixedWindowState = {
  readonly count: number;
  readonly expiresAt: number;
};

type TokenBucketState = {
  readonly expiresAt: number;
  readonly lastRefill: number;
  readonly tokens: number;
};

const FIXED_WINDOW_KEY = "fixed-window";
const TOKEN_BUCKET_KEY = "token-bucket";
const CLEANUP_ALARM_MIN_DELAY_MS = 1_000;

/**
 * Durable Object implementing fixed-window and token-bucket state atomically.
 * The namespace must use the SQLite storage backend because this class relies
 * on synchronous KV transactions.
 */
export class RateLimitBucket extends DurableObject {
  /** Consumes fixed-window tokens and returns the resulting count and TTL. */
  async fixedWindow(
    input: RateLimitFixedWindowInput,
  ): Promise<readonly [count: number, ttl: number]> {
    const { expiresAt, result, shouldScheduleCleanup } = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      let counter = this.ctx.storage.kv.get<FixedWindowState>(FIXED_WINDOW_KEY);

      if (!counter || counter.expiresAt <= now) {
        counter = { count: 0, expiresAt: now };
      }

      const nextCount = counter.count + input.tokens;
      if (input.limit !== undefined && nextCount > input.limit) {
        return {
          expiresAt: counter.expiresAt,
          result: [nextCount, Math.max(0, counter.expiresAt - now)] as const,
          shouldScheduleCleanup: false,
        };
      }

      const expiresAt = counter.expiresAt + input.refillRateMs * input.tokens;
      this.ctx.storage.kv.put(FIXED_WINDOW_KEY, { count: nextCount, expiresAt });

      return {
        expiresAt,
        result: [nextCount, Math.max(0, expiresAt - now)] as const,
        shouldScheduleCleanup: true,
      };
    });

    if (shouldScheduleCleanup) this.scheduleCleanupAlarm(expiresAt);
    return result;
  }

  /** Consumes token-bucket tokens and returns the remaining token count. */
  async tokenBucket(input: RateLimitTokenBucketInput): Promise<number> {
    const { expiresAt, nextTokens } = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      let bucket = this.ctx.storage.kv.get<TokenBucketState>(TOKEN_BUCKET_KEY);

      if (!bucket) {
        bucket = { expiresAt: now, lastRefill: now, tokens: input.limit };
      }

      const elapsed = now - bucket.lastRefill;
      const tokensToAdd = Math.floor(elapsed / input.refillRateMs);
      if (tokensToAdd > 0) {
        bucket = {
          expiresAt: bucket.expiresAt,
          lastRefill: bucket.lastRefill + tokensToAdd * input.refillRateMs,
          tokens: Math.min(input.limit, bucket.tokens + tokensToAdd),
        };
      }

      const nextTokens = bucket.tokens - input.tokens;
      const storedTokens = input.allowOverflow || nextTokens >= 0 ? nextTokens : bucket.tokens;
      const expiresAt =
        now + Math.max(1, Math.floor((input.limit - storedTokens) * input.refillRateMs));

      this.ctx.storage.kv.put(TOKEN_BUCKET_KEY, {
        expiresAt,
        lastRefill: bucket.lastRefill,
        tokens: storedTokens,
      });

      return { expiresAt, nextTokens };
    });

    this.scheduleCleanupAlarm(expiresAt);
    return nextTokens;
  }

  /** Removes expired state and reschedules cleanup for the next live bucket. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const nextAlarm = this.ctx.storage.transactionSync(() => {
      let nextAlarm: number | undefined;

      const fixedWindow = this.ctx.storage.kv.get<FixedWindowState>(FIXED_WINDOW_KEY);
      if (fixedWindow) {
        if (fixedWindow.expiresAt <= now) {
          this.ctx.storage.kv.delete(FIXED_WINDOW_KEY);
        } else {
          nextAlarm = fixedWindow.expiresAt;
        }
      }

      const tokenBucket = this.ctx.storage.kv.get<TokenBucketState>(TOKEN_BUCKET_KEY);
      if (tokenBucket) {
        if (tokenBucket.expiresAt <= now) {
          this.ctx.storage.kv.delete(TOKEN_BUCKET_KEY);
        } else {
          nextAlarm = Math.min(nextAlarm ?? tokenBucket.expiresAt, tokenBucket.expiresAt);
        }
      }

      return nextAlarm;
    });

    if (nextAlarm !== undefined) {
      await this.ctx.storage.setAlarm(cleanupAlarmTime(nextAlarm));
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }

  private scheduleCleanupAlarm(expiresAt: number): void {
    this.ctx.waitUntil(
      this.ctx.storage
        .setAlarm(cleanupAlarmTime(expiresAt), { allowUnconfirmed: true })
        .catch((cause: unknown) => {
          console.warn(
            JSON.stringify({
              errorType: cause instanceof Error ? cause.name : typeof cause,
              event: "rate_limit_bucket_cleanup_alarm_failed",
              message: "Failed to schedule rate limit bucket cleanup alarm.",
            }),
          );
        }),
    );
  }
}

function cleanupAlarmTime(expiresAt: number, now = Date.now()): number {
  return Math.max(Math.ceil(expiresAt), now + CLEANUP_ALARM_MIN_DELAY_MS);
}
