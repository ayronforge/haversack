import { Context, Data, type Effect, type Option } from "effect";

/** Body accepted by blob writes. */
export type BlobBody = string | Uint8Array | ReadableStream<Uint8Array>;

/** A stored object returned by reads. */
export type BlobObject = {
  readonly body: Uint8Array;
  readonly contentType?: string | undefined;
};

export type BlobWriteOptions = {
  readonly contentType?: string | undefined;
};

export type BlobListOptions = {
  readonly prefix?: string | undefined;
  readonly limit?: number | undefined;
};

/** Failure of a blob storage operation, tagged with the operation that failed. */
export class BlobStorageError extends Data.TaggedError("BlobStorageError")<{
  readonly operation: "put" | "get" | "delete" | "exists" | "list";
  readonly key?: string | undefined;
  readonly cause: unknown;
}> {}

/**
 * Minimal blob storage port. One instance is bound to one bucket — the bucket
 * is implementation configuration, not part of the contract.
 *
 * Implementations: `cf` (Cloudflare R2 binding), `aws` (S3 via signed fetch).
 */
export class BlobStorage extends Context.Service<
  BlobStorage,
  {
    readonly put: (
      key: string,
      body: BlobBody,
      options?: BlobWriteOptions,
    ) => Effect.Effect<void, BlobStorageError>;
    readonly get: (key: string) => Effect.Effect<Option.Option<BlobObject>, BlobStorageError>;
    readonly delete: (key: string) => Effect.Effect<void, BlobStorageError>;
    readonly exists: (key: string) => Effect.Effect<boolean, BlobStorageError>;
    /** Lists object keys, optionally under a prefix. */
    readonly list: (
      options?: BlobListOptions,
    ) => Effect.Effect<ReadonlyArray<string>, BlobStorageError>;
  }
>()("@ayronforge/haversack/contracts/BlobStorage") {}

/** Failure while producing a presigned URL. */
export class BlobPresignError extends Data.TaggedError("BlobPresignError")<{
  readonly key: string;
  readonly cause: unknown;
}> {}

export type BlobPresignPutInput = {
  readonly key: string;
  readonly contentType: string;
  readonly expiresInSeconds: number;
};

/**
 * Presigned-URL port for direct client uploads. Separate from `BlobStorage`
 * because presigning needs credentials while data-plane bindings do not.
 */
export class BlobPresigner extends Context.Service<
  BlobPresigner,
  {
    readonly presignPut: (input: BlobPresignPutInput) => Effect.Effect<string, BlobPresignError>;
  }
>()("@ayronforge/haversack/contracts/BlobPresigner") {}
