import { Context, Layer, type Redacted } from "effect";

export type EmailConfigOptions = {
  readonly apiKey: Redacted.Redacted<string>;
  /** Default sender, e.g. `"Acme <noreply@acme.com>"`. */
  readonly from: string;
  /** Default Resend segment for `syncContact`. */
  readonly segmentId?: string | undefined;
  /** Default Resend topic for `syncContact`. */
  readonly topicId?: string | undefined;
};

export class EmailConfig extends Context.Service<EmailConfig, EmailConfigOptions>()(
  "@ayronforge/haversack/email/EmailConfig",
) {
  static readonly layer = (options: EmailConfigOptions): Layer.Layer<EmailConfig> =>
    Layer.succeed(EmailConfig, EmailConfig.of(options));
}
