import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer } from "effect";

import { applyTestEnvDefaults, runWithService, testExecutionContext } from "./index.ts";

interface GreetingService {
  readonly greet: (name: string) => Effect.Effect<string>;
}

const GreetingService = Context.Service<GreetingService>("haversack/testing/GreetingService");
const greetingLayer = Layer.succeed(GreetingService, {
  greet: (name) => Effect.succeed(`Hello, ${name}!`),
});

describe("runWithService", () => {
  test("runs an effect with the service provided by the layer", async () => {
    const run = runWithService(GreetingService, greetingLayer);

    expect(await run((service) => service.greet("Ada"))).toBe("Hello, Ada!");
  });
});

describe("testExecutionContext", () => {
  test("collects and drains waitUntil promises", async () => {
    const executionContext = testExecutionContext();
    executionContext.waitUntil(Promise.resolve("first"));
    executionContext.waitUntil(Promise.resolve("second"));

    expect(executionContext.waitUntilPromises).toHaveLength(2);
    expect(await executionContext.drainWaitUntil()).toEqual(["first", "second"]);
  });
});

describe("applyTestEnvDefaults", () => {
  test("sets only missing variables and returns the resolved values", () => {
    const existingKey = "HAVERSACK_TEST_EXISTING";
    const missingKey = "HAVERSACK_TEST_MISSING";
    const previousExisting = process.env[existingKey];
    const previousMissing = process.env[missingKey];

    try {
      process.env[existingKey] = "existing";
      delete process.env[missingKey];

      expect(
        applyTestEnvDefaults({
          [existingKey]: "default-existing",
          [missingKey]: "default-missing",
        }),
      ).toEqual({
        [existingKey]: "existing",
        [missingKey]: "default-missing",
      });
      expect(process.env[existingKey]).toBe("existing");
      expect(process.env[missingKey]).toBe("default-missing");
    } finally {
      if (previousExisting === undefined) delete process.env[existingKey];
      else process.env[existingKey] = previousExisting;

      if (previousMissing === undefined) delete process.env[missingKey];
      else process.env[missingKey] = previousMissing;
    }
  });
});
