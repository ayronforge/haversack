import { describe, expect, test } from "bun:test";

import { Effect, Option, Redacted } from "effect";

import { BlobPresigner, BlobReadLimitExceeded, BlobStorage } from "../contracts/blob-storage.ts";
import { S3BlobPresignerLive, S3BlobStorageLive, S3Config } from "./s3.ts";

const testConfig = S3Config.layer({
  accessKeyId: "access_key",
  secretAccessKey: Redacted.make("secret_key"),
  bucket: "uploads",
  region: "us-east-1",
  retries: 0,
});

const withFetch = async <A>(fake: typeof fetch, run: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const run = <A, E>(effect: Effect.Effect<A, E, BlobStorage>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(S3BlobStorageLive), Effect.provide(testConfig)) as Effect.Effect<
      A,
      E
    >,
  );

describe("S3 BlobStorage", () => {
  test("signs requests against the virtual-hosted bucket URL", async () => {
    const requests: Array<{ url: string; method: string; auth: string | null }> = [];
    await withFetch(
      (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push({
          url: request.url,
          method: request.method,
          auth: request.headers.get("authorization"),
        });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      () =>
        run(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            yield* storage.put("a.txt", "hello", { contentType: "text/plain" });
          }),
        ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(requests[0]!.url).toBe("https://uploads.s3.us-east-1.amazonaws.com/a.txt");
    expect(requests[0]!.auth).toContain("AWS4-HMAC-SHA256");
  });

  test("get returns none on 404 and decodes bodies on 200", async () => {
    await withFetch(
      (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/missing.txt")) return new Response(null, { status: 404 });
        return new Response("content", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }) as typeof fetch,
      () =>
        run(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            expect(Option.isNone(yield* storage.get("missing.txt"))).toBe(true);

            const object = yield* storage.get("present.txt");
            expect(Option.isSome(object)).toBe(true);
            if (Option.isSome(object)) {
              expect(new TextDecoder().decode(object.value.body)).toBe("content");
              expect(object.value.contentType).toBe("text/plain");
            }
          }),
        ),
    );
  });

  test("list parses keys from ListObjectsV2 XML", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><Contents><Key>a.txt</Key></Contents><Contents><Key>dir/b &amp; c.txt</Key></Contents></ListBucketResult>`;
    const keys = await withFetch(
      (async () => new Response(xml, { status: 200 })) as typeof fetch,
      () =>
        run(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            return yield* storage.list({ prefix: "" });
          }),
        ),
    );
    expect(keys).toEqual(["a.txt", "dir/b & c.txt"]);
  });

  test("rejects an oversized body from Content-Length", async () => {
    let bodyCanceled = false;
    const error = await withFetch(
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCanceled = true;
            },
          }),
          {
            status: 200,
            headers: { "Content-Length": "7" },
          },
        )) as typeof fetch,
      () =>
        run(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            return yield* Effect.flip(storage.get("large.txt", { maxBytes: 6 }));
          }),
        ),
    );

    expect(error).toEqual(
      new BlobReadLimitExceeded({ key: "large.txt", maxBytes: 6, actualBytes: 7 }),
    );
    expect(bodyCanceled).toBe(true);
  });

  test("enforces maxBytes while streaming when Content-Length is absent", async () => {
    let bodyCanceled = false;
    let pulls = 0;
    const error = await withFetch(
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(
                pulls === 1 ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5, 6]),
              );
            },
            cancel() {
              bodyCanceled = true;
            },
          }),
          { status: 200 },
        )) as typeof fetch,
      () =>
        run(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            return yield* Effect.flip(storage.get("stream.bin", { maxBytes: 5 }));
          }),
        ),
    );

    expect(error).toEqual(
      new BlobReadLimitExceeded({ key: "stream.bin", maxBytes: 5, actualBytes: 6 }),
    );
    expect(bodyCanceled).toBe(true);
  });

  test("propagates BlobStorageError on server errors", async () => {
    const exit = await withFetch(
      (async () => new Response("boom", { status: 500 })) as typeof fetch,
      () =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            const storage = yield* BlobStorage;
            yield* storage.put("a.txt", "x");
          }).pipe(Effect.provide(S3BlobStorageLive), Effect.provide(testConfig)) as Effect.Effect<
            void,
            unknown
          >,
        ),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("S3 BlobPresigner", () => {
  test("creates a SigV4 PUT URL without network access", async () => {
    let fetchCalls = 0;
    const signed = await withFetch(
      (async () => {
        fetchCalls += 1;
        return new Response(null);
      }) as typeof fetch,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const presigner = yield* BlobPresigner;
            return yield* presigner.presignPut({
              key: "a.png",
              contentType: "image/png",
              expiresInSeconds: 600,
            });
          }).pipe(
            Effect.provide(S3BlobPresignerLive),
            Effect.provide(testConfig),
          ) as Effect.Effect<string>,
        ),
    );

    expect(fetchCalls).toBe(0);
    const url = new URL(signed);
    expect(url.hostname).toBe("uploads.s3.us-east-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
