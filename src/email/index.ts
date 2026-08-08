export { EmailConfig } from "./config.ts";
export {
  EmailProviderError,
  EmailRenderError,
  EmailSendError,
  EmailSyncContactError,
} from "./errors.ts";
export { EmailProvider, ResendEmailProviderLive } from "./provider.ts";
export type { EmailProviderClient } from "./provider.ts";
export { EmailLive, EmailService } from "./service.ts";
export type { EmailContent, SendEmailInput, SyncContactInput } from "./service.ts";
