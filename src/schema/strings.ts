import { Effect, Option, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from "effect";

/** Trims the input and requires the result to be non-empty. */
export const NonEmptyTrimmedString = Schema.Trim.pipe(
  Schema.decodeTo(Schema.NonEmptyString, SchemaTransformation.passthrough()),
);

/** Trims the input and decodes it into a `URL`. */
export const TrimmedUrl = NonEmptyTrimmedString.pipe(
  Schema.decodeTo(Schema.URLFromString, SchemaTransformation.passthrough()),
);

type EndpointUrlParseResult =
  | { readonly _tag: "Success"; readonly value: string }
  | { readonly _tag: "Failure"; readonly message: string };

function parseEndpointUrl(input: string): EndpointUrlParseResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { _tag: "Failure", message: "Invalid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { _tag: "Failure", message: "URL must use http or https." };
  }
  if (url.search || url.hash) {
    return { _tag: "Failure", message: "URL must not include query string or fragment." };
  }

  return {
    _tag: "Success",
    value: `${url.origin}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/+$/, ""),
  };
}

/** A canonical http(s) endpoint base URL without trailing slashes, query, or fragment. */
export const EndpointUrl = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    const result = parseEndpointUrl(value);
    if (result._tag === "Failure") return result.message;
    return result.value === value || "Endpoint URL must be canonical.";
  }),
).pipe(Schema.brand("EndpointUrl"));
export type EndpointUrl = typeof EndpointUrl.Type;

/** Parses URL input into a canonical {@link EndpointUrl}. */
export const EndpointUrlFromString = Schema.String.pipe(
  Schema.decodeTo(EndpointUrl, {
    decode: SchemaGetter.transformOrFail((input: string) => {
      const result = parseEndpointUrl(input);
      if (result._tag === "Success") return Effect.succeed(result.value);
      return Effect.fail(new SchemaIssue.InvalidValue({ message: result.message }, Option.none()));
    }),
    encode: SchemaGetter.passthrough(),
  }),
);

/** A canonical lowercase UUID with valid version and RFC variant bits. */
export const Uuid = Schema.String.check(Schema.isUUID(), Schema.isLowercased()).pipe(
  Schema.brand("Uuid"),
);
export type Uuid = typeof Uuid.Type;

/** Parses UUID input into its canonical lowercase representation. */
export const UuidFromString = Schema.String.pipe(
  Schema.decodeTo(Uuid, {
    decode: SchemaGetter.transform((value: string) => value.toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);

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
