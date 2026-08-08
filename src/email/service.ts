import { Context, Effect, Layer } from "effect";
import type { ReactElement } from "react";

import { EmailConfig } from "./config.ts";
import { EmailRenderError, EmailSendError, EmailSyncContactError } from "./errors.ts";
import { EmailProvider, ResendEmailProviderLive } from "./provider.ts";

/** Email body: pre-rendered HTML, or a react-email element rendered at send time. */
export type EmailContent =
  | { readonly html: string; readonly react?: never }
  | { readonly react: ReactElement; readonly html?: never };

export type SendEmailInput = EmailContent & {
  readonly from?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly subject: string;
  readonly to: string | ReadonlyArray<string>;
};

export type SyncContactInput = {
  readonly email: string;
  readonly firstName?: string | undefined;
  readonly lastName?: string | null | undefined;
  /** Overrides `EmailConfig.segmentId`. */
  readonly segmentId?: string | undefined;
  /** Overrides `EmailConfig.topicId`. */
  readonly topicId?: string | undefined;
  /** Opt the contact into the topic. */
  readonly subscribe?: boolean | undefined;
};

export type SyncContactResult = {
  readonly contactId: string;
  readonly email: string;
  readonly segmentId: string | undefined;
  readonly topicId: string | undefined;
};

const recipientLabel = (to: string | ReadonlyArray<string>) =>
  typeof to === "string" ? to : to.join(",");

const renderContent = (content: EmailContent): Effect.Effect<string, EmailRenderError> => {
  if (content.html !== undefined) return Effect.succeed(content.html);
  return Effect.tryPromise({
    try: async () => {
      const { render } = await import("react-email");
      return render(content.react);
    },
    catch: (cause) => new EmailRenderError({ cause }),
  });
};

export class EmailService extends Context.Service<
  EmailService,
  {
    readonly send: (
      input: SendEmailInput,
    ) => Effect.Effect<{ readonly id: string }, EmailRenderError | EmailSendError>;
    readonly syncContact: (
      input: SyncContactInput,
    ) => Effect.Effect<SyncContactResult, EmailSyncContactError>;
  }
>()("@ayronforge/haversack/email/EmailService") {
  static readonly layer: Layer.Layer<EmailService, never, EmailConfig | EmailProvider> =
    Layer.effect(
      EmailService,
      Effect.gen(function* () {
        const config = yield* EmailConfig;
        const provider = yield* EmailProvider;

        const send = (input: SendEmailInput) =>
          Effect.gen(function* () {
            const html = yield* renderContent(input);
            const recipients = typeof input.to === "string" ? input.to : [...input.to];
            return yield* provider
              .use(async (resend) => {
                const { data, error } = await resend.emails.send(
                  {
                    from: input.from ?? config.from,
                    html,
                    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
                    subject: input.subject,
                    to: recipients,
                  },
                  input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
                );
                if (error) throw new Error(error.message);
                if (!data) throw new Error("Resend returned no data.");
                return { id: data.id };
              })
              .pipe(
                Effect.mapError(
                  (providerError) =>
                    new EmailSendError({
                      cause: providerError.cause,
                      to: recipientLabel(input.to),
                    }),
                ),
              );
          }).pipe(Effect.withSpan("email.send"));

        const syncContact = (input: SyncContactInput) =>
          Effect.gen(function* () {
            const email = input.email.trim().toLowerCase();
            const segmentId = input.segmentId ?? config.segmentId;
            const topicId = input.topicId ?? config.topicId;
            const subscribe = input.subscribe ?? false;

            const result = yield* provider.use(async (resend) => {
              const throwOnError = <A>(response: {
                data: A;
                error: { message: string } | null;
              }) => {
                if (response.error) throw new Error(response.error.message);
                return response.data;
              };

              const existing = await resend.contacts.get(email).then((response) => {
                if (response.error?.name === "not_found") return null;
                if (response.error) throw new Error(response.error.message);
                return response.data ? { id: response.data.id } : null;
              });

              if (!existing) {
                const created = throwOnError(
                  await resend.contacts.create({
                    email,
                    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
                    ...(input.lastName != null ? { lastName: input.lastName } : {}),
                    ...(segmentId ? { segments: [{ id: segmentId }] } : {}),
                    ...(topicId && subscribe
                      ? { topics: [{ id: topicId, subscription: "opt_in" as const }] }
                      : {}),
                    unsubscribed: false,
                  }),
                );
                if (!created) throw new Error("Resend returned no data.");
                return { contactId: created.id };
              }

              throwOnError(
                await resend.contacts.update({
                  email,
                  ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
                  ...(input.lastName !== undefined && input.lastName !== null
                    ? { lastName: input.lastName }
                    : {}),
                  ...(subscribe ? { unsubscribed: false } : {}),
                }),
              );

              if (segmentId) {
                const segments = throwOnError(
                  await resend.contacts.segments.list({ email, limit: 100 }),
                );
                const isMember =
                  segments?.data.some((segment) => segment.id === segmentId) ?? false;
                if (!isMember) {
                  throwOnError(await resend.contacts.segments.add({ email, segmentId }));
                }
              }

              if (topicId && subscribe) {
                const topics = throwOnError(
                  await resend.contacts.topics.list({ email, limit: 100 }),
                );
                const subscription =
                  topics?.data.find((topic) => topic.id === topicId)?.subscription ?? null;
                if (subscription !== "opt_in") {
                  throwOnError(
                    await resend.contacts.topics.update({
                      email,
                      topics: [{ id: topicId, subscription: "opt_in" }],
                    }),
                  );
                }
              }

              return { contactId: existing.id };
            });

            return {
              contactId: result.contactId,
              email,
              segmentId,
              topicId,
            } satisfies SyncContactResult;
          }).pipe(
            Effect.mapError((error) =>
              error instanceof EmailSyncContactError
                ? error
                : new EmailSyncContactError({ cause: error.cause, email: input.email }),
            ),
            Effect.withSpan("email.syncContact"),
          );

        return EmailService.of({ send, syncContact });
      }),
    );
}

/** EmailService wired to the Resend adapter. Still requires `EmailConfig`. */
export const EmailLive: Layer.Layer<EmailService, never, EmailConfig> = EmailService.layer.pipe(
  Layer.provide(ResendEmailProviderLive),
);
