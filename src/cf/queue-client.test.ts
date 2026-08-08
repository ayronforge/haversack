import { describe, expect, test } from "bun:test";

import type { MessageSendRequest, Queue } from "@cloudflare/workers-types";
import { Context, Effect, Layer } from "effect";

import { testStub } from "../testing/test-stub.ts";
import { makeQueueClientService, type QueueClientService } from "./queue-client.ts";

type TestMessage = number;

class TestQueue extends Context.Service<TestQueue, QueueClientService<TestMessage>>()(
  "test/TestQueue",
) {
  static readonly layer = (queue: Queue<TestMessage>): Layer.Layer<TestQueue> =>
    Layer.succeed(TestQueue, makeQueueClientService(queue));
}

describe("QueueClient", () => {
  test("sends messages in batches of at most 100 through the service tag", async () => {
    const batches: Array<ReadonlyArray<MessageSendRequest<TestMessage>>> = [];
    const queue = testStub<Queue<TestMessage>>({
      sendBatch: async (messages: Iterable<MessageSendRequest<TestMessage>>) => {
        batches.push([...messages]);
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* TestQueue;
        yield* client.send(Array.from({ length: 205 }, (_, index) => index));
      }).pipe(Effect.provide(TestQueue.layer(queue))) as Effect.Effect<void>,
    );

    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flatMap((batch) => batch.map((message) => message.body))).toEqual(
      Array.from({ length: 205 }, (_, index) => index),
    );
  });

  test("does not call the binding for an empty input", async () => {
    let calls = 0;
    const queue = testStub<Queue<TestMessage>>({
      sendBatch: async () => {
        calls += 1;
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* TestQueue;
        yield* client.send([]);
      }).pipe(Effect.provide(TestQueue.layer(queue))) as Effect.Effect<void>,
    );

    expect(calls).toBe(0);
  });
});
