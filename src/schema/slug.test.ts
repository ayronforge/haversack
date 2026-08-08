import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { Slug, SlugFromString } from "./slug.ts";

const decode = (input: string) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(SlugFromString)(input) as Effect.Effect<string, unknown>,
  );

describe("SlugFromString", () => {
  test("slugifies accented text", () => {
    expect(decode("Café com Leite!")).toBe("cafe-com-leite");
  });
  test("collapses separators", () => {
    expect(decode("  My   Great---Site ")).toBe("my-great-site");
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
