import type { Queue } from "@cloudflare/workers-types";
import { Data, Effect } from "effect";

const QUEUE_SEND_BATCH_SIZE = 100;

/** Expected failure while publishing messages to a Cloudflare Queue. */
export class QueueClientError extends Data.TaggedError("QueueClientError")<{
  readonly cause: unknown;
  readonly messageCount: number;
}> {}

/**
 * Shape of a queue producer service. Declare one tag per queue in your app,
 * carrying that queue's message type, and build it with
 * {@link makeQueueClientService}:
 *
 * ```ts
 * class JobQueue extends Context.Service<JobQueue, QueueClientService<JobMessage>>()(
 *   "app/JobQueue",
 * ) {
 *   static readonly layer = (queue: Queue<JobMessage>) =>
 *     Layer.succeed(JobQueue, makeQueueClientService(queue));
 * }
 * ```
 */
export type QueueClientService<T> = {
  readonly send: (messages: ReadonlyArray<T>) => Effect.Effect<void, QueueClientError>;
};

/**
 * Builds a queue producer from a Cloudflare Queue binding. Publishes in
 * Cloudflare's 100-message batches.
 */
export function makeQueueClientService<T>(queue: Queue<T>): QueueClientService<T> {
  const send = Effect.fn("QueueClient.send")(function* (messages: ReadonlyArray<T>) {
    for (let start = 0; start < messages.length; start += QUEUE_SEND_BATCH_SIZE) {
      const batch = messages.slice(start, start + QUEUE_SEND_BATCH_SIZE);
      yield* Effect.tryPromise({
        try: () => queue.sendBatch(batch.map((body) => ({ body }))),
        catch: (cause) => new QueueClientError({ cause, messageCount: batch.length }),
      });
    }
  });

  return { send };
}
