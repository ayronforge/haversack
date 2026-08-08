import { Data } from "effect";

export class EmailProviderError extends Data.TaggedError("EmailProviderError")<{
  readonly cause: unknown;
}> {}

export class EmailRenderError extends Data.TaggedError("EmailRenderError")<{
  readonly cause: unknown;
}> {}

export class EmailSendError extends Data.TaggedError("EmailSendError")<{
  readonly cause: unknown;
  readonly to: string;
}> {}

export class EmailSyncContactError extends Data.TaggedError("EmailSyncContactError")<{
  readonly cause: unknown;
  readonly email: string;
}> {}
