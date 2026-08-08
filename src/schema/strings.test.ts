import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { EmailAddress, EndpointUrl, NonEmptyTrimmedString, Uuid } from "./index.ts";

const decode = <S extends Schema.Top>(schema: S, input: S["Encoded"]): S["Type"] =>
  Effect.runSync(Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<S["Type"], unknown>);

const decodeFails = <S extends Schema.Top>(schema: S, input: unknown): boolean => {
  try {
    Effect.runSync(Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<unknown, unknown>);
    return false;
  } catch {
    return true;
  }
};

describe("NonEmptyTrimmedString", () => {
  test("trims", () => {
    expect(decode(NonEmptyTrimmedString, "  hi  ")).toBe("hi");
  });
  test("rejects blank", () => {
    expect(decodeFails(NonEmptyTrimmedString, "   ")).toBe(true);
  });
});

describe("EndpointUrl", () => {
  test("normalizes trailing slash", () => {
    expect(decode(EndpointUrl, "https://api.example.com/")).toBe("https://api.example.com");
  });
  test("keeps path", () => {
    expect(decode(EndpointUrl, "https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });
  test("rejects query strings", () => {
    expect(decodeFails(EndpointUrl, "https://api.example.com/?x=1")).toBe(true);
  });
  test("rejects non-http protocols", () => {
    expect(decodeFails(EndpointUrl, "ftp://example.com")).toBe(true);
  });
});

describe("EmailAddress", () => {
  test("trims and lowercases", () => {
    expect(decode(EmailAddress, "  User@Example.COM ")).toBe("user@example.com");
  });
  test("rejects invalid", () => {
    expect(decodeFails(EmailAddress, "not-an-email")).toBe(true);
  });
});

describe("Uuid", () => {
  test("accepts uuid", () => {
    expect(decode(Uuid, "0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10")).toBe(
      "0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10",
    );
  });
  test("rejects garbage", () => {
    expect(decodeFails(Uuid, "nope")).toBe(true);
  });
});
