export type {
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
} from "@porchfest/core";

export { NoneEmailAdapter } from "./none.js";
export {
  DEFAULT_SMTP_TIMEOUT_MS,
  SmtpEmailAdapter,
  buildMimeMessage,
  encodeQuotedPrintable,
  type MimeMessageInput,
  type SmtpEmailAdapterOptions,
} from "./smtp.js";
