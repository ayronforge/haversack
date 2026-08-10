import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

const AnalyticsResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
});

/** Configuration required by the Workers Analytics Engine SQL API. */
export type AnalyticsEngineConfigOptions = {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted<string>;
};

/** Analytics Engine SQL API configuration service. */
export class AnalyticsEngineConfig extends Context.Service<
  AnalyticsEngineConfig,
  AnalyticsEngineConfigOptions
>()("@ayronforge/haversack/cf/AnalyticsEngineConfig") {
  /** Provides explicit account and redacted token configuration. */
  static layer(options: AnalyticsEngineConfigOptions): Layer.Layer<AnalyticsEngineConfig> {
    return Layer.succeed(AnalyticsEngineConfig, AnalyticsEngineConfig.of(options));
  }
}

/** Expected query, transport, response, or row-decoding failure. */
export class AnalyticsEngineQueryError extends Data.TaggedError("AnalyticsEngineQueryError")<{
  readonly cause?: unknown | undefined;
  readonly detail?: string | undefined;
  readonly operation: "fetch" | "response" | "rows";
  readonly status?: number | undefined;
}> {}

/**
 * Classifies a Cloudflare SQL response as a missing-dataset failure for the
 * caller-supplied dataset. Query execution itself remains strict so an
 * unrelated table typo cannot silently become an empty result.
 */
export function isAnalyticsEngineDatasetMissing(
  error: AnalyticsEngineQueryError,
  expectedDataset: string,
): boolean {
  if (error.operation !== "response" || error.status === undefined) return false;
  if (error.status < 400 || error.status >= 500) return false;

  const dataset = expectedDataset.trim().toLowerCase();
  if (!dataset) return false;

  const detail = error.detail?.toLowerCase();
  if (!detail || !containsIdentifier(detail, dataset)) return false;

  return (
    detail.includes("does not exist") ||
    detail.includes("doesn't exist") ||
    detail.includes("unknown table") ||
    detail.includes("no such table")
  );
}

/** Schema-decoding SQL client for Workers Analytics Engine. */
export class AnalyticsEngine extends Context.Service<
  AnalyticsEngine,
  {
    readonly query: <A, E>(
      sql: string,
      rowSchema: Schema.Codec<A, E>,
    ) => Effect.Effect<ReadonlyArray<A>, AnalyticsEngineQueryError>;
  }
>()("@ayronforge/haversack/cf/AnalyticsEngine") {
  /** Builds the SQL client from `AnalyticsEngineConfig`. */
  static readonly layer: Layer.Layer<AnalyticsEngine, never, AnalyticsEngineConfig> = Layer.effect(
    AnalyticsEngine,
    Effect.gen(function* () {
      const config = yield* AnalyticsEngineConfig;
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/analytics_engine/sql`;

      const query = <A, E>(sql: string, rowSchema: Schema.Codec<A, E>) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(endpoint, {
                body: sql,
                headers: { Authorization: `Bearer ${Redacted.value(config.apiToken)}` },
                method: "POST",
              }),
            catch: (cause) => new AnalyticsEngineQueryError({ cause, operation: "fetch" }),
          });

          if (!response.ok) {
            const detail = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: (cause) =>
                new AnalyticsEngineQueryError({
                  cause,
                  operation: "response",
                  status: response.status,
                }),
            });

            return yield* new AnalyticsEngineQueryError({
              detail: detail.slice(0, 512),
              operation: "response",
              status: response.status,
            });
          }

          const rawPayload = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) =>
              new AnalyticsEngineQueryError({
                cause,
                operation: "response",
                status: response.status,
              }),
          });
          const payload = yield* Schema.decodeUnknownEffect(AnalyticsResponseSchema)(
            rawPayload,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AnalyticsEngineQueryError({
                  cause,
                  operation: "response",
                  status: response.status,
                }),
            ),
          );

          return yield* Schema.decodeUnknownEffect(Schema.Array(rowSchema))(
            payload.data ?? [],
          ).pipe(
            Effect.mapError((cause) => new AnalyticsEngineQueryError({ cause, operation: "rows" })),
          );
        });

      return AnalyticsEngine.of({ query });
    }),
  );
}

function containsIdentifier(detail: string, identifier: string): boolean {
  let offset = detail.indexOf(identifier);
  while (offset !== -1) {
    const before = detail[offset - 1];
    const after = detail[offset + identifier.length];
    const isIdentifierCharacter = (character: string | undefined) =>
      character !== undefined && /[a-z0-9_]/.test(character);
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true;
    offset = detail.indexOf(identifier, offset + identifier.length);
  }
  return false;
}
