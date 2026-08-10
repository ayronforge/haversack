import type { R2Bucket } from "@cloudflare/workers-types";
import { AwsClient } from "aws4fetch";
import { Context, Effect, Layer, Option, Redacted } from "effect";

import {
  BlobPresignError,
  BlobPresigner,
  type BlobPresignPutInput,
  BlobReadLimitExceeded,
  type BlobReadOptions,
  BlobStorage,
  BlobStorageError,
  type BlobBody,
  type BlobListOptions,
  type BlobWriteOptions,
} from "../contracts/blob-storage.ts";
import { objectUrl } from "../utils/url.ts";

/**
 * `BlobStorage` implementation over a Cloudflare R2 bucket binding.
 * Data-plane only — no credentials involved.
 */
export function makeR2BlobStorageLayer(bucket: R2Bucket): Layer.Layer<BlobStorage> {
  const tryOperation = <A>(
    operation: "put" | "get" | "delete" | "exists" | "list",
    key: string | undefined,
    run: () => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new BlobStorageError({ operation, key, cause }),
    }).pipe(Effect.withSpan(`r2.${operation}`));

  return Layer.succeed(
    BlobStorage,
    BlobStorage.of({
      put: (key: string, body: BlobBody, options?: BlobWriteOptions) =>
        tryOperation("put", key, async () => {
          await bucket.put(
            key,
            // SAFETY: R2's ReadableStream type comes from workers-types and is
            // structurally identical to the DOM ReadableStream in this contract.
            body as Parameters<R2Bucket["put"]>[1],
            options?.contentType
              ? { httpMetadata: { contentType: options.contentType } }
              : undefined,
          );
        }),
      get: (key: string, options?: BlobReadOptions) =>
        Effect.gen(function* () {
          const object = yield* tryOperation("get", key, () => bucket.get(key));
          if (!object) return Option.none();

          if (options?.maxBytes !== undefined && object.size > options.maxBytes) {
            return yield* new BlobReadLimitExceeded({
              key,
              maxBytes: options.maxBytes,
              actualBytes: object.size,
            });
          }

          const body = yield* tryOperation(
            "get",
            key,
            async () => new Uint8Array(await object.arrayBuffer()),
          );
          return Option.some({
            body,
            contentType: object.httpMetadata?.contentType,
          });
        }),
      delete: (key: string) =>
        tryOperation("delete", key, async () => void (await bucket.delete(key))),
      exists: (key: string) =>
        tryOperation("exists", key, async () => (await bucket.head(key)) !== null),
      list: (options?: BlobListOptions) =>
        tryOperation("list", undefined, async () => {
          const result = await bucket.list({
            ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
            ...(options?.limit !== undefined ? { limit: options.limit } : {}),
          });
          return result.objects.map((object) => object.key);
        }),
    }),
  );
}

/** Credentials and endpoint for presigning against R2's S3-compatible API. */
export type R2PresignerConfigOptions = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly sessionToken?: Redacted.Redacted<string> | undefined;
  /** Base endpoint, for example `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string | URL;
  readonly bucket: string;
  /** Signing region. Cloudflare R2 uses `auto`. */
  readonly region?: string | undefined;
};

export class R2PresignerConfig extends Context.Service<
  R2PresignerConfig,
  R2PresignerConfigOptions
>()("@ayronforge/haversack/cf/R2PresignerConfig") {
  /** Provides explicit credentials and endpoint configuration. */
  static layer(options: R2PresignerConfigOptions): Layer.Layer<R2PresignerConfig> {
    return Layer.succeed(R2PresignerConfig, R2PresignerConfig.of(options));
  }
}

/** `BlobPresigner` implementation using SigV4 query signing (no network requests). */
export const R2BlobPresignerLive: Layer.Layer<BlobPresigner, never, R2PresignerConfig> =
  Layer.effect(
    BlobPresigner,
    Effect.gen(function* () {
      const config = yield* R2PresignerConfig;
      const client = new AwsClient({
        accessKeyId: config.accessKeyId,
        region: config.region ?? "auto",
        secretAccessKey: Redacted.value(config.secretAccessKey),
        service: "s3",
        ...(config.sessionToken === undefined
          ? {}
          : { sessionToken: Redacted.value(config.sessionToken) }),
      });

      const presignPut = Effect.fn("BlobPresigner.presignPut")(function* (
        input: BlobPresignPutInput,
      ) {
        return yield* Effect.tryPromise({
          try: async () => {
            const url = objectUrl(config.endpoint, config.bucket, input.key);
            url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));

            const request = new Request(url, {
              headers: { "Content-Type": input.contentType },
              method: "PUT",
            });
            const signed = await client.sign(request, {
              aws: { allHeaders: true, signQuery: true },
            });
            return signed.url;
          },
          catch: (cause) => new BlobPresignError({ key: input.key, cause }),
        });
      });

      return BlobPresigner.of({ presignPut });
    }),
  );
