import { Schema, SchemaGetter, SchemaTransformation } from "effect";

/** Trims the input and requires the result to be non-empty. */
export const NonEmptyTrimmedString = Schema.Trim.pipe(
  Schema.decodeTo(Schema.NonEmptyString, SchemaTransformation.passthrough()),
);

/** Trims the input and decodes it into a `URL`. */
export const TrimmedUrl = NonEmptyTrimmedString.pipe(
  Schema.decodeTo(Schema.URLFromString, SchemaTransformation.passthrough()),
);

/**
 * An http(s) endpoint base URL, normalized to a string without trailing
 * slashes. Rejects URLs carrying a query string or fragment.
 */
export const EndpointUrl = Schema.URLFromString.check(
  Schema.makeFilter<URL>((url) => {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "URL must use http or https.";
    }
    if (url.search || url.hash) {
      return "URL must not include query string or fragment.";
    }
    return true;
  }),
).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((url: URL) =>
      `${url.origin}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/+$/, ""),
    ),
    encode: SchemaGetter.transform((url: string) => new URL(url)),
  }),
);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID string (any version). */
export const Uuid = Schema.String.check(Schema.isPattern(uuidPattern));

const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** An email address, trimmed and lowercased on decode. */
export const EmailAddress = Schema.String.pipe(
  Schema.decodeTo(Schema.String.check(Schema.isPattern(emailPattern)), {
    decode: SchemaGetter.transform((value: string) => value.trim().toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);
