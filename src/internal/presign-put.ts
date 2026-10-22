import type { BlobPresignPutInput } from "../contracts/blob-storage.ts";

/**
 * Builds the PUT request a presigner signs. When `contentLength` is set it is
 * signed too, so the storage rejects uploads whose body has any other length.
 */
export function presignPutRequest(url: URL, input: BlobPresignPutInput): Request {
  const { contentLength } = input;

  if (contentLength !== undefined && !(Number.isSafeInteger(contentLength) && contentLength >= 0)) {
    throw new RangeError(`contentLength must be a non-negative safe integer, got ${contentLength}`);
  }

  url.searchParams.set("X-Amz-Expires", String(input.expiresInSeconds));

  const headers = new Headers({ "Content-Type": input.contentType });

  if (contentLength !== undefined) headers.set("Content-Length", String(contentLength));

  return new Request(url, { headers, method: "PUT" });
}
