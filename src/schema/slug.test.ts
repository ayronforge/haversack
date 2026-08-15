import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { Slug, SlugFromString } from "./slug.ts";

const decode = (input: string): typeof Slug.Type =>
  Effect.runSync(
    Schema.decodeUnknownEffect(SlugFromString)(input) as Effect.Effect<typeof Slug.Type, unknown>,
  );

describe("SlugFromString", () => {
  test("slugifies accented text", () => {
    expect(decode("Café com Leite!")).toBe("cafe-com-leite");
  });
  test("collapses separators", () => {
    expect(decode("  My   Great---Site ")).toBe("my-great-site");
  });
  test("encodes the canonical slug", () => {
    const slug = decode("Café com Leite!");
    expect(Effect.runSync(Schema.encodeEffect(SlugFromString)(slug))).toBe("cafe-com-leite");
  });
  test("fails when result is too short", () => {
    expect(() => decode("a!")).toThrow();
  });
});

describe("Slug", () => {
  test("rejects edge hyphens", () => {
    expect(() =>
      Effect.runSync(Schema.decodeUnknownEffect(Slug)("-bad-") as Effect.Effect<string, unknown>),
    ).toThrow();
  });
});
