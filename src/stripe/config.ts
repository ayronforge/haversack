import { Context, Layer, type Redacted } from "effect";

export type StripeConfigOptions = {
  readonly secretKey: Redacted.Redacted<string>;
  readonly webhookSecret?: Redacted.Redacted<string> | undefined;
  readonly apiVersion?: string | undefined;
};

export class StripeConfig extends Context.Service<StripeConfig, StripeConfigOptions>()(
  "@ayronforge/haversack/stripe/StripeConfig",
) {
  static readonly layer = (options: StripeConfigOptions): Layer.Layer<StripeConfig> =>
    Layer.succeed(StripeConfig, StripeConfig.of(options));
}
