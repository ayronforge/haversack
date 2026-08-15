import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import {
  formatPhoneNumber,
  inspectPhoneNumber,
  maskPhoneInput,
  PhoneNumberFromString,
} from "./phone.ts";

describe("PhoneNumber", () => {
  test("parses a valid BR number into canonical E.164", () => {
    const phone = Effect.runSync(
      Schema.decodeUnknownEffect(PhoneNumberFromString())("+55 11 98765-4321"),
    );
    expect(phone).toBe("+5511987654321");
    expect(inspectPhoneNumber(phone).countryCode).toBe("55");
  });

  test("encodes canonical E.164", () => {
    const schema = PhoneNumberFromString();
    const phone = Effect.runSync(Schema.decodeUnknownEffect(schema)("+1 415 555 2671"));
    const encoded = Effect.runSync(Schema.encodeEffect(schema)(phone));
    expect(encoded).toBe("+14155552671");
  });

  test("requires an explicit default country for national input", () => {
    expect(() =>
      Effect.runSync(Schema.decodeUnknownEffect(PhoneNumberFromString())("(11) 98765-4321")),
    ).toThrow();
    expect(
      Effect.runSync(
        Schema.decodeUnknownEffect(PhoneNumberFromString({ defaultCountry: "BR" }))(
          "(11) 98765-4321",
        ),
      ),
    ).toBe("+5511987654321");
  });

  test("formats canonical values separately from storage", () => {
    const phone = Effect.runSync(
      Schema.decodeUnknownEffect(PhoneNumberFromString())("+55 11 98765-4321"),
    );
    expect(formatPhoneNumber(phone, "national")).toBe("(11) 98765-4321");
    expect(formatPhoneNumber(phone, "international")).toBe("+55 11 98765 4321");
    expect(maskPhoneInput("11987654321", { defaultCountry: "BR" })).toBe("(11) 98765-4321");
  });

  test("rejects invalid numbers", () => {
    expect(() =>
      Effect.runSync(Schema.decodeUnknownEffect(PhoneNumberFromString())("123")),
    ).toThrow();
  });
});
