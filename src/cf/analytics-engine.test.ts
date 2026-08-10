import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted, Schema } from "effect";

import { AnalyticsEngine, AnalyticsEngineConfig } from "./analytics-engine.ts";

const configured = AnalyticsEngine.layer.pipe(
  Layer.provide(
    AnalyticsEngineConfig.layer({
      accountId: "account_123",
      apiToken: Redacted.make("secret_token"),
    }),
  ),
);

const withFetch = async <A>(fake: typeof fetch, run: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const query = (sql: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const analytics = yield* AnalyticsEngine;
      return yield* analytics.query(
        sql,
        Schema.Struct({ count: Schema.Number, name: Schema.String }),
      );
    }).pipe(Effect.provide(configured)),
  );

describe("AnalyticsEngine", () => {
  test("posts SQL and decodes rows with the supplied schema", async () => {
    const requests: Array<{ readonly body: string; readonly url: string }> = [];
    const rows = await withFetch(
      (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ body: String(init?.body), url: String(input) });
        return Response.json({ data: [{ count: 3, name: "signup" }] });
      }) as typeof fetch,
      () => query("SELECT count, name FROM events"),
    );

    expect(rows).toEqual([{ count: 3, name: "signup" }]);
    expect(requests).toEqual([
      {
        body: "SELECT count, name FROM events",
        url: "https://api.cloudflare.com/client/v4/accounts/account_123/analytics_engine/sql",
      },
    ]);
  });

  test("returns a typed response failure without inferring response semantics", async () => {
    const error = await withFetch(
      (async () => new Response("Unknown table events", { status: 404 })) as typeof fetch,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const analytics = yield* AnalyticsEngine;
            return yield* Effect.flip(
              analytics.query(
                "SELECT count, name FROM events",
                Schema.Struct({ count: Schema.Number, name: Schema.String }),
              ),
            );
          }).pipe(Effect.provide(configured)),
        ),
    );

    expect(error._tag).toBe("AnalyticsEngineQueryError");
    expect(error.operation).toBe("response");
    expect(error.status).toBe(404);
    expect(error.detail).toBe("Unknown table events");
  });

  test("rejects rows that do not match the supplied schema", async () => {
    const error = await withFetch(
      (async () => Response.json({ data: [{ count: "three", name: "signup" }] })) as typeof fetch,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const analytics = yield* AnalyticsEngine;
            return yield* Effect.flip(
              analytics.query(
                "SELECT bad",
                Schema.Struct({ count: Schema.Number, name: Schema.String }),
              ),
            );
          }).pipe(Effect.provide(configured)),
        ),
    );

    expect(error._tag).toBe("AnalyticsEngineQueryError");
    expect(error.operation).toBe("rows");
  });
});
