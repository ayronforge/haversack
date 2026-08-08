import { describe, expect, test } from "bun:test";

import { WorkOS } from "@workos-inc/node";
import { Effect, Layer, Redacted } from "effect";

import { testStub } from "../testing/test-stub.ts";
import { WorkosClient, WorkosClientLive, WorkosConfig, WorkosError } from "./workos.ts";

// SAFETY: Operations in these tests only compare the injected value by identity;
// no WorkOS SDK members are read from this deliberately minimal fake.
const fakeClient = testStub<WorkOS>({ kind: "fake-workos" });

const fakeWorkosLayer = Layer.succeed(
  WorkosClient,
  WorkosClient.of({
    client: fakeClient,
    use: (fn) =>
      Effect.tryPromise({
        try: () => fn(fakeClient),
        catch: (cause) => new WorkosError({ cause }),
      }).pipe(Effect.withSpan("workos.use")),
  }),
);

describe("WorkosClient", () => {
  test("uses an SDK client injected through a test Layer", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const workos = yield* WorkosClient;
        return yield* workos.use(async (client) => client === fakeClient);
      }).pipe(Effect.provide(fakeWorkosLayer)),
    );

    expect(result).toBe(true);
  });

  test("maps rejected SDK operations to WorkosError", async () => {
    const cause = new Error("WorkOS unavailable");
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const workos = yield* WorkosClient;
        return yield* workos.use(() => Promise.reject(cause));
      }).pipe(Effect.provide(fakeWorkosLayer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkosError);
    expect(error.cause).toBe(cause);
  });

  test("live Layer constructs the SDK client from redacted config", async () => {
    const config = WorkosConfig.layer({
      apiKey: Redacted.make("sk_test"),
      clientId: "client_test",
    });
    const client = await Effect.runPromise(
      Effect.gen(function* () {
        const workos = yield* WorkosClient;
        return workos.client;
      }).pipe(Effect.provide(WorkosClientLive.pipe(Layer.provide(config)))),
    );

    expect(client).toBeInstanceOf(WorkOS);
    expect(client.clientId).toBe("client_test");
  });
});
