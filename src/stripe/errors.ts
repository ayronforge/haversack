import { Data } from "effect";

import type { StripeClientOperationName } from "./service.ts";

/** A rejected Stripe SDK request with safe operation metadata. */
export class StripeClientError extends Data.TaggedError("StripeClientError")<{
  readonly cause: unknown;
  readonly operation: StripeClientOperationName;
}> {}

/** Invalid or incomplete configuration for a Stripe operation. */
export class StripeConfigError extends Data.TaggedError("StripeConfigError")<{
  readonly message: string;
}> {}

/** A Stripe webhook signature verification failure. */
export class StripeWebhookError extends Data.TaggedError("StripeWebhookError")<{
  readonly cause: unknown;
}> {}
