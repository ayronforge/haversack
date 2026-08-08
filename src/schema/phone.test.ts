import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { Phone } from "./phone.ts";

describe("Phone", () => {
  test("parses a valid BR number", () => {
    const parts = Effect.runSync(Schema.decodeUnknownEffect(Phone)("+55 11 98765-4321"));
    expect(parts.e164).toBe("+5511987654321");
    expect(parts.countryCode).toBe("55");
  });

  test("encodes back to e164", () => {
    const parts = Effect.runSync(Schema.decodeUnknownEffect(Phone)("+1 415 555 2671"));
    const encoded = Effect.runSync(Schema.encodeEffect(Phone)(parts));
    expect(encoded).toBe("+14155552671");
  });

  test("rejects invalid numbers", () => {
    expect(() => Effect.runSync(Schema.decodeUnknownEffect(Phone)("123"))).toThrow();
  });
});
