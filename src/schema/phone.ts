import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { AsYouType, type CountryCode, parsePhoneNumberFromString } from "libphonenumber-js/min";

export type PhoneNumberFromStringOptions = {
  /** Country used only when the input has no explicit calling code. */
  readonly defaultCountry?: CountryCode | undefined;
};

export type PhoneNumberFormat = "e164" | "international" | "national";

export type PhoneNumberParts = {
  readonly countryCode: string;
  readonly nationalNumber: string;
  readonly e164: PhoneNumber;
  readonly international: string;
  readonly national: string;
};

const parseValidPhone = (input: string, defaultCountry?: CountryCode) => {
  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  return parsed?.isValid() ? parsed : undefined;
};

/** A valid phone number in canonical E.164 form. */
export const PhoneNumber = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    const parsed = parseValidPhone(value);
    return parsed?.number === value || "Phone number must be valid canonical E.164.";
  }),
).pipe(Schema.brand("PhoneNumber"));
export type PhoneNumber = typeof PhoneNumber.Type;

/**
 * Builds a schema that parses free-form phone input into canonical E.164.
 * A default country must be supplied explicitly for national input.
 */
export const PhoneNumberFromString = (options: PhoneNumberFromStringOptions = {}) =>
  Schema.String.pipe(
    Schema.decodeTo(PhoneNumber, {
      decode: SchemaGetter.transformOrFail((input: string) => {
        const parsed = parseValidPhone(input, options.defaultCountry);
        if (!parsed) {
          return Effect.fail(
            new SchemaIssue.InvalidValue({ message: "Invalid phone number" }, Option.none()),
          );
        }
        return Effect.succeed(parsed.number);
      }),
      encode: SchemaGetter.passthrough(),
    }),
  );

/** Derives provider metadata and display formats from a canonical number. */
export function inspectPhoneNumber(phone: PhoneNumber): PhoneNumberParts {
  const parsed = parseValidPhone(phone);
  if (!parsed) throw new Error("PhoneNumber invariant violated.");
  return {
    countryCode: parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
    e164: phone,
    international: parsed.format("INTERNATIONAL"),
    national: parsed.format("NATIONAL"),
  };
}

/** Formats a canonical number without changing its stored representation. */
export function formatPhoneNumber(
  phone: PhoneNumber,
  format: PhoneNumberFormat = "international",
): string {
  const parts = inspectPhoneNumber(phone);
  if (format === "e164") return parts.e164;
  return format === "national" ? parts.national : parts.international;
}

/** Formats incomplete user input incrementally for a specific country policy. */
export function maskPhoneInput(input: string, options: PhoneNumberFromStringOptions = {}): string {
  return new AsYouType(options.defaultCountry).input(input) || input;
}
