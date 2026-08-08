import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import parsePhoneNumberFromString from "libphonenumber-js/min";

const PhoneParts = Schema.Struct({
  number: Schema.String,
  countryCode: Schema.String,
  nationalNumber: Schema.String,
  e164: Schema.String,
  international: Schema.String,
  national: Schema.String,
});

/**
 * Parses an international phone number string into its structured parts via
 * libphonenumber-js. Encodes back to E.164.
 */
export const Phone = Schema.String.pipe(
  Schema.decodeTo(PhoneParts, {
    decode: SchemaGetter.transformOrFail((input: string) => {
      const parsed = parsePhoneNumberFromString(input);
      if (!parsed?.isValid()) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: "Invalid phone number" }, Option.some(input)),
        );
      }
      return Effect.succeed({
        number: parsed.number,
        countryCode: parsed.countryCallingCode,
        nationalNumber: parsed.nationalNumber,
        e164: parsed.format("E.164"),
        international: parsed.format("INTERNATIONAL"),
        national: parsed.format("NATIONAL"),
      });
    }),
    encode: SchemaGetter.transform((parts) => parts.e164),
  }),
);
export type Phone = typeof Phone.Type;
