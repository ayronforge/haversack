import { Context, Layer, Redacted } from "effect";

const defaultHost = "https://us.i.posthog.com";

export type PostHogConfigOptions = {
  /** PostHog API host. Defaults to `https://us.i.posthog.com`. */
  readonly host?: string | undefined;
  /** Project token. When absent, capture and flag evaluation become no-ops. */
  readonly projectToken?: Redacted.Redacted<string> | undefined;
};

export class PostHogConfig extends Context.Service<
  PostHogConfig,
  {
    readonly host: string;
    readonly projectToken: Redacted.Redacted<string> | undefined;
  }
>()("@ayronforge/haversack/posthog/PostHogConfig") {
  static readonly layer = (options: PostHogConfigOptions = {}): Layer.Layer<PostHogConfig> => {
    const token =
      options.projectToken && Redacted.value(options.projectToken).trim()
        ? options.projectToken
        : undefined;
    return Layer.succeed(
      PostHogConfig,
      PostHogConfig.of({
        host: (options.host?.trim() || defaultHost).replace(/\/+$/, ""),
        projectToken: token,
      }),
    );
  };
}
