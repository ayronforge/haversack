import { DurableObject } from "cloudflare:workers";

type LockState = {
  readonly expiresAt: number;
  readonly owner: string;
};

const LOCK_KEY = "distributed-lock";

/** Durable Object coordination atom backing the distributed lock service. */
export class LockBucket extends DurableObject {
  readonly #waiters = new Set<() => void>();

  /** Waits until the lock is free, expired, or already owned by this owner. */
  async acquire(owner: string, ttlMs: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      const current = await this.ctx.storage.get<LockState>(LOCK_KEY);
      if (!current || current.expiresAt <= now || current.owner === owner) {
        await this.ctx.storage.put(LOCK_KEY, { expiresAt: now + ttlMs, owner });
        return;
      }

      await this.waitForRelease(current.expiresAt - now);
    }
  }

  /** Releases the lock only when the supplied owner currently holds it. */
  async release(owner: string): Promise<void> {
    const current = await this.ctx.storage.get<LockState>(LOCK_KEY);
    if (current?.owner !== owner) return;

    await this.ctx.storage.delete(LOCK_KEY);
    this.notifyWaiters();
  }

  private waitForRelease(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      this.#waiters.add(done);
      timer = setTimeout(done, Math.max(1, timeoutMs));
    });
  }

  private notifyWaiters(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }
}
