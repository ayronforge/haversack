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

export type EmailAddressFromStringOptions = {
  /** Lowercase the local part for case-insensitive identity systems. */
  readonly lowercaseLocalPart?: boolean | undefined;
};

const emailLocalPartPattern = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const emailDomainLabelPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function isCanonicalEmailAddress(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const separator = value.indexOf("@");
  if (separator <= 0 || separator !== value.lastIndexOf("@")) return false;

  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    localPart.length > 64 ||
    !emailLocalPartPattern.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  const labels = domain.split(".");
  return (
    domain === domain.toLowerCase() &&
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.at(-1)!.length >= 2 &&
    labels.every((label) => label.length <= 63 && emailDomainLabelPattern.test(label))
  );
}

function normalizeEmailAddress(input: string, options: EmailAddressFromStringOptions): string {
  const value = input.trim();
  const separator = value.lastIndexOf("@");
  if (separator < 0) return value;
  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${options.lowercaseLocalPart ? localPart.toLowerCase() : localPart}@${domain.toLowerCase()}`;
}

/** A validated email address with a lowercase domain. */
export const EmailAddress = Schema.String.check(
  Schema.makeFilter<string>((value) => isCanonicalEmailAddress(value) || "Invalid email address."),
).pipe(Schema.brand("EmailAddress"));
export type EmailAddress = typeof EmailAddress.Type;

/** Parses free-form email input into a canonical email address. */
export const EmailAddressFromString = (options: EmailAddressFromStringOptions = {}) =>
  Schema.String.pipe(
    Schema.decodeTo(EmailAddress, {
      decode: SchemaGetter.transform((value: string) => normalizeEmailAddress(value, options)),
      encode: SchemaGetter.passthrough(),
    }),
  );
