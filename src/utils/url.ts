/** Percent-encodes an object key per path segment, preserving `/` separators. */
export function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Builds the URL of `bucket/key` under a base endpoint, dropping any query
 * string or fragment. Used for S3-compatible path-style object addressing.
 */
export function objectUrl(endpoint: string | URL, bucket: string, key: string): URL {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
  url.search = "";
  url.hash = "";
  return url;
}
