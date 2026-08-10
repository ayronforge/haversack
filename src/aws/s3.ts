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
import { encodeObjectKey } from "../utils/url.ts";

/** Credentials and target bucket for the S3 REST API. */
export type S3ConfigOptions = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly sessionToken?: Redacted.Redacted<string> | undefined;
  readonly bucket: string;
  readonly region: string;
  /** Override for S3-compatible endpoints (MinIO, R2's S3 API, ...). Defaults to AWS. */
  readonly endpoint?: string | URL | undefined;
  /** Automatic retries on 5xx responses (aws4fetch). Defaults to the library's 10. */
  readonly retries?: number | undefined;
};

export class S3Config extends Context.Service<S3Config, S3ConfigOptions>()(
  "@ayronforge/haversack/aws/S3Config",
) {
  /** Provides explicit credentials and bucket configuration. */
  static layer(options: S3ConfigOptions): Layer.Layer<S3Config> {
    return Layer.succeed(S3Config, S3Config.of(options));
  }
}

type S3Context = {
  readonly client: AwsClient;
  readonly objectUrl: (key: string) => URL;
  readonly bucketUrl: () => URL;
};

const makeS3Context = (config: S3ConfigOptions): S3Context => {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: Redacted.value(config.secretAccessKey),
    service: "s3",
    ...(config.retries === undefined ? {} : { retries: config.retries }),
    ...(config.sessionToken === undefined
      ? {}
      : { sessionToken: Redacted.value(config.sessionToken) }),
  });

  const base = () => {
    if (config.endpoint !== undefined) {
      const url = new URL(config.endpoint);
      const basePath = url.pathname.replace(/\/+$/, "");
      url.pathname = `${basePath}/${encodeURIComponent(config.bucket)}`;
      return url;
    }
    return new URL(`https://${config.bucket}.s3.${config.region}.amazonaws.com`);
  };

  return {
    client,
    bucketUrl: base,
    objectUrl: (key: string) => {
      const url = base();
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeObjectKey(key)}`;
      return url;
    },
  };
};

/** `BlobStorage` implementation over the S3 REST API via SigV4-signed fetch. */
export const S3BlobStorageLive: Layer.Layer<BlobStorage, never, S3Config> = Layer.effect(
  BlobStorage,
  Effect.gen(function* () {
    const config = yield* S3Config;
    const s3 = makeS3Context(config);

    const signedFetch = (
      operation: "put" | "get" | "delete" | "exists" | "list",
      key: string | undefined,
      url: URL,
      init: RequestInit,
    ) =>
      Effect.tryPromise({
        try: async () => s3.client.fetch(url.toString(), init),
        catch: (cause) => new BlobStorageError({ operation, key, cause }),
      }).pipe(Effect.withSpan(`s3.${operation}`));

    const failStatus = (
      operation: "put" | "get" | "delete" | "exists" | "list",
      key: string | undefined,
      response: Response,
    ) =>
      new BlobStorageError({
        operation,
        key,
        cause: new Error(`S3 returned ${response.status}`),
      });

    return BlobStorage.of({
      put: (key: string, body: BlobBody, options?: BlobWriteOptions) =>
        Effect.gen(function* () {
          const response = yield* signedFetch("put", key, s3.objectUrl(key), {
            method: "PUT",
            // SAFETY: aws4fetch accepts string | BufferSource | ReadableStream bodies.
            body: body as BodyInit,
            ...(options?.contentType ? { headers: { "Content-Type": options.contentType } } : {}),
          });
          if (!response.ok) return yield* failStatus("put", key, response);
        }),
      get: (key: string, options?: BlobReadOptions) =>
        Effect.gen(function* () {
          const response = yield* signedFetch("get", key, s3.objectUrl(key), { method: "GET" });
          if (response.status === 404) return Option.none();
          if (!response.ok) return yield* failStatus("get", key, response);

          const contentLength = readContentLength(response);
          if (
            options?.maxBytes !== undefined &&
            contentLength !== undefined &&
            contentLength > options.maxBytes
          ) {
            yield* Effect.promise(async () => {
              try {
                await response.body?.cancel();
              } catch {
                // The size limit remains the meaningful failure even if the
                // runtime cannot cancel an already-open response body.
              }
            });
            return yield* new BlobReadLimitExceeded({
              key,
              maxBytes: options.maxBytes,
              actualBytes: contentLength,
            });
          }

          const body = yield* Effect.tryPromise({
            try: () => readResponseBody(response, key, options?.maxBytes),
            catch: (cause) =>
              cause instanceof BlobReadLimitExceeded
                ? cause
                : new BlobStorageError({ operation: "get", key, cause }),
          });
          return Option.some({
            body,
            contentType: response.headers.get("content-type") ?? undefined,
          });
        }),
      delete: (key: string) =>
        Effect.gen(function* () {
          const response = yield* signedFetch("delete", key, s3.objectUrl(key), {
            method: "DELETE",
          });
          // S3 DELETE is idempotent: 204 for both existing and missing keys.
          if (!response.ok && response.status !== 404) {
            return yield* failStatus("delete", key, response);
          }
        }),
      exists: (key: string) =>
        Effect.gen(function* () {
          const response = yield* signedFetch("exists", key, s3.objectUrl(key), {
            method: "HEAD",
          });
          if (response.status === 404) return false;
          if (!response.ok) return yield* failStatus("exists", key, response);
          return true;
        }),
      list: (options?: BlobListOptions) =>
        Effect.gen(function* () {
          const url = s3.bucketUrl();
          url.searchParams.set("list-type", "2");
          if (options?.prefix !== undefined) url.searchParams.set("prefix", options.prefix);
          if (options?.limit !== undefined) {
            url.searchParams.set("max-keys", String(options.limit));
          }

          const response = yield* signedFetch("list", undefined, url, { method: "GET" });
          if (!response.ok) return yield* failStatus("list", undefined, response);

          const xml = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: (cause) => new BlobStorageError({ operation: "list", cause }),
          });
          return listKeysFromXml(xml);
        }),
    });
  }),
);

/** `BlobPresigner` implementation using SigV4 query signing (no network requests). */
export const S3BlobPresignerLive: Layer.Layer<BlobPresigner, never, S3Config> = Layer.effect(
  BlobPresigner,
  Effect.gen(function* () {
    const config = yield* S3Config;
    const s3 = makeS3Context(config);

    const presignPut = Effect.fn("BlobPresigner.presignPut")(function* (
      input: BlobPresignPutInput,
    ) {
      return yield* Effect.tryPromise({
        try: async () => {
          const url = s3.objectUrl(input.key);
          url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));
          const request = new Request(url, {
            headers: { "Content-Type": input.contentType },
            method: "PUT",
          });
          const signed = await s3.client.sign(request, {
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

/** Extracts `<Key>` values from a ListObjectsV2 response without an XML parser. */
function listKeysFromXml(xml: string): ReadonlyArray<string> {
  const keys: Array<string> = [];
  const pattern = /<Key>([^<]*)<\/Key>/g;
  for (const match of xml.matchAll(pattern)) {
    keys.push(decodeXmlEntities(match[1] ?? ""));
  }
  return keys;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function readContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;

  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

async function readResponseBody(
  response: Response,
  key: string,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value === undefined) continue;

      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The read-limit failure is the actionable result even if cancellation fails.
        }
        throw new BlobReadLimitExceeded({ key, maxBytes, actualBytes: totalBytes });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
