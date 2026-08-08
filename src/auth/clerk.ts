import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { Context, Data, Effect, Layer, Redacted } from "effect";

/** Configuration required to construct a Clerk SDK client. */
export type ClerkConfigOptions = {
  readonly secretKey: Redacted.Redacted<string>;
};

/** Provides the redacted credentials used by {@link ClerkClientLive}. */
export class ClerkConfig extends Context.Service<ClerkConfig, ClerkConfigOptions>()(
  "@ayronforge/haversack/auth/ClerkConfig",
) {
  /** Creates a Layer from explicit Clerk configuration. */
  static readonly layer = (options: ClerkConfigOptions): Layer.Layer<ClerkConfig> =>
    Layer.succeed(ClerkConfig, ClerkConfig.of(options));
}

/** Represents a failed Clerk client construction or SDK operation. */
export class ClerkError extends Data.TaggedError("ClerkError")<{
  readonly cause: unknown;
}> {}

/** Represents a failed Clerk webhook operation. */
export class ClerkWebhookError extends Data.TaggedError("ClerkWebhookError")<{
  readonly cause: unknown;
}> {}

/** The Clerk SDK capabilities exposed by this adapter. */
export type ClerkSdkClient = Pick<ReturnType<typeof createClerkClient>, "invitations" | "users">;

/**
 * Minimal verified Clerk webhook event shape.
 *
 * @template Data Event payload type.
 * @template Type Event discriminator type.
 */
export type ClerkWebhookEvent<Data = unknown, Type extends string = string> = {
  readonly type: Type;
  readonly data: Data;
  readonly event_attributes?: {
    readonly http_request?: {
      readonly client_ip?: string | null;
      readonly user_agent?: string | null;
    };
  };
};

type ClerkWebhookSdk = {
  readonly verifyWebhook: (request: Request) => Promise<ClerkWebhookEvent>;
};

/** Effect service that exposes the selected Clerk client and webhook SDK capabilities. */
export class ClerkClient extends Context.Service<
  ClerkClient,
  {
    readonly client: ClerkSdkClient;
    readonly use: <A>(fn: (client: ClerkSdkClient) => Promise<A>) => Effect.Effect<A, ClerkError>;
    readonly useWebhook: <A>(
      fn: (sdk: ClerkWebhookSdk) => Promise<A>,
    ) => Effect.Effect<A, ClerkWebhookError>;
  }
>()("@ayronforge/haversack/auth/ClerkClient") {}

/** Constructs a Clerk client from {@link ClerkConfig}. */
export const ClerkClientLive: Layer.Layer<ClerkClient, ClerkError, ClerkConfig> = Layer.effect(
  ClerkClient,
  Effect.gen(function* () {
    const config = yield* ClerkConfig;
    const client = yield* Effect.try({
      try: () => createClerkClient({ secretKey: Redacted.value(config.secretKey) }),
      catch: (cause) => new ClerkError({ cause }),
    });

    const use = <A>(fn: (client: ClerkSdkClient) => Promise<A>) =>
      Effect.tryPromise({
        try: () => fn(client),
        catch: (cause) => new ClerkError({ cause }),
      }).pipe(Effect.withSpan("clerk.use"));

    const useWebhook = <A>(fn: (sdk: ClerkWebhookSdk) => Promise<A>) =>
      Effect.tryPromise({
        try: () => fn({ verifyWebhook: (request) => verifyWebhook(request) }),
        catch: (cause) => new ClerkWebhookError({ cause }),
      }).pipe(Effect.withSpan("clerk.webhook"));

    return ClerkClient.of({ client, use, useWebhook });
  }),
);
