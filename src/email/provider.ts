import { Context, Effect, Layer, Redacted } from "effect";
import { Resend } from "resend";

import { EmailConfig } from "./config.ts";
import { EmailProviderError } from "./errors.ts";

export type EmailProviderClient = Pick<Resend, "emails" | "contacts">;

export class EmailProvider extends Context.Service<
  EmailProvider,
  {
    readonly use: <A>(
      operation: (client: EmailProviderClient) => Promise<A>,
    ) => Effect.Effect<A, EmailProviderError>;
  }
>()("@ayronforge/haversack/email/EmailProvider") {}

export const ResendEmailProviderLive: Layer.Layer<EmailProvider, never, EmailConfig> = Layer.effect(
  EmailProvider,
  Effect.gen(function* () {
    const config = yield* EmailConfig;
    const client = new Resend(Redacted.value(config.apiKey));

    const use = <A>(operation: (client: EmailProviderClient) => Promise<A>) =>
      Effect.tryPromise({
        try: () => operation(client),
        catch: (cause) => new EmailProviderError({ cause }),
      }).pipe(Effect.withSpan("resend.use"));

    return EmailProvider.of({ use });
  }),
);
