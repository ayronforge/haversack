import { describe, expect, test } from "bun:test";

import { errorMessage, normalizeError } from "./index.ts";

describe("errorMessage", () => {
  test("uses Error message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("passes strings through", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  test("reads message field from objects", () => {
    expect(errorMessage({ message: "object failure" })).toBe("object failure");
  });

  test("stringifies other values", () => {
    expect(errorMessage({ status: 500 })).toBe('{"status":500}');
  });

  test("falls back to String for circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
  });
});

describe("normalizeError", () => {
  test("returns Error instances unchanged", () => {
    const error = new Error("boom");
    expect(normalizeError(error)).toBe(error);
  });

  test("wraps non-errors preserving cause", () => {
    const normalized = normalizeError("boom");
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toBe("boom");
    expect(normalized.cause).toBe("boom");
  });
});
