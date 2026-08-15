import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import {
  EmailAddressFromString,
  EndpointUrl,
  EndpointUrlFromString,
  NonEmptyTrimmedString,
  Uuid,
  UuidFromString,
} from "./index.ts";

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
    expect(decode(EndpointUrlFromString, "https://api.example.com/")).toBe(
      "https://api.example.com",
    );
  });
  test("keeps path", () => {
    expect(decode(EndpointUrlFromString, "https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });
  test("encodes the canonical URL", () => {
    const endpoint = decode(EndpointUrlFromString, "https://api.example.com/");
    expect(Effect.runSync(Schema.encodeEffect(EndpointUrlFromString)(endpoint))).toBe(
      "https://api.example.com",
    );
  });
  test("requires canonical input at the domain boundary", () => {
    expect(decode(EndpointUrl, "https://api.example.com")).toBe("https://api.example.com");
    expect(decodeFails(EndpointUrl, "https://api.example.com/")).toBe(true);
  });
  test("rejects query strings", () => {
    expect(decodeFails(EndpointUrlFromString, "https://api.example.com/?x=1")).toBe(true);
  });
  test("rejects non-http protocols", () => {
    expect(decodeFails(EndpointUrlFromString, "ftp://example.com")).toBe(true);
  });
});

describe("EmailAddress", () => {
  test("trims input, preserves the local part, and lowercases the domain", () => {
    expect(decode(EmailAddressFromString(), "  User@Example.COM ")).toBe("User@example.com");
  });
  test("lowercases the local part only by explicit policy", () => {
    expect(
      decode(EmailAddressFromString({ lowercaseLocalPart: true }), "  User@Example.COM "),
    ).toBe("user@example.com");
  });
  test("encodes the canonical address", () => {
    const schema = EmailAddressFromString();
    const email = decode(schema, "User@Example.COM");
    expect(Effect.runSync(Schema.encodeEffect(schema)(email))).toBe("User@example.com");
  });
  test("rejects invalid", () => {
    const schema = EmailAddressFromString();
    expect(decodeFails(schema, "not-an-email")).toBe(true);
    expect(decodeFails(schema, ".user@example.com")).toBe(true);
    expect(decodeFails(schema, "user..name@example.com")).toBe(true);
    expect(decodeFails(schema, "user@localhost")).toBe(true);
    expect(decodeFails(schema, "user@-example.com")).toBe(true);
  });
});

describe("Uuid", () => {
  test("accepts canonical UUID input", () => {
    expect(decode(Uuid, "0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10")).toBe(
      "0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10",
    );
  });
  test("normalizes uppercase input and encodes canonical lowercase", () => {
    const uuid = decode(UuidFromString, "0198A3FC-9DB1-7BD5-8A1E-2F6A1F4C9D10");
    expect(uuid).toBe("0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10");
    expect(Effect.runSync(Schema.encodeEffect(UuidFromString)(uuid))).toBe(
      "0198a3fc-9db1-7bd5-8a1e-2f6a1f4c9d10",
    );
  });
  test("rejects non-canonical uppercase domain values", () => {
    expect(decodeFails(Uuid, "0198A3FC-9DB1-7BD5-8A1E-2F6A1F4C9D10")).toBe(true);
  });
  test("rejects GUID-shaped values with invalid UUID version or variant", () => {
    expect(decodeFails(UuidFromString, "0198a3fc-9db1-0bd5-8a1e-2f6a1f4c9d10")).toBe(true);
    expect(decodeFails(UuidFromString, "0198a3fc-9db1-7bd5-7a1e-2f6a1f4c9d10")).toBe(true);
  });
  test("rejects garbage", () => {
    expect(decodeFails(UuidFromString, "nope")).toBe(true);
  });
});
