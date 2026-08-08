import { hexEncode } from "./encoding.ts";

/** SHA-256 of a UTF-8 string, hex-encoded. Uses WebCrypto (works in any modern runtime). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hexEncode(new Uint8Array(digest));
}
