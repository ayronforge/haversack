import { describe, expect, test } from "bun:test";

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { Effect } from "effect";

import { testStub } from "../testing/test-stub.ts";
import { DistributedLock, withLock } from "./distributed-lock.ts";

describe("DistributedLock", () => {
  test("acquires and releases the key around the effect", async () => {
    const events: Array<string> = [];
    const namespace = testStub<DurableObjectNamespace>({
      getByName: (key: string) => ({
        acquire: async (owner: string, ttlMs: number) => {
          events.push(`acquire:${key}:${owner}:${ttlMs}`);
        },
        release: async (owner: string) => {
          events.push(`release:${key}:${owner}`);
        },
      }),
    });

    const value = await Effect.runPromise(
      withLock(
        "document:42",
        Effect.sync(() => {
          events.push("use");
          return 42;
        }),
      ).pipe(Effect.provide(DistributedLock.layer(namespace, { ttlMs: 2_000 }))),
    );

    expect(value).toBe(42);
    expect(events).toHaveLength(3);
    expect(events[0]?.startsWith("acquire:document:42:")).toBe(true);
    expect(events[0]?.endsWith(":2000")).toBe(true);
    expect(events[1]).toBe("use");
    const owner = events[0]?.split(":")[3];
    expect(events[2]).toBe(`release:document:42:${owner}`);
  });

  test("releases the lock when the protected effect fails", async () => {
    let released = false;
    const namespace = testStub<DurableObjectNamespace>({
      getByName: () => ({
        acquire: async () => undefined,
        release: async () => {
          released = true;
        },
      }),
    });

    await Effect.runPromise(
      Effect.flip(
        withLock("document:failed", Effect.fail("failed")).pipe(
          Effect.provide(DistributedLock.layer(namespace)),
        ),
      ),
    );

    expect(released).toBe(true);
  });
});
