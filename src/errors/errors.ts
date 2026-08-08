import { Data } from "effect";

/**
 * Failure of an SDK call wrapped by a provider service (Stripe, Resend, Clerk, ...).
 * `operation` identifies which call failed and doubles as span/error metadata.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string;
  readonly operation?: string | undefined;
  readonly cause: unknown;
}> {}

/**
 * Failure of a plain HTTP integration (fetch-based clients without an SDK).
 */
export class IntegrationError extends Data.TaggedError("IntegrationError")<{
  readonly integration: string;
  readonly reason: string;
  readonly status?: number | undefined;
}> {}
