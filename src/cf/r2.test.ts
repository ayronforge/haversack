import { describe, expect, test } from "bun:test";

import type { R2Bucket } from "@cloudflare/workers-types";
import { Effect, Option, Redacted, Result } from "effect";

import { BlobPresigner, BlobReadLimitExceeded, BlobStorage } from "../contracts/blob-storage.ts";
import { testStub } from "../testing/test-stub.ts";
import { makeR2BlobStorageLayer, R2BlobPresignerLive, R2PresignerConfig } from "./r2.ts";

describe("R2 BlobStorage", () => {
  const objects = new Map<string, { body: string; contentType?: string }>();
  const fakeBucket = testStub<R2Bucket>({
    put: async (
      key: string,
      body: string,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const stored = objects.get(key);
      if (!stored) return null;
      const bytes = new TextEncoder().encode(stored.body);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        httpMetadata: { contentType: stored.contentType },
        size: bytes.byteLength,
      };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    head: async (key: string) => (objects.has(key) ? {} : null),
    list: async (options?: { prefix?: string }) => ({
      objects: [...objects.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((key) => ({ key })),
    }),
  });

  const layer = makeR2BlobStorageLayer(fakeBucket);

  const run = <A, E>(effect: Effect.Effect<A, E, BlobStorage>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);

  test("put, exists, get, list, delete round-trip", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* BlobStorage;
        yield* storage.put("docs/a.txt", "hello", { contentType: "text/plain" });

        expect(yield* storage.exists("docs/a.txt")).toBe(true);
        expect(yield* storage.exists("missing")).toBe(false);

        const object = yield* storage.get("docs/a.txt", { maxBytes: 5 });
        expect(Option.isSome(object)).toBe(true);
        if (Option.isSome(object)) {
          expect(new TextDecoder().decode(object.value.body)).toBe("hello");
          expect(object.value.contentType).toBe("text/plain");
        }

        expect(yield* storage.list({ prefix: "docs/" })).toEqual(["docs/a.txt"]);

        yield* storage.delete("docs/a.txt");
        expect(Option.isNone(yield* storage.get("docs/a.txt"))).toBe(true);
      }),
    );
  });

  test("rejects an oversized object before materializing its body", async () => {
    let bodyCanceled = false;
    const oversizedBucket = testStub<R2Bucket>({
      get: async () => ({
        body: new ReadableStream<Uint8Array>({
          cancel() {
            bodyCanceled = true;
          },
        }),
        httpMetadata: {},
        size: 6,
      }),
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* BlobStorage;
        return yield* Effect.flip(storage.get("large.bin", { maxBytes: 5 }));
      }).pipe(
        Effect.provide(makeR2BlobStorageLayer(oversizedBucket)),
      ) as Effect.Effect<BlobReadLimitExceeded>,
    );

    expect(error).toEqual(
      new BlobReadLimitExceeded({ key: "large.bin", maxBytes: 5, actualBytes: 6 }),
    );
    expect(bodyCanceled).toBe(true);
  });
});

describe("R2 BlobPresigner", () => {
  test("creates a SigV4 PUT URL against the configured bucket", async () => {
    const signed = await Effect.runPromise(
      Effect.gen(function* () {
        const presigner = yield* BlobPresigner;
        return yield* presigner.presignPut({
          key: "avatars/user one.png",
          contentType: "image/png",
          expiresInSeconds: 900,
        });
      }).pipe(
        Effect.provide(R2BlobPresignerLive),
        Effect.provide(
          R2PresignerConfig.layer({
            accessKeyId: "access_key",
            secretAccessKey: Redacted.make("secret_key"),
            endpoint: "https://objects.example.test/storage/",
            bucket: "uploads",
            region: "us-east-1",
          }),
        ),
      ) as Effect.Effect<string>,
    );

    const url = new URL(signed);
    expect(url.origin).toBe("https://objects.example.test");
    expect(url.pathname).toBe("/storage/uploads/avatars/user%20one.png");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  const presignPut = (contentLength: number | undefined) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const presigner = yield* BlobPresigner;
        return yield* presigner.presignPut({
          key: "avatars/a.png",
          contentType: "image/png",
          expiresInSeconds: 900,
          contentLength,
        });
      }).pipe(
        Effect.provide(R2BlobPresignerLive),
        Effect.provide(
          R2PresignerConfig.layer({
            accessKeyId: "access_key",
            secretAccessKey: Redacted.make("secret_key"),
            endpoint: "https://objects.example.test/storage/",
            bucket: "uploads",
            region: "us-east-1",
          }),
        ),
        Effect.result,
      ),
    );

  test("signs the content length when one is given", async () => {
    const withLength = await presignPut(1234);
    const withoutLength = await presignPut(undefined);

    expect(Result.isSuccess(withLength) && Result.isSuccess(withoutLength)).toBe(true);

    if (Result.isSuccess(withLength) && Result.isSuccess(withoutLength)) {
      const signedHeaders = (signed: string) =>
        new URL(signed).searchParams.get("X-Amz-SignedHeaders")?.split(";");

      expect(signedHeaders(withLength.success)).toEqual(["content-length", "content-type", "host"]);
      expect(signedHeaders(withoutLength.success)).toEqual(["content-type", "host"]);
    }
  });

  test("rejects a content length that is not a non-negative integer", async () => {
    for (const contentLength of [-1, 1.5, Number.NaN]) {
      const result = await presignPut(contentLength);

      expect(Result.isFailure(result) && result.failure._tag).toBe("BlobPresignError");
    }
  });

  test("creates a SigV4 GET URL that does not sign a content type", async () => {
    const signed = await Effect.runPromise(
      Effect.gen(function* () {
        const presigner = yield* BlobPresigner;
        return yield* presigner.presignGet({
          key: "avatars/user one.png",
          expiresInSeconds: 900,
        });
      }).pipe(
        Effect.provide(R2BlobPresignerLive),
        Effect.provide(
          R2PresignerConfig.layer({
            accessKeyId: "access_key",
            secretAccessKey: Redacted.make("secret_key"),
            endpoint: "https://objects.example.test/storage/",
            bucket: "uploads",
            region: "us-east-1",
          }),
        ),
      ) as Effect.Effect<string>,
    );

    const url = new URL(signed);
    expect(url.pathname).toBe("/storage/uploads/avatars/user%20one.png");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).not.toContain("content-type");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });
});
