import { WorkOS } from "@workos-inc/node";
import { Context, Data, Effect, Layer, Redacted } from "effect";

/** Configuration required to construct a WorkOS SDK client. */
export type WorkosConfigOptions = {
  readonly apiKey: Redacted.Redacted<string>;
  readonly clientId?: string | undefined;
};

/** Provides the redacted credentials used by {@link WorkosClientLive}. */
export class WorkosConfig extends Context.Service<WorkosConfig, WorkosConfigOptions>()(
  "@ayronforge/haversack/auth/WorkosConfig",
) {
  /** Creates a Layer from explicit WorkOS configuration. */
  static readonly layer = (options: WorkosConfigOptions): Layer.Layer<WorkosConfig> =>
    Layer.succeed(WorkosConfig, WorkosConfig.of(options));
}

/** Represents a failed WorkOS SDK operation. */
export class WorkosError extends Data.TaggedError("WorkosError")<{
  readonly cause: unknown;
}> {}

/** Effect service that exposes a WorkOS client and translates rejected SDK calls. */
export class WorkosClient extends Context.Service<
  WorkosClient,
  {
    readonly client: WorkOS;
    readonly use: <A>(fn: (client: WorkOS) => Promise<A>) => Effect.Effect<A, WorkosError>;
  }
>()("@ayronforge/haversack/auth/WorkosClient") {}

/** Constructs a WorkOS client from {@link WorkosConfig}. */
export const WorkosClientLive: Layer.Layer<WorkosClient, never, WorkosConfig> = Layer.effect(
  WorkosClient,
  Effect.gen(function* () {
    const config = yield* WorkosConfig;
    const client = new WorkOS(
      Redacted.value(config.apiKey),
      config.clientId === undefined ? {} : { clientId: config.clientId },
    );

    const use = <A>(fn: (client: WorkOS) => Promise<A>) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: (cause) => new WorkosError({ cause }),
      }).pipe(Effect.withSpan("workos.use"));

    return WorkosClient.of({ client, use });
  }),
);
