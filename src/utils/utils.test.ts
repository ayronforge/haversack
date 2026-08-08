import { describe, expect, test } from "bun:test";

import {
  base64UrlDecode,
  base64UrlEncode,
  chunk,
  extractUnknownFields,
  levenshteinDistance,
  normalizeText,
  removeDiacritics,
  sha256Hex,
  splitFullName,
  stripWrappingMarkdownCodeFence,
  truncateText,
} from "./index.ts";

describe("encoding", () => {
  test("base64url roundtrip", () => {
    expect(base64UrlDecode(base64UrlEncode("hello world?"))).toBe("hello world?");
  });
});

describe("sha256Hex", () => {
  test("known digest", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("strings", () => {
  test("normalizeText collapses whitespace", () => {
    expect(normalizeText("  a \n b  ")).toBe("a b");
  });
  test("removeDiacritics", () => {
    expect(removeDiacritics("São Paulo")).toBe("sao paulo");
  });
  test("truncateText", () => {
    expect(truncateText("abcdefghij", 8)).toBe("abcde...");
    expect(truncateText("short", 10)).toBe("short");
  });
  test("stripWrappingMarkdownCodeFence", () => {
    expect(stripWrappingMarkdownCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripWrappingMarkdownCodeFence("plain")).toBe("plain");
  });
  test("levenshtein", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("same", "same")).toBe(0);
  });
});

describe("misc", () => {
  test("chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  test("splitFullName", () => {
    expect(splitFullName("Ada Lovelace King")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace King",
    });
    expect(splitFullName("  ")).toEqual({ firstName: undefined, lastName: undefined });
  });
  test("extractUnknownFields", () => {
    expect(
      extractUnknownFields(
        { status: 404, message: "x", extra: true },
        {
          status: "number",
          message: "string",
          missing: "string",
        },
      ),
    ).toEqual({ status: 404, message: "x" });
  });
});
