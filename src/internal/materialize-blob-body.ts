import { Effect, Stream } from "effect";

import { BlobReadLimitExceeded, BlobStorageError } from "../contracts/blob-storage.ts";

type MaterializeBlobBodyOptions = {
  readonly key: string;
  readonly knownSize?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly stream: ReadableStream<Uint8Array> | null;
};

/** Materializes a blob stream while preserving the caller's in-memory limit. */
export function materializeBlobBody({
  key,
  knownSize,
  maxBytes,
  stream,
}: MaterializeBlobBodyOptions): Effect.Effect<
  Uint8Array,
  BlobReadLimitExceeded | BlobStorageError
> {
  if (stream === null) return Effect.succeed(new Uint8Array());

  if (maxBytes !== undefined && knownSize !== undefined && knownSize > maxBytes) {
    return cancelBody(stream).pipe(
      Effect.andThen(
        Effect.fail(new BlobReadLimitExceeded({ key, maxBytes, actualBytes: knownSize })),
      ),
    );
  }

  return Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (cause) => new BlobStorageError({ operation: "get", key, cause }),
  }).pipe(
    Stream.mapAccumEffect(
      () => 0,
      (totalBytes, chunk) => {
        const nextTotalBytes = totalBytes + chunk.byteLength;
        if (maxBytes !== undefined && nextTotalBytes > maxBytes) {
          return Effect.fail(
            new BlobReadLimitExceeded({ key, maxBytes, actualBytes: nextTotalBytes }),
          );
        }
        return Effect.succeed([nextTotalBytes, [chunk]] as const);
      },
    ),
    Stream.runCollect,
    Effect.map(concatenateChunks),
  );
}

function cancelBody(stream: ReadableStream<Uint8Array>): Effect.Effect<void> {
  return Effect.tryPromise(() => stream.cancel()).pipe(Effect.ignore);
}

function concatenateChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
